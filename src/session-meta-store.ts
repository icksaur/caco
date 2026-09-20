/**
 * Per-session metadata (~/.caco/sessions/<id>/meta.json) and the MRU session-order index.
 *
 * SessionMeta holds Caco-specific session state: custom name, kind, parent, last-idle/observed
 * timestamps, current intent + history, env hint, context map, model preference, folder
 * assignment, response options, active applet + params, and panel visibility.
 *
 * The SDK stores its own session data in ~/.copilot/session-state/<id>/; we keep our
 * metadata separate to avoid coupling with SDK internals.
 */

import { readFileSync, existsSync, copyFileSync, readdirSync, statSync, renameSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync } from 'fs';
import { join } from 'path';
import { STORAGE_ROOT, getSessionDir, ensureDir } from './storage-paths.js';
import { readJsonFileSync, type DiskRead } from './disk-read.js';
import { recordIntent, needsAutoNameCheck, markAutoNameChecked } from './intent-runtime.js';

export type SessionKind = 'interactive' | 'agent' | 'swarm' | 'scheduled';

export interface SessionMeta {
  name: string;
  kind?: SessionKind;
  parentSessionId?: string;
  /** Herd bond (spec-session-orchestration): the session id of this session's
   *  parent/orchestrator. Set by caco_herd create/acquire, cleared by disown or
   *  self-heal. The ONLY durable herd state — a session is a "parent" iff some
   *  session claims it here (role is derived, never stored on the parent).
   *  Distinct from parentSessionId, which tracks fork/agent lineage. */
  orchestratedBy?: string;
  /** Herd PROVENANCE (spec-soft-archive-folder): the parent whose `caco_herd create`
   *  brought this session into existence. WRITE-ONCE — stamped in the same meta write
   *  as the initial bond and never written or cleared again, so it cannot desync from
   *  `orchestratedBy` and survives disown, re-acquire, and restart. Presence is what
   *  matters: `disown` parks a child for auto-archival only if this is set, so a
   *  session the herd merely ACQUIRED is handed back untouched. Absent on every
   *  session the herd did not create (including legacy bonds) — the fail-safe. */
  herdOriginParent?: string;
  lastObservedAt?: string;
  lastIdleAt?: string;
  /** The observation VERDICT, written when the idle authority classifies an idle:
   *  true when a human is owed attention, false once observed. Persisted so a
   *  restart reads back the decision instead of re-deriving it from timestamps,
   *  which cannot express that an agent requested the work
   *  (spec-observation-authority). Absent on metadata predating the field. */
  unobserved?: boolean;
  lastUsedAt?: string;
  /** @deprecated Runtime-only signal — read via `intent-runtime.getCurrentIntent`.
   *  Kept in the SessionMeta type only so legacy on-disk files parse cleanly and
   *  can be lazily seeded (spec-intent-in-memory). Do not write. */
  currentIntent?: string;
  /** @deprecated Runtime-only signal — read via `intent-runtime.getIntentHistory`.
   *  Kept in the SessionMeta type only for legacy parse compatibility; new code
   *  must not write it (spec-intent-in-memory). */
  intentHistory?: Array<{ text: string; ts: number }>;
  /** Write-once display fallback captured from the FIRST valid intent this session
   *  ever recorded (spec-auto-name-sessions). Stamped in setSessionIntent under the
   *  `!meta.autoName && hasValidText(intent)` guard, never overwritten or cleared.
   *  Consulted only by list()'s title ladder as level 3 (after `meta.name` and
   *  workspace.summary, before the UI's "No summary" literal), so it cannot
   *  mis-signal elsewhere. Kept separate from `intentHistory[0]` because the
   *  history is bounded and evicts from the front — a chatty session would lose
   *  its lifetime-first intent, making the title shimmer. Absent on every session
   *  that has never emitted a valid intent (unhelpful string; unhelpful title). */
  autoName?: string;
  envHint?: string;
  context?: Record<string, string[]>;
  model?: string;
  folder?: string;
  /** Epoch ms when this session was parked into the `auto-archive` folder
   *  (spec-soft-archive-folder). The schedule anchor: the reaper's idle clock is
   *  max(autoArchiveTaggedAt, lastUsedAt, lastIdleAt, creation), so a session already
   *  idle before parking still gets the full grace window from the moment it was
   *  tagged. Set on entry to the folder (disown / folder PATCH), cleared on exit. */
  autoArchiveTaggedAt?: number;
  /** Epoch ms of the user's most recent explicit "this session belongs at the root"
   *  action, i.e. any folder mutation transitioning `folder` from a non-empty value
   *  to root (undefined/empty). Written by the folder PATCH route and by the
   *  `caco_herd acquire` clear-parked branch (spec-auto-park-idle-root). Consulted
   *  ONLY by auto-park's `rootAnchorMs` — the reaper and every other quiescence
   *  question ignore it — so it cannot mis-signal anywhere else. Never cleared;
   *  re-stamped on each qualifying transition (the user's most recent decision is
   *  what matters). Without this, a session dragged from `auto-archive` or a user
   *  folder to root would be re-parked on the next hourly sweep because the folder
   *  PATCH does not touch `lastUsedAt`. */
  movedToRootAt?: number;
  /** Per-session context-window budget (absolute tokens). When set, the SDK's
   *  infiniteSessions.backgroundCompactionThreshold is derived as T/W so the
   *  session compacts earlier, cutting per-call cache cost. Absent = SDK default. */
  contextBudgetTokens?: number;
  /** Reasoning effort level for models that support it. Injected into resumeArgs
   *  on session resume. Absent = SDK default effort for the model. */
  reasoningEffort?: string;
  /** Open-Plugins directories loaded into this session's SDK runtime
   *  (spec-plugin-directories). Absolute + normalized. Supplied on BOTH createSession and
   *  resumeSession, so this field is what makes the choice survive eviction/restart —
   *  the SDK has no live-mutation RPC for it. Absent = no plugins (today's behavior);
   *  scoped to this session only, so ~/.copilot is never polluted. */
  pluginDirectories?: string[];
  /** Caco-side cwd override. When set, wins over the SDK session.start
   *  cwd on cache rebuild (restart) so /session-cwd changes persist. */
  cwd?: string;
  responseOptions?: string[];
  /** ISO time the current `responseOptions` were written — the age of the OFFER,
   *  which the pager uses to decide freshness and to compare against
   *  `pagerDismissedAt`. Written in the same update as the options
   *  (spec-pager). Absent on offers that predate this field; the pager falls
   *  back to `lastIdleAt`, which for a session still holding options describes
   *  the same moment (the turn that wrote them is the turn that then idled). */
  responseOptionsAt?: string;
  /** ISO time the user dismissed this session's offer from the pager. A
   *  monotonic watermark, never cleared: an offer at or before it is hidden, and
   *  a strictly newer offer brings the card back. Deliberately SEPARATE from
   *  `lastObservedAt` — dismissing an offer on one device must not tell every
   *  other client the session has been read (spec-pager). */
  pagerDismissedAt?: string;
  activeApplet?: string;
  appletParams?: Record<string, string>;
  appletPanelVisible?: boolean;
  /** @deprecated Use kind === 'swarm' instead */
  isSwarmSession?: boolean;
  /** Epoch ms of the last history rotation (front-truncation of events.jsonl).
   *  Used as a cooldown so we don't re-rotate a session repeatedly. */
  lastRotatedAt?: number;
  /** Epoch ms of the last AUTO-rotation attempt (success OR failure/refusal).
   *  Auto-rotation backs off on this so a session that keeps failing verify
   *  doesn't re-spin the isolated verify client on every deactivation. */
  lastRotateAttemptAt?: number;
}

