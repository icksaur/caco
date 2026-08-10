/**
 * Soft-archive folder reaper (spec-soft-archive-folder).
 *
 * A session parked in the `auto-archive` folder that then sits quiescent past the
 * idle threshold is auto-archived via the existing reversible `archive()` — clearing
 * disowned herd children (and any parked session) out of the root list after a grace
 * window, without a hard delete.
 *
 * Split into a PURE eligibility predicate (`isAutoArchiveEligible`, no I/O — the
 * whole decision is unit-testable) and an impure sweep + timer that read live state.
 * The destructive work runs through `SessionManager.reapArchive`, which serializes
 * under the shared maintenance claim and re-checks eligibility under it, so a session
 * that goes live (or is re-acquired / rescued) after the scan is never archived.
 */

import { sessionManager } from './session-manager.js';
import { isHerdParent } from './herd.js';
import { listSessionIds } from './sdk-session-store.js';
import { getSessionMeta, updateSessionMeta, type SessionMeta } from './session-meta-store.js';
import {
  AUTO_ARCHIVE_FOLDER,
  AUTO_ARCHIVE_IDLE_MS,
  AUTO_ARCHIVE_SWEEP_INTERVAL_MS,
  AUTO_ARCHIVE_ENABLED,
} from './config.js';

/** Runtime facts about a session the pure predicate cannot read from meta. */
export interface ReaperFacts {
  /** A dispatch is in flight. */
  isBusy: boolean;
  /** Loaded in the active-session map. */
  isActive: boolean;
  /** A resume is in flight (invisible to isActive until the SDK load completes). */
  isResuming: boolean;
  /** Some session claims this one as its herd parent. */
  isParent: boolean;
}

/**
 * The quiescence anchor: the most recent of the park time and any activity, with a
 * creation-time floor. `null` when none is resolvable (⇒ not eligible, fail safe).
 */
