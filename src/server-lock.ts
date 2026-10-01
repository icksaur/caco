/**
 * Single-instance lock: at most one Caco process owns the shared SDK session
 * state.
 *
 * WHY: two Caco processes on one machine both repair session files at
 * discovery, run the scheduler, and rotate histories, against the same
 * ~/.copilot/session-state. That is two writers on one events.jsonl, which
 * corrupts sessions. The lock sits beside that state rather than under
 * CACO_HOME, because processes with different homes still share it.
 *
 * Rejected: detecting another Caco by probing the port over HTTP. It misses a
 * Caco started on a different port, and a busy one can time out and look absent.
 *
 * The lock also records the bound URL and readiness, which the start and stop
 * scripts read to find and identify the running server.
 */
import {
  openSync, writeSync, fsyncSync, closeSync, readFileSync, statSync,
  unlinkSync, renameSync, writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { STATE_DIR } from './sdk-session-store.js';

export const SERVER_LOCK_PATH = join(dirname(STATE_DIR), 'caco-server.lock');
/** A lock younger than this that cannot be parsed is a holder mid-write, not debris. */
export const LOCK_PARSE_GRACE_MS = 10_000;
/** How long a restart child waits for its parent to exit and release the lock. */
export const HANDOFF_WAIT_MS = 15_000;
export const HANDOFF_POLL_MS = 200;
/** Present in every Caco server process's command line, so a reused pid is told apart. */
export const SERVER_ENTRY_MARKER = 'server.ts';

export interface ServerLockRecord {
  pid: number;
  startedAt: string;
  state: 'starting' | 'ready';
  url: string | null;
  port?: number;
}

/** Another live Caco owns the session state. */
export class ServerLockHeldError extends Error {
  constructor(readonly holder: ServerLockRecord | null, readonly lockPath: string) {
    super(holder
      ? `Caco is already running (pid ${holder.pid}${holder.url ? ` at ${holder.url}` : ', still starting'})`
      : 'Caco is already starting (its lock is being written)');
    this.name = 'ServerLockHeldError';
  }
}

export interface LockDeps {
  path: string;
  pid: number;
  isAlive: (pid: number) => boolean;
  /** The process's command line, or null where the platform can't tell cheaply. */
  commandLine: (pid: number) => string | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function commandLine(pid: number): string | null {
  if (process.platform !== 'linux') return null;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    return null;
  }
}

function resolveDeps(over: Partial<LockDeps>): LockDeps {
  return {
    path: SERVER_LOCK_PATH,
    pid: process.pid,
    isAlive,
    commandLine,
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
    ...over,
  };
}

interface Observed {
  raw: string;
  record: ServerLockRecord | null;
  mtimeMs: number;
}

function observe(path: string): Observed | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const mtimeMs = statSync(path).mtimeMs;
    let record: ServerLockRecord | null = null;
    try {
      const parsed = JSON.parse(raw) as Partial<ServerLockRecord>;
      if (typeof parsed?.pid === 'number') record = parsed as ServerLockRecord;
    } catch { /* unparsable: judged by age below */ }
    return { raw, record, mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * A live pid is the holder unless its command line positively shows another
 * program (pid reuse after a crash). Where the command line is unknown, a live
 * pid counts as held: reclaiming a busy Caco would start a second writer.
 */
function holderIsLive(pid: number, deps: LockDeps): boolean {
  if (!deps.isAlive(pid)) return false;
  const cmd = deps.commandLine(pid);
  return cmd === null || cmd.includes(SERVER_ENTRY_MARKER);
}

async function waitForExit(pid: number, deps: LockDeps): Promise<boolean> {
  const deadline = deps.now() + HANDOFF_WAIT_MS;
  while (holderIsLive(pid, deps)) {
    if (deps.now() >= deadline) return false;
    await deps.sleep(HANDOFF_POLL_MS);
  }
  return true;
}

function writeExclusive(path: string, record: ServerLockRecord): void {
  const fd = openSync(path, 'wx');
  try {
    writeSync(fd, JSON.stringify(record));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Sibling claim that serializes deleting a stale lock.
 *
 * WHY: judging a lock stale and deleting it are two steps. Without a claim, two
 * starters can both judge it stale; the first replaces it with its own live
 * lock, and the second then deletes that, so both believe they own the state.
 * A live lock can only be deleted by its owner's release, never here.
 */
export const RECLAIM_SUFFIX = '.reclaim';

/**
 * Take the reclaim claim, clearing one left by a process that died mid-reclaim.
 * False while another live process holds it.
 */
function takeReclaimClaim(deps: LockDeps): boolean {
  const claim = deps.path + RECLAIM_SUFFIX;
  for (let round = 0; round < 2; round++) {
    try {
      writeExclusive(claim, { pid: deps.pid, startedAt: new Date(deps.now()).toISOString(), state: 'starting', url: null });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const seen = observe(claim);
    if (!seen) continue;
    const abandoned = seen.record
      ? !deps.isAlive(seen.record.pid)
      : deps.now() - seen.mtimeMs >= LOCK_PARSE_GRACE_MS;
    if (!abandoned) return false;
    // A claim abandoned by a crash, raced by a second starter at the same
    // moment, is the one window left; it needs a crash mid-reclaim plus two
    // concurrent starts.
    try { unlinkSync(claim); } catch { /* another starter cleared it */ }
  }
  return false;
}

/**
 * Delete a lock judged stale, under the reclaim claim. False if another process
 * is reclaiming it now. A lock that changed since it was judged is left alone.
 */
function reclaimStale(deps: LockDeps, judged: Observed): boolean {
  if (!takeReclaimClaim(deps)) return false;
  try {
    const current = observe(deps.path);
    if (current && current.raw === judged.raw) {
      try { unlinkSync(deps.path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return true;
  } finally {
    try { unlinkSync(deps.path + RECLAIM_SUFFIX); } catch { /* already gone */ }
  }
}

/**
 * Take ownership of the session state, or throw `ServerLockHeldError`.
 *
 * CONTRACT: called before any initialization in `start()`. A process that
 * cannot take this lock must not repair, schedule, rotate, or spawn anything.
 */
export async function acquireServerLock(
  options: { handoffParentPid?: number },
  over: Partial<LockDeps> = {},
): Promise<void> {
  const deps = resolveDeps(over);
  const record: ServerLockRecord = { pid: deps.pid, startedAt: new Date(deps.now()).toISOString(), state: 'starting', url: null };

  // Two rounds: a stale lock is removed once, then creation is retried. Losing
  // the second race means another process took it first, so it is held.
  for (let round = 0; round < 2; round++) {
    try {
      writeExclusive(deps.path, record);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const seen = observe(deps.path);
    if (!seen) continue;
    const holder = seen.record;

    if (!holder) {
      if (deps.now() - seen.mtimeMs < LOCK_PARSE_GRACE_MS) throw new ServerLockHeldError(null, deps.path);
    } else if (holder.pid === options.handoffParentPid) {
      if (!(await waitForExit(holder.pid, deps))) throw new ServerLockHeldError(holder, deps.path);
    } else if (holderIsLive(holder.pid, deps)) {
      throw new ServerLockHeldError(holder, deps.path);
    }
    if (!reclaimStale(deps, seen)) throw new ServerLockHeldError(holder, deps.path);
  }
  throw new ServerLockHeldError(observe(deps.path)?.record ?? null, deps.path);
}

function ownLock(deps: LockDeps): ServerLockRecord | null {
  const seen = observe(deps.path);
  return seen?.record && seen.record.pid === deps.pid ? seen.record : null;
}

/** Record the bound address once listening. A lock this process no longer holds is left alone. */
export function markServerReady(url: string, port: number, over: Partial<LockDeps> = {}): void {
  const deps = resolveDeps(over);
  const mine = ownLock(deps);
  if (!mine) return;
  const tmp = `${deps.path}.${deps.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...mine, state: 'ready', url, port }));
  renameSync(tmp, deps.path);
}

/**
 * Release on exit.
 *
 * CONTRACT: unlinks only a lock that still names this process. A kill that
 * skips exit handlers leaves a stale lock, which the next start reclaims.
 */
export function releaseServerLock(over: Partial<LockDeps> = {}): void {
  const deps = resolveDeps(over);
  if (!ownLock(deps)) return;
  try { unlinkSync(deps.path); } catch { /* already gone */ }
}

/**
 * Exit status for a start refused because another Caco runs. Distinct from a
 * failure so a supervisor can be told not to restart on it (systemd
 * RestartPreventExitStatus), and the start scripts pass it through unchanged.
 */
export const EXIT_ALREADY_RUNNING = 3;

/** What to tell the user when another Caco already owns the session state. */
export function formatLockRefusal(error: ServerLockHeldError): string {
  const holder = error.holder;
  const lines = [holder?.url
    ? `Caco is already running at ${holder.url} (pid ${holder.pid}). Not starting a second instance.`
    : holder
      ? `Caco is already starting (pid ${holder.pid}). Not starting a second instance.`
      : 'Another Caco is writing its lock right now. Not starting a second instance.'];
  lines.push('Open that URL, or stop it first with stop.sh / stop.ps1.');
  lines.push(`If no Caco is actually running, the lock is stale; delete it: ${error.lockPath}`);
  return lines.join('\n');
}