// ============================================================================
// Icon
// ============================================================================

/** Prefer animated icon.gif over static icon.png. Returns null if neither exists. */
export function getSessionIconPath(sessionId: string): string | null {
  const dir = getSessionDir(sessionId);
  return [join(dir, 'icon.gif'), join(dir, 'icon.png')].find(existsSync) ?? null;
}

// ============================================================================
// Meta CRUD
// ============================================================================

/** Create meta.json with empty defaults if it doesn't exist yet. */
export function ensureSessionMeta(sessionId: string): void {
  const sessionDir = getSessionDir(sessionId);
  ensureDir(sessionDir);
  const metaPath = join(sessionDir, 'meta.json');
  if (!existsSync(metaPath)) {
    // `unobserved: false` from birth, so a session's verdict is explicit from its
    // first moment rather than inferred. The field's ABSENCE now means only "meta
    // written before the field existed", and reads as observed — there is no
    // longer a fallback that could turn absence into a badge
    // (spec-observation-verdict-completeness).
    writeJsonAtomicSync(metaPath, { name: '', unobserved: false });
  }
}

/**
 * Typed read of a session's meta.json: missing (no file) vs corrupt (unreadable
 * or structurally invalid) vs ok. Applies the legacy `kind` back-fill on ok.
 * A parsed-but-non-object value (null, array, primitive) is classified corrupt.
 */
