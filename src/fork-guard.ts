/**
 * Guards a session fork so it can never destroy the parent's history.
 *
 * WHY: the runtime's `sessions.fork` RPC copies the parent's events to the child
 * correctly, then REPLACES the parent's events.jsonl with a single fork marker.
 * The parent can then never resume ("First event must be session.start or
 * session.resume"). This module wraps the RPC: snapshot the parent, fork, and if
 * the parent came back damaged, put the snapshot back.
 *
 * Pure file logic over an injected state dir. The caller (SessionManager) owns
 * liveness and the maintenance claim; this module assumes the parent is stopped
 * and that nothing but the runtime's fork writes it while the claim is held.
 *
 * Rejected, so they are not re-litigated:
 *  - Rebuilding the parent from the child. A `toEventId` fork copies only a
 *    prefix, and the fork route dispatches into the child immediately.
 *  - Implementing fork in Caco. It would re-implement runtime internals (line-1
 *    event-id preservation, workspace.yaml fork_count, session.db) and drift.
 *  - Salvaging the runtime's parent-side marker onto the snapshot. It needs
 *    chaining rules and marker-shape trust to keep an event Caco never renders.
 *  - Verifying the restore in an isolated client, as rotation does. A restore is
 *    byte-identical to a file the runtime loaded before the fork.
 */
import {
  existsSync, statSync, copyFileSync, openSync, readSync, closeSync, fsyncSync,
  renameSync, unlinkSync, constants,
} from 'fs';
import { join } from 'path';
import { STATE_DIR } from './sdk-session-store.js';

/**
 * Sibling of events.jsonl holding the parent's pre-fork bytes.
 *
 * CONTRACT: created exclusively and never overwritten, since it may be the only
 * good copy of the history. Every state it can be left in is decided by
 * `reconcileFork`, which must run wherever `reconcileRotation` runs.
 */
export const PREFORK_SUFFIX = '.prefork';

/** Read window for the prefix comparison, so a large history is never loaded whole. */
export const COMPARE_CHUNK_BYTES = 1 << 20;

export type ReconcileForkStatus = 'clean' | 'committed-cleanup' | 'restored';

/** File operations, injectable so a failing rename or unlink can be tested. */
interface ForkGuardFs {
  stateDir: string;
  rename: (from: string, to: string) => void;
  unlink: (path: string) => void;
}

export interface ForkGuardDeps extends Partial<Omit<ForkGuardFs, 'stateDir'>> {
  stateDir: string;
  log: (message: string) => void;
}

/** A damaged parent could not be put back; its snapshot survives for reconcile. */
export class ForkRestoreError extends Error {}

function pathsFor(stateDir: string, sessionId: string): { dir: string; events: string; snapshot: string } {
  const dir = join(stateDir, sessionId);
  const events = join(dir, 'events.jsonl');
  return { dir, events, snapshot: events + PREFORK_SUFFIX };
}

function resolveFs(overrides: Partial<ForkGuardFs>): ForkGuardFs {
  return {
    stateDir: overrides.stateDir ?? STATE_DIR,
    rename: overrides.rename ?? renameSync,
    unlink: overrides.unlink ?? unlinkSync,
  };
}

