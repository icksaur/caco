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
import { listSessionIds, readSessionHeadResult } from './sdk-session-store.js';
import { getSessionMeta, updateSessionMeta, type SessionMeta } from './session-meta-store.js';
import {
  AUTO_ARCHIVE_FOLDER,
  AUTO_ARCHIVE_IDLE_MS,
  AUTO_ARCHIVE_SWEEP_INTERVAL_MS,
  AUTO_ARCHIVE_ENABLED,
  AUTO_PARK_ENABLED,
  AUTO_PARK_ROOT_THRESHOLD,
  AUTO_PARK_IDLE_MS,
  AUTO_PARK_MAX_PER_TICK,
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
 * =============================================================================
 * Auto-park (spec-auto-park-idle-root).
 *
 * A fourth entry path into the auto-archive folder: sweep every root session
 * (folder unset) that has sat untouched past AUTO_PARK_IDLE_MS, but ONLY when
 * the root population is at or above AUTO_PARK_ROOT_THRESHOLD. Both conditions
 * are required — thirty fresh root sessions is a busy week, three ancient ones
 * is what a folder is for. The pass runs before the reaper's own scan in the
 * same tick.
 * =============================================================================
 */

/**
 * Auto-park's quiescence anchor. Distinct from `archiveAnchorMs`: it drops the
 * park stamp (root sessions cannot carry it) and adds `movedToRootAt`, so a
 * session the user recently dragged to root is not immediately re-parked
 * (spec-auto-park-idle-root, "movedToRootAt is a new meta field").
 */
export function rootAnchorMs(meta: SessionMeta, creationMs: number | null): number | null {
  const candidates: number[] = [];
  if (typeof meta.movedToRootAt === 'number') candidates.push(meta.movedToRootAt);
  const used = meta.lastUsedAt ? Date.parse(meta.lastUsedAt) : NaN;
  if (!Number.isNaN(used)) candidates.push(used);
  const idle = meta.lastIdleAt ? Date.parse(meta.lastIdleAt) : NaN;
  if (!Number.isNaN(idle)) candidates.push(idle);
  if (creationMs !== null) candidates.push(creationMs);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

/** A session's inputs to `pickAutoParkCandidates`, one entry per known session. */
export interface AutoParkEntry {
  id: string;
  meta: SessionMeta;
  facts: ReaperFacts;
  /** Fallback age source when the meta carries no activity stamps at all. */
  creationMs: number | null;
}

/**
 * First-match precedence order for the summary log's skip buckets. Encoded as a
 * const array so mutation-testing a reordering (or a missing bucket) shows up
 * in one place.
 */
export type AutoParkSkipReason =
  | 'busy'
  | 'active'
  | 'resuming'
  | 'herd'
  | 'scheduled'
  | 'maintenance'
  | 'metadata'
  | 'stale';

export const AUTO_PARK_SKIP_ORDER: readonly AutoParkSkipReason[] = [
  'busy', 'active', 'resuming', 'herd', 'scheduled', 'maintenance', 'metadata', 'stale',
];

export interface AutoParkStats {
  root: number;
  stale: number;
  skipped: Record<AutoParkSkipReason, number>;
}

function emptySkipped(): Record<AutoParkSkipReason, number> {
  return { busy: 0, active: 0, resuming: 0, herd: 0, scheduled: 0, maintenance: 0, metadata: 0, stale: 0 };
}

export interface PickResult {
  /** Ids to park, in ascending anchor order with id tie-break. Empty when either
   *  gate fails. */
  candidates: string[];
  stats: AutoParkStats;
}

/**
 * Pure predicate: given every known session's meta + runtime facts, return the
 * ids to park.
 *
 * Gates: root population >= `thresholdRoot` AND at least one root session has an
 * anchor older than `idleMs`. If either gate fails the returned candidates are
 * empty and stats are still populated (so a caller can inspect why).
 *
 * Candidate selection uses SCAN-TIME facts for the runtime guards
 * (busy/active/resuming/parent). The write helper (`parkForAutoPark`) rechecks
 * the DURABLE meta conditions (folder, orchestratedBy, kind) inside its
 * `updateSessionMeta` callback because those represent user/system intent and
 * losing them silently would violate an invariant; runtime facts flip too
 * rapidly for a scan-then-write pipeline and the reaper's downstream recheck
 * provides the correctness (spec-auto-park-idle-root, "Guard evaluation happens
 * twice").
 *
 * Candidates are sorted by ASCENDING anchor with id tie-break so the sweep
 * loop's per-tick cap parks the oldest first — the rest wait for the next
 * tick, and aging cannot make a session drop out of the set.
 */
export function pickAutoParkCandidates(
  sessions: readonly AutoParkEntry[],
  thresholdRoot: number,
  idleMs: number,
  now: number,
): PickResult {
  const stats: AutoParkStats = { root: 0, stale: 0, skipped: emptySkipped() };
  const candidates: Array<{ id: string; anchor: number }> = [];

  for (const { id, meta, facts, creationMs } of sessions) {
    // Root filter — anything the user placed in a folder (including auto-archive)
    // is out of scope for auto-park. The normalize logic is centralised at the
    // folder PATCH route; here we treat empty/undefined as root.
    const isRoot = !meta.folder;
    if (!isRoot) continue;
    stats.root++;

    const anchor = rootAnchorMs(meta, creationMs);
    if (anchor === null) continue; // unresolvable age ⇒ fail safe, don't touch
    const age = now - anchor;
    if (age <= idleMs) continue; // fresh — not a candidate

    stats.stale++;

    // First-match precedence: exclude the session under exactly one bucket.
    if (facts.isBusy) { stats.skipped.busy++; continue; }
    if (facts.isActive) { stats.skipped.active++; continue; }
    if (facts.isResuming) { stats.skipped.resuming++; continue; }
    if (facts.isParent || meta.orchestratedBy) { stats.skipped.herd++; continue; }
    if (meta.kind === 'scheduled') { stats.skipped.scheduled++; continue; }

    candidates.push({ id, anchor });
  }

  // Gates: BOTH must pass before returning any candidates.
  if (stats.root < thresholdRoot || stats.stale === 0) {
    return { candidates: [], stats };
  }

  candidates.sort((a, b) => a.anchor - b.anchor || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { candidates: candidates.map(c => c.id), stats };
}

/**
 * Impure park helper. Refuses under a maintenance claim, refuses on missing /
 * corrupt / exception-throwing meta, and rechecks the three durable conditions
 * inside the write callback (spec-auto-park-idle-root, "Parking goes through a
 * maintenance-aware helper").
 *
 * Returns exactly one of:
 * - 'ok' — folder + tag were written
 * - 'maintenance' — session is under a claim; write skipped
 * - 'metadata' — updateSessionMeta returned false (missing / corrupt) OR
 *                setSessionMeta threw a filesystem error
 * - 'stale' — write-time recheck saw the session had changed since scan
 *             (folder no longer root, or orchestratedBy was set, or
 *             kind became 'scheduled')
 *
 * The 'metadata' bucket is deliberately coarse: distinguishing missing vs
 * corrupt vs filesystem error in the summary line would add noise without
 * operational value — the corrective action is the same (the session is
 * inaccessible and nothing else can act on it either).
 */
export function parkForAutoPark(id: string, now: number): AutoParkSkipReason | 'ok' {
  if (sessionManager.isUnderMaintenance(id)) return 'maintenance';

  let staleObserved = false;
  let written: boolean;
  try {
    written = updateSessionMeta(
      id,
      meta => {
        // Durable rechecks — the writer sees the current on-disk meta, so we can
        // detect state changes between scan and write for exactly the conditions
        // whose loss would violate an invariant (spec-auto-park-idle-root,
        // "Durable meta conditions are rechecked inside the write").
        if (meta.folder) { staleObserved = true; return; }
        if (meta.orchestratedBy) { staleObserved = true; return; }
        if (meta.kind === 'scheduled') { staleObserved = true; return; }
        meta.folder = AUTO_ARCHIVE_FOLDER;
        meta.autoArchiveTaggedAt = now;
      },
      // Auto-park must never revive a session with no meta — createIfMissing:false
      // makes updateSessionMeta return false for a missing meta rather than
      // creating a blank one and parking a phantom session.
      { createIfMissing: false },
    );
  } catch (e) {
    console.warn(`[AUTO-PARK] ${id.slice(0, 8)} meta write threw: ${e instanceof Error ? e.message : e}`);
    return 'metadata';
  }
  if (staleObserved) return 'stale';
  if (!written) return 'metadata';
  return 'ok';
}

/**
 * First-event timestamp of a session, in epoch ms, or null when unreadable /
 * unparseable / absent. The auto-park anchor's creation fallback: only consulted
 * for sessions that have no `movedToRootAt`, no `lastUsedAt`, and no
 * `lastIdleAt`, so the vast majority of candidates never touch it.
 */
function readCreationMs(id: string): number | null {
  const head = readSessionHeadResult(id);
  if (!head.ok) return null;
  const ts = head.value.start?.timestamp;
  if (typeof ts !== 'string') return null;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Build the auto-park input for one session, or null if it has no readable meta
 *  OR the session is not at the root (foldered sessions can never be auto-park
 *  candidates, so we skip both the runtime-fact resolution and the events-file
 *  head read that would resolve creationMs). This keeps auto-park's per-tick
 *  cost proportional to root population, not total sessions
 *  (spec-auto-park-idle-root, "The lookup is performed once per root candidate
 *  during the scan"). */
function buildEntry(id: string): AutoParkEntry | null {
  const meta = getSessionMeta(id);
  if (!meta) return null;
  // Root prefilter — foldered sessions (including 'auto-archive') cannot be
  // auto-park candidates. Skip them before touching sessionManager or reading
  // events.jsonl for the creation fallback.
  if (meta.folder) return null;
  const facts: ReaperFacts = {
    isBusy: sessionManager.isBusy(id),
    isActive: sessionManager.isActive(id),
    isResuming: sessionManager.isResuming(id),
    isParent: isHerdParent(id),
  };
  // Only resolve creationMs when no other anchor source is present. Cheap
  // for hot sessions with lastUsedAt; the bounded head read runs only for the
  // rare no-activity-stamp case (spec-auto-park-idle-root, "Creation timestamp
  // source").
  const hasStamp =
    typeof meta.movedToRootAt === 'number'
    || (meta.lastUsedAt && !Number.isNaN(Date.parse(meta.lastUsedAt)))
    || (meta.lastIdleAt && !Number.isNaN(Date.parse(meta.lastIdleAt)));
  const creationMs = hasStamp ? null : readCreationMs(id);
  return { id, meta, facts, creationMs };
}

/** Format the summary line's skip block in the canonical order. */
function formatSkipped(skipped: Record<AutoParkSkipReason, number>): string {
  return AUTO_PARK_SKIP_ORDER.map(k => `${k}:${skipped[k]}`).join(', ');
}

export interface AutoParkSummary {
  root: number;
  stale: number;
  parked: number;
  skipped: Record<AutoParkSkipReason, number>;
  /** True when both gates passed (log emitted). False when the pass was a no-op. */
  ran: boolean;
}

/**
 * One auto-park pass. Kill-switch aware. Runs the predicate, applies the
 * per-tick cap, calls the helper per id, accumulates skip counters, and emits
 * the `[AUTO-PARK]` summary line iff both gates passed.
 *
 * `overrides` accepts explicit knobs so integration tests can run against a
 * threshold of 1 (or a small cap) without a module reload. The two kill
 * switches (`AUTO_ARCHIVE_ENABLED`, `AUTO_PARK_ENABLED`) are exposed
 * INDEPENDENTLY so a test can prove either alone shuts the pass down.
 * Production callers omit overrides and pick up the env-loaded config.
 */
export function runAutoPark(
  now: number = Date.now(),
  overrides: {
    autoArchiveEnabled?: boolean;
    autoParkEnabled?: boolean;
    thresholdRoot?: number;
    idleMs?: number;
    maxPerTick?: number;
  } = {},
): AutoParkSummary {
  const autoArchiveEnabled = overrides.autoArchiveEnabled ?? AUTO_ARCHIVE_ENABLED;
  const autoParkEnabled = overrides.autoParkEnabled ?? AUTO_PARK_ENABLED;
  const thresholdRoot = overrides.thresholdRoot ?? AUTO_PARK_ROOT_THRESHOLD;
  const idleMs = overrides.idleMs ?? AUTO_PARK_IDLE_MS;
  const maxPerTick = overrides.maxPerTick ?? AUTO_PARK_MAX_PER_TICK;

  if (!autoArchiveEnabled || !autoParkEnabled) {
    return { root: 0, stale: 0, parked: 0, skipped: emptySkipped(), ran: false };
  }

  const entries: AutoParkEntry[] = [];
  for (const id of listSessionIds()) {
    const entry = buildEntry(id);
    if (entry) entries.push(entry);
  }

  const { candidates, stats } = pickAutoParkCandidates(entries, thresholdRoot, idleMs, now);
  const gatesPassed = stats.root >= thresholdRoot && stats.stale >= 1;

  if (!gatesPassed) {
    return { root: stats.root, stale: stats.stale, parked: 0, skipped: stats.skipped, ran: false };
  }

  let parked = 0;
  const capped = candidates.slice(0, maxPerTick);
  for (const id of capped) {
    const result = parkForAutoPark(id, now);
    if (result === 'ok') { parked++; continue; }
    // The four non-ok outcomes are all named as skip reasons.
    stats.skipped[result]++;
  }

  console.log(
    `[AUTO-PARK] root=${stats.root} stale=${stats.stale} parked=${parked} `
    + `skipped={${formatSkipped(stats.skipped)}}`,
  );

  return { root: stats.root, stale: stats.stale, parked, skipped: stats.skipped, ran: true };
}

/**
 * =============================================================================
 * End auto-park block. Sweep composition follows.
 * =============================================================================
 */

/**
 * One reaper pass: archive every eligible parked session. Best-effort — a failure
 * or a refusal on one id is logged/skipped, never aborts the sweep. Sequential so a
 * mass of eligible sessions can't monopolize the loop. Returns a small summary.
 *
 * Auto-park runs first (spec-auto-park-idle-root): a root session that qualifies
 * is parked with `autoArchiveTaggedAt = now`, so the reaper's 3-day window has
 * not remotely expired and it cannot chain-archive in the same tick.
 *
 * `autoParkOverrides` is a test seam — production callers omit it. It lets an
 * integration test drive `sweepAutoArchive` against a small threshold without
 * re-loading the module.
 */
export async function sweepAutoArchive(
  autoParkOverrides: Parameters<typeof runAutoPark>[1] = {},
): Promise<{ scanned: number; archived: number; parked: number }> {
  const autoPark = runAutoPark(Date.now(), autoParkOverrides);
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
  return { scanned, archived, parked: autoPark.parked };
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