export function readSessionMeta(sessionId: string): DiskRead<SessionMeta> {
  const metaPath = join(getSessionDir(sessionId), 'meta.json');

  // Auto-heal previously-corrupted zero-byte meta.json (spec-atomic-meta-write).
  // A crash between fs open-with-truncate and the buffer write leaves a 0-byte
  // file; that state can never represent a valid meta and there's nothing to
  // preserve, so treat it as missing. `updateSessionMeta` then recreates
  // defaults on the next mutation, restoring writability without operator
  // intervention. Atomic writes below prevent NEW 0-byte states.
  try {
    if (existsSync(metaPath) && statSync(metaPath).size === 0) {
      return { ok: false, kind: 'missing' };
    }
  } catch { /* fall through to normal read */ }

  const result = readJsonFileSync<unknown>(metaPath);
  if (!result.ok) return result;

  const parsed = result.value;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, kind: 'corrupt', error: new Error('meta.json is not an object') };
  }

  const meta = parsed as SessionMeta;
  if (!meta.kind) {
    if (meta.isSwarmSession) meta.kind = 'swarm';
    else if (meta.parentSessionId) meta.kind = 'agent';
    else meta.kind = 'interactive';
  }
  return { ok: true, value: meta };
}

export function getSessionMeta(sessionId: string): SessionMeta | undefined {
  const result = readSessionMeta(sessionId);
  if (result.ok) return result.value;
  if (result.kind === 'corrupt') {
    console.error(`[STORAGE] getSessionMeta: corrupt meta.json for ${sessionId.slice(0, 8)}: ${result.error.message}`);
  }
  return undefined;
}

export function setSessionMeta(sessionId: string, meta: SessionMeta): void {
  const sessionDir = getSessionDir(sessionId);
  ensureDir(sessionDir);
  writeJsonAtomicSync(join(sessionDir, 'meta.json'), meta);
}

/**
 * Atomic JSON write: temp file + fsync + rename. The truncate-then-write of
 * plain writeFileSync leaves a 0-byte file if the process is killed between
 * open and write — a real defect that stranded live sessions in
 * "metadata unreadable; refusing to overwrite" until manual repair. renameSync
 * of a same-directory sibling is atomic on Windows (ReplaceFile semantics) and
 * POSIX, so the destination is always either the previous valid content or the
 * complete new content.
 *
 * The temp name embeds the PID so two Caco processes writing concurrently
 * (which shouldn't happen but is defensible cheap insurance) don't collide on
 * the same temp path and blow away each other's in-flight write.
 */
