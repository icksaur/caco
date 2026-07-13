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
import { getSessionMeta, type SessionMeta } from './session-meta-store.js';
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
 * One reaper pass: archive every eligible parked session. Best-effort — a failure
 * or a refusal on one id is logged/skipped, never aborts the sweep. Sequential so a
 * mass of eligible sessions can't monopolize the loop. Returns a small summary.
 */
export async function sweepAutoArchive(): Promise<{ scanned: number; archived: number }> {
  let scanned = 0;
  let archived = 0;
  for (const sessionId of listSessionIds()) {
    const meta = getSessionMeta(sessionId);
    if (!meta || meta.folder !== AUTO_ARCHIVE_FOLDER) continue; // cheap prefilter
    scanned++;
    if (!eligibleNow(sessionId)) continue; // scan-time prefilter (re-checked under the claim)
    try {
      const result = await sessionManager.reapArchive(sessionId, () => eligibleNow(sessionId));
      if (result === 'archived') archived++;
    } catch (e) {
      console.warn(`[REAP] archive ${sessionId.slice(0, 8)} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (archived > 0) console.log(`[REAP] auto-archived ${archived}/${scanned} parked session(s)`);
  return { scanned, archived };
}

export interface ReaperHandle { stop(): void; }

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