export function archiveAnchorMs(meta: SessionMeta, creationMs: number | null): number | null {
  const candidates: number[] = [];
  if (typeof meta.autoArchiveTaggedAt === 'number') candidates.push(meta.autoArchiveTaggedAt);
  const used = meta.lastUsedAt ? Date.parse(meta.lastUsedAt) : NaN;
  if (!Number.isNaN(used)) candidates.push(used);
  const idle = meta.lastIdleAt ? Date.parse(meta.lastIdleAt) : NaN;
  if (!Number.isNaN(idle)) candidates.push(idle);
  if (creationMs !== null) candidates.push(creationMs);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

/**
 * Whether a session may be auto-archived NOW. Pure. Eligible iff parked in the
 * `auto-archive` folder, quiescent past the threshold, and not live or load-bearing
 * (not busy / active / resuming, not a herd parent, and not a herd child —
 * `orchestratedBy` set). Unknown age ⇒ not eligible.
 */
export function isAutoArchiveEligible(
  meta: SessionMeta,
  facts: ReaperFacts,
  now: number,
  creationMs: number | null,
  thresholdMs: number = AUTO_ARCHIVE_IDLE_MS,
): boolean {
  if (meta.folder !== AUTO_ARCHIVE_FOLDER) return false;
  if (facts.isBusy || facts.isActive || facts.isResuming) return false;
  if (facts.isParent) return false;
  if (meta.orchestratedBy) return false; // a herd child is load-bearing
  const anchor = archiveAnchorMs(meta, creationMs);
  if (anchor === null) return false;
  return now - anchor > thresholdMs;
}

/** Live eligibility for a session id (reads meta + runtime facts). */
function eligibleNow(sessionId: string): boolean {
  const meta = getSessionMeta(sessionId);
  if (!meta) return false;
  const facts: ReaperFacts = {
    isBusy: sessionManager.isBusy(sessionId),
    isActive: sessionManager.isActive(sessionId),
    isResuming: sessionManager.isResuming(sessionId),
    isParent: isHerdParent(sessionId),
  };
  // Creation floor is unnecessary in practice: both folder-entry paths stamp
  // autoArchiveTaggedAt, so the anchor is always resolvable. Pass null.
  return isAutoArchiveEligible(meta, facts, Date.now(), null);
}

/**
 * Why a staged session past its window is still not being archived, or null if
 * it is not in that state (spec-archive-staging).
 *
 * Overdue-but-ineligible is the exact signature of staged archival failing, and
 * today it produces no output at all — the sweep skips it in silence, which is
 * indistinguishable from working. Reporting is deliberately not archiving: each
 * guard exists for a reason, and the fix for a stuck session is to make it
 * quiescent, not to override the check.
 */
export function overdueReason(
  meta: SessionMeta,
  facts: ReaperFacts,
  now: number,
  thresholdMs: number = AUTO_ARCHIVE_IDLE_MS,
): string | null {
  if (meta.folder !== AUTO_ARCHIVE_FOLDER) return null;
  const anchor = archiveAnchorMs(meta, null);
  if (anchor === null) return 'no resolvable age';
  if (now - anchor <= thresholdMs) return null; // not overdue: nothing to report
  if (facts.isBusy) return 'busy';
  if (facts.isResuming) return 'resuming';
  if (facts.isActive) return 'still loaded (never released)';
  if (facts.isParent) return 'herd parent';
  if (meta.orchestratedBy) return 'herd child';
  return null; // overdue and eligible — the sweep will take it
}

/**
 * When a staged session becomes archivable, or null if it is not staged or has
 * no resolvable age (spec-archive-staging).
 *
 * Derived from the same anchor the reaper uses, so the countdown shown to the
 * user cannot disagree with the decision that actually archives — and it moves
 * when the session is used, which is the behaviour the anchor defines.
 */
export function archiveEligibleAt(sessionId: string): number | null {
  const meta = getSessionMeta(sessionId);
  if (!meta || meta.folder !== AUTO_ARCHIVE_FOLDER) return null;
  const anchor = archiveAnchorMs(meta, null);
  return anchor === null ? null : anchor + AUTO_ARCHIVE_IDLE_MS;
}

/** Sessions already reported stuck, so the warning fires once per condition. */
const reportedOverdue = new Map<string, string>();

/** Test seam: forget which sessions have been reported. */
export function resetOverdueReports(): void {
  reportedOverdue.clear();
}

function reportOverdue(sessionId: string): void {
  const meta = getSessionMeta(sessionId);
  if (!meta) return;
  const facts: ReaperFacts = {
    isBusy: sessionManager.isBusy(sessionId),
    isActive: sessionManager.isActive(sessionId),
    isResuming: sessionManager.isResuming(sessionId),
    isParent: isHerdParent(sessionId),
  };
  const reason = overdueReason(meta, facts, Date.now());
  if (!reason) { reportedOverdue.delete(sessionId); return; }
  if (reportedOverdue.get(sessionId) === reason) return; // already said, same reason
  reportedOverdue.set(sessionId, reason);
  console.warn(
    `[REAP] ${sessionId.slice(0, 8)} is staged and past its window but not archivable: ${reason}. `
    + 'It stays in the folder until that clears; move it out to cancel.',
  );
}

/**
 * One reaper pass: archive every eligible parked session. Best-effort — a failure
 * or a refusal on one id is logged/skipped, never aborts the sweep. Sequential so a
 * mass of eligible sessions can't monopolize the loop. Returns a small summary.
 */
export async function sweepAutoArchive(): Promise<{ scanned: number; archived: number }> {
  let scanned = 0;
  let archived = 0;
  const stillStaged = new Set<string>();
  for (const sessionId of listSessionIds()) {
    const meta = getSessionMeta(sessionId);
    if (!meta || meta.folder !== AUTO_ARCHIVE_FOLDER) continue; // cheap prefilter
    scanned++;
    stillStaged.add(sessionId);
    if (!eligibleNow(sessionId)) { reportOverdue(sessionId); continue; } // re-checked under the claim
    try {
      const result = await sessionManager.reapArchive(sessionId, () => eligibleNow(sessionId));
      if (result === 'archived') archived++;
    } catch (e) {
      console.warn(`[REAP] archive ${sessionId.slice(0, 8)} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  // Forget sessions that left the folder or ceased to exist. Without this the
  // report map grows for the life of the process, since a session that is
  // archived or deleted never comes back through reportOverdue to clear itself.
  for (const id of reportedOverdue.keys()) if (!stillStaged.has(id)) reportedOverdue.delete(id);
  if (archived > 0) console.log(`[REAP] auto-archived ${archived}/${scanned} parked session(s)`);
  return { scanned, archived };
}

export interface ReaperHandle { stop(): void; }

/** Outcome of a staging request (spec-archive-staging). */
export type StageResult =
  | { ok: true; stagedAt: number; eligibleAt: number; folder: string; released: boolean }
  | { ok: false; reason: 'busy' | 'unknown' };

/**
 * Stage a session for archival: park it in the staging folder and release it
 * (spec-archive-staging).
 *
 * The release is not an optimization. `isAutoArchiveEligible` refuses any
 * session in the active map, and eviction only runs when that map is over its
 * cap, so a session staged while loaded would sit in the folder forever without
 * it — the visible half of the operation succeeding while the archive silently
 * never happens. Releasing here rather than relaxing the reaper's `isActive`
 * guard keeps "loaded" and "quiescent" as separate questions: the guard is what
 * stops a live session being archived out from under a caller.
 *
 * The busy check is a UX guard, NOT a correctness guard: a dispatch can begin
 * between the check and the release. Correctness comes from downstream — the
 * reaper re-checks eligibility under its maintenance claim, so a session that
 * goes live is skipped rather than archived mid-turn. The check exists so the
 * common case (staging something that is obviously mid-reply) fails fast and
 * legibly instead of releasing a session about to produce output.
 *
 * Parks BEFORE releasing, so a crash between the two leaves an intact parked
 * session rather than a bare eviction with the user's intent lost.
 *
 * A failed release is reported, not rolled back (`released: false`). Parked-
 * but-loaded is the weaker outcome, not a broken one: the park is durable and
 * is what the caller asked for, the sweep announces the session as stuck, and
 * the active map is in-memory so a restart clears the condition on its own.
 * Undoing the park to report a clean failure would throw away the durable half
 * of the operation to tidy up the recoverable half.
 */
export async function stageForArchive(sessionId: string): Promise<StageResult> {
  if (sessionManager.isBusy(sessionId)) return { ok: false, reason: 'busy' };

  const stagedAt = Date.now();
  // Always a fresh stamp: re-staging restarts the window rather than inheriting
  // a partial one. (The folder PATCH route stamps only when absent, because an
  // unrelated PATCH naming the same folder must not silently extend the window.)
  const written = updateSessionMeta(sessionId, meta => {
    meta.folder = AUTO_ARCHIVE_FOLDER;
    meta.autoArchiveTaggedAt = stagedAt;
  });
  if (!written) return { ok: false, reason: 'unknown' };

  // Release so the reaper can ever see it. Idempotent: `stop` on a session that
  // is not loaded is a no-op, so staging an already-quiescent session is fine.
  let released = true;
  try {
    await sessionManager.stop(sessionId);
  } catch (e) {
    released = false;
    console.warn(
      `[STAGE] ${sessionId.slice(0, 8)} parked but not released: ${e instanceof Error ? e.message : e}. `
      + 'It will not be archived until it leaves the active map.',
    );
  }

  return { ok: true, stagedAt, eligibleAt: stagedAt + AUTO_ARCHIVE_IDLE_MS, folder: AUTO_ARCHIVE_FOLDER, released };
}

/**
 * Start the periodic reaper (mirrors the rotation sweeper). Off when
 * AUTO_ARCHIVE_ENABLED is false. The timer is unref'd so it never keeps the process
 * alive. Each tick runs a full sweep; the per-session claim guards correctness.
 */
export function startAutoArchiveReaper(opts: { intervalMs?: number } = {}): ReaperHandle {
  if (!AUTO_ARCHIVE_ENABLED) return { stop() { /* disabled */ } };
  const intervalMs = opts.intervalMs ?? AUTO_ARCHIVE_SWEEP_INTERVAL_MS;
  const timer = setInterval(() => { void sweepAutoArchive().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return { stop() { clearInterval(timer); } };
}