function writeJsonAtomicSync(destPath: string, value: unknown): void {
  const tmp = `${destPath}.tmp.${process.pid}`;
  const payload = JSON.stringify(value, null, 2);
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, destPath);
  } catch (err) {
    // Best-effort cleanup so a failed rename doesn't leave the .tmp litter behind.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * The single read-modify-write boundary for session metadata. Never overwrites a
 * corrupt meta.json with defaults — on corrupt it backs the file up once and
 * refuses the write (returns false), preserving the on-disk copy for recovery.
 *
 * Returns true iff the mutation was persisted. A false return means nothing was
 * written: either the file is corrupt, or it is missing and createIfMissing is
 * false. User/API callers MUST check false and surface the refusal rather than
 * reporting phantom success; background callers may log and ignore it.
 */
export function updateSessionMeta(
  sessionId: string,
  mutate: (meta: SessionMeta) => SessionMeta | void,
  opts?: { createIfMissing?: boolean }
): boolean {
  const createIfMissing = opts?.createIfMissing ?? true;
  const result = readSessionMeta(sessionId);

  let meta: SessionMeta;
  if (result.ok) {
    meta = result.value;
  } else if (result.kind === 'missing') {
    if (!createIfMissing) return false;
    meta = { name: '' };
  } else {
    backupCorruptMeta(sessionId, result.error);
    return false;
  }

  const mutated = mutate(meta);
  setSessionMeta(sessionId, mutated ?? meta);
  return true;
}

function backupCorruptMeta(sessionId: string, error: Error): void {
  const dir = getSessionDir(sessionId);
  const metaPath = join(dir, 'meta.json');
  try {
    // Skip: a zero-byte file has nothing to preserve. Copying it would waste
    // the once-per-session backup slot on empty bytes, masking a later,
    // genuinely-recoverable corruption. (Observed with 40685ef0 — a crash
    // between fs write's truncate and its buffer flush left both meta.json
    // and its .corrupt-* sidecar at 0 bytes.)
    let sourceEmpty = false;
    try { sourceEmpty = statSync(metaPath).size === 0; } catch { /* fall through */ }
    if (sourceEmpty) {
      console.error(`[STORAGE] updateSessionMeta: meta.json is 0 bytes for ${sessionId.slice(0, 8)} (${error.message}); skipping backup and refusing to overwrite`);
      return;
    }
    // Back up at most once per corrupt file: a unique timestamped path is always
    // absent, so we must scan for any pre-existing corrupt-* backup instead.
    const alreadyBackedUp = readdirSync(dir).some(f => f.startsWith('meta.json.corrupt-'));
    if (alreadyBackedUp) {
      console.error(`[STORAGE] updateSessionMeta: refusing to overwrite corrupt meta.json for ${sessionId.slice(0, 8)} (${error.message}); backup already exists`);
      return;
    }
    const backupPath = `${metaPath}.corrupt-${Date.now()}`;
    copyFileSync(metaPath, backupPath);
    console.error(`[STORAGE] updateSessionMeta: refusing to overwrite corrupt meta.json for ${sessionId.slice(0, 8)} (${error.message}); backed up to ${backupPath}`);
  } catch (e) {
    console.error(`[STORAGE] updateSessionMeta: corrupt meta.json for ${sessionId.slice(0, 8)} and backup failed: ${(e as Error).message}`);
  }
}

// ============================================================================
// Observed / idle tracking
// ============================================================================

/** Mark session as observed (user viewed the chat panel for it). */
export function markSessionObserved(sessionId: string): void {
  const ts = new Date().toISOString();
  updateSessionMeta(sessionId, meta => { meta.lastObservedAt = ts; meta.unobserved = false; });
  console.log(`[STORAGE] markSessionObserved: ${sessionId.slice(0, 8)} lastObservedAt=${ts}`);
}

/**
 * Mark session as idle (assistant finished its turn).
 *
 * `lastIdleAt` is stamped for EVERY idle, attended or not: the archive reaper and
 * history rotation read it as a coldness signal, so skipping it would make an
 * actively-delegated session look untouched for hours. It deliberately does NOT
 * decide observation — see `meta.unobserved` (spec-observation-authority).
 */
export function markSessionIdle(sessionId: string): void {
  const ts = new Date().toISOString();
  updateSessionMeta(sessionId, meta => { meta.lastIdleAt = ts; });
  console.log(`[STORAGE] markSessionIdle: ${sessionId.slice(0, 8)} lastIdleAt=${ts}`);
}

/**
 * The single rule for "a human owes this session attention".
 *
 * `meta.unobserved` is the VERDICT, written by the tracker at the moment the idle
 * authority classifies an idle — so hydrate reads back exactly what the live set
 * held, instead of re-deriving it from timestamps that cannot express who asked
 * for the work. Deriving it was the bug: an agent-requested idle advanced
 * `lastIdleAt` while `lastObservedAt` stood still, arming every delegate target
 * until the next restart flipped them together.
 *
 * An ABSENT verdict is not unobserved. It was previously a fallback to that same
 * timestamp comparison, nominally to migrate metadata written before the field
 * existed — but nothing ever migrated it. The verdict is written only by an idle
 * that needs observation or by a human opening the session, so a session used
 * solely as a delegate target and never clicked kept an absent field forever and
 * was decided by the broken derivation on every restart. A fallback a population
 * can never escape is not a migration path (spec-observation-verdict-completeness).
 */
export function isUnobservedFromMeta(meta: Pick<SessionMeta, 'unobserved'> | undefined): boolean {
  return meta?.unobserved === true;
}

/** True if the session went idle after it was last observed or attended. */
export function isSessionUnobserved(sessionId: string): boolean {
  return isUnobservedFromMeta(getSessionMeta(sessionId));
}

// ============================================================================
// Intent
// ============================================================================

/**
 * True iff `x` is a string with at least one non-whitespace character
 * (spec-auto-name-sessions). The load-bearing property is `.trim().length > 0`:
 * an empty or whitespace-only string is a false positive for "the model reported
 * a real intent" and, if latched to `meta.autoName`, would render as a blank
 * title. Applied at BOTH stamp time (in `setSessionIntent`) and projection time
 * (`list()`'s ladder) so no path ever promotes an unhelpful string to a title.
 *
 * Accepts `unknown` so callers passing untrusted persisted data (e.g. a JSON
 * value that might not actually be a string) don't need a separate type check.
 */
export function hasValidText(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

/** Update the session's current intent. The runtime signal (`currentIntent`
 *  and its bounded history) lives in the process — see `intent-runtime.ts`
 *  for the rationale (spec-intent-in-memory). This function's ONLY disk write
 *  is the write-once latch of the first valid intent into `meta.autoName`,
 *  which is load-bearing: `meta.autoName` is the persistent display-title
 *  fallback in the spec-auto-name-sessions ladder and must survive restarts.
 *  Once the latch has been checked once per process (`autoNameChecked`), every
 *  subsequent call is a pure in-memory update — zero fs traffic. */
export function setSessionIntent(sessionId: string, intent: string): void {
  recordIntent(sessionId, intent);
  if (!hasValidText(intent)) return;
  if (!needsAutoNameCheck(sessionId)) return;
  // First intent for this session in this process: consult meta, latch if
  // autoName is still empty. Runs at most once per (session × process). If
  // autoName was already latched by a prior process, skip the write path
  // entirely — updateSessionMeta writes unconditionally, and this is the
  // common case for any reopened session.
  const existing = getSessionMeta(sessionId);
  if (existing && !existing.autoName) {
    updateSessionMeta(sessionId, meta => {
      if (!meta.autoName) meta.autoName = intent;
    });
  }
  markAutoNameChecked(sessionId);
}

// ============================================================================
// Session order (MRU snapshot)
// ============================================================================

const SESSION_ORDER_FILE = join(STORAGE_ROOT, 'session-order.json');

export function getSessionOrder(): string[] {
  if (!existsSync(SESSION_ORDER_FILE)) return [];
  try {
    return JSON.parse(readFileSync(SESSION_ORDER_FILE, 'utf-8')) as string[];
  } catch { return []; }
}

export function setSessionOrder(ids: string[]): void {
  ensureDir(STORAGE_ROOT);
  writeJsonAtomicSync(SESSION_ORDER_FILE, ids);
}