function fsyncFile(path: string): void {
  // Opened for writing: Windows refuses to flush a read-only handle.
  const fd = openSync(path, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncDir(dir: string): void {
  // Makes the create/rename/unlink of a directory entry durable. Windows cannot
  // open a directory for fsync, so this is best-effort there.
  try {
    const fd = openSync(dir, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* platform rejects directory fsync */ }
}

function readFully(fd: number, buffer: Buffer, length: number, position: number): void {
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, position + done);
    if (n === 0) throw new Error('events.jsonl shrank during comparison');
    done += n;
  }
}

function isCompleteEvents(text: string): boolean {
  if (!text.endsWith('\n')) return false;
  const lines = text.slice(0, -1).split('\n');
  return lines.every(line => {
    if (!line) return false;
    try {
      const value: unknown = JSON.parse(line);
      return typeof value === 'object' && value !== null;
    } catch {
      return false;
    }
  });
}

/**
 * The intact rule. A parent is intact iff its events.jsonl begins with the
 * snapshot's exact bytes and anything after them is complete, parseable event
 * lines. So a correct fork (marker appended) is intact, and the truncating fork,
 * an in-place rewrite, and a torn append are all damaged.
 *
 * The tail is read whole: nothing but the runtime's fork writes the parent while
 * the claim is held, so it is only ever the fork marker.
 */
function isParentIntact(eventsPath: string, snapshotPath: string): boolean {
  if (!existsSync(eventsPath)) return false;
  const size = statSync(snapshotPath).size;
  const liveSize = statSync(eventsPath).size;
  if (liveSize < size) return false;

  const snapshotFd = openSync(snapshotPath, 'r');
  const liveFd = openSync(eventsPath, 'r');
  try {
    const expected = Buffer.alloc(Math.min(COMPARE_CHUNK_BYTES, size));
    const actual = Buffer.alloc(expected.length);
    for (let position = 0; position < size; position += COMPARE_CHUNK_BYTES) {
      const length = Math.min(COMPARE_CHUNK_BYTES, size - position);
      readFully(snapshotFd, expected, length, position);
      readFully(liveFd, actual, length, position);
      if (expected.compare(actual, 0, length, 0, length) !== 0) return false;
    }
    if (liveSize === size) return true;
    const tail = Buffer.alloc(liveSize - size);
    readFully(liveFd, tail, tail.length, size);
    return isCompleteEvents(tail.toString('utf8'));
  } finally {
    closeSync(snapshotFd);
    closeSync(liveFd);
  }
}

/**
 * Settle a pending snapshot, deciding purely from file state:
 *  - no snapshot: clean;
 *  - intact parent: drop the snapshot (crash before the RPC, or after a correct
 *    fork);
 *  - damaged or missing parent: rename the snapshot back over events.jsonl.
 *
 * A single rename makes the restore atomic, and it consumes the snapshot, so a
 * crash either side of it is decided correctly on the next call.
 */
export function reconcileFork(sessionId: string, overrides: Partial<ForkGuardFs> = {}): ReconcileForkStatus {
  const fs = resolveFs(overrides);
  const { dir, events, snapshot } = pathsFor(fs.stateDir, sessionId);
  if (!existsSync(snapshot)) return 'clean';

  if (isParentIntact(events, snapshot)) {
    // Best-effort: a surviving snapshot is re-reconciled next time, and
    // guardedFork refuses to fork while one exists.
    try { fs.unlink(snapshot); } catch { /* retried by the next reconcile */ }
    fsyncDir(dir);
    return 'committed-cleanup';
  }

  fs.rename(snapshot, events);
  fsyncDir(dir);
  return 'restored';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run a fork RPC without letting it destroy the parent's history.
 *
 * CONTRACT: on successful return, the parent's events.jsonl begins with
 * its exact pre-fork bytes. If a restore fails, the snapshot is kept durably and
 * a `ForkRestoreError` is thrown; reconcile retries it on the next resume.
 *
 * CONTRACT: on an intact parent this is a no-op beyond dropping its own
 * snapshot. It renames and rewrites nothing, so it stays correct once the
 * runtime stops truncating.
 *
 * CONTRACT: a restore is the snapshot byte-for-byte. Never synthesize or
 * salvage events here.
 */
export async function guardedFork<T>(parentId: string, fork: () => Promise<T>, deps: ForkGuardDeps): Promise<T> {
  const fs = { stateDir: deps.stateDir, rename: deps.rename, unlink: deps.unlink };
  const { dir, events, snapshot } = pathsFor(deps.stateDir, parentId);

  reconcileFork(parentId, fs);
  if (existsSync(snapshot)) {
    throw new Error(`Fork guard: a stale snapshot for ${parentId} could not be cleared; refusing to fork`);
  }

  // Throws before any fork when there is no history, and EXCL guarantees the
  // snapshot is never overwritten.
  copyFileSync(events, snapshot, constants.COPYFILE_EXCL);
  fsyncFile(snapshot);
  fsyncDir(dir);

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await fork() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const forkNote = outcome.ok ? 'The fork itself succeeded.' : `The fork also failed: ${describe(outcome.error)}`;

  // Only something outside the claim could remove the snapshot, and without it
  // a truncating fork is indistinguishable from a correct one. Fail loudly
  // rather than report success over history that may be gone.
  if (!existsSync(snapshot)) {
    throw new ForkRestoreError(`Fork guard lost its snapshot of ${parentId} during the fork, so the parent's history could not be verified. ${forkNote}`);
  }

  let status: ReconcileForkStatus;
  try {
    status = reconcileFork(parentId, fs);
  } catch (error) {
    throw new ForkRestoreError(
      `Fork guard could not restore ${parentId} (${describe(error)}); its pre-fork history is kept at ${snapshot} and is restored on the next resume. ${forkNote}`,
    );
  }

  if (status === 'restored') {
    deps.log(`[FORK] runtime rewrote parent ${parentId.slice(0, 8)} events.jsonl; restored its pre-fork history`);
  }

  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
