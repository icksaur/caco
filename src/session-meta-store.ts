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

import { writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { STORAGE_ROOT, getSessionDir, ensureDir } from './storage-paths.js';
import { readJsonFileSync, type DiskRead } from './disk-read.js';

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
  lastUsedAt?: string;
  currentIntent?: string;
  intentHistory?: Array<{ text: string; ts: number }>;
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

const INTENT_HISTORY_LIMIT = 5;

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
    writeFileSync(metaPath, JSON.stringify({ name: '' }, null, 2));
  }
}

/**
 * Typed read of a session's meta.json: missing (no file) vs corrupt (unreadable
 * or structurally invalid) vs ok. Applies the legacy `kind` back-fill on ok.
 * A parsed-but-non-object value (null, array, primitive) is classified corrupt.
 */
export function readSessionMeta(sessionId: string): DiskRead<SessionMeta> {
  const metaPath = join(getSessionDir(sessionId), 'meta.json');
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
  writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2));
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
  updateSessionMeta(sessionId, meta => { meta.lastObservedAt = ts; });
  console.log(`[STORAGE] markSessionObserved: ${sessionId.slice(0, 8)} lastObservedAt=${ts}`);
}

/** Mark session as idle (assistant finished its turn). */
export function markSessionIdle(sessionId: string): void {
  const ts = new Date().toISOString();
  updateSessionMeta(sessionId, meta => { meta.lastIdleAt = ts; });
  console.log(`[STORAGE] markSessionIdle: ${sessionId.slice(0, 8)} lastIdleAt=${ts}`);
}

/** True if the session went idle after the user last observed it. */
export function isSessionUnobserved(sessionId: string): boolean {
  const meta = getSessionMeta(sessionId);
  if (!meta?.lastIdleAt) return false; // Never went idle
  if (!meta.lastObservedAt) return true; // Never observed
  const result = new Date(meta.lastIdleAt) > new Date(meta.lastObservedAt);
  if (result) {
    console.log(`[STORAGE] isSessionUnobserved: ${sessionId.slice(0, 8)} = true (idle=${meta.lastIdleAt}, obs=${meta.lastObservedAt})`);
  }
  return result;
}

// ============================================================================
// Intent
// ============================================================================

/** Update the session's current intent and append to its bounded history. */
export function setSessionIntent(sessionId: string, intent: string): void {
  updateSessionMeta(sessionId, meta => {
    meta.currentIntent = intent;
    const history = meta.intentHistory ?? [];
    history.push({ text: intent, ts: Date.now() });
    if (history.length > INTENT_HISTORY_LIMIT) {
      history.splice(0, history.length - INTENT_HISTORY_LIMIT);
    }
    meta.intentHistory = history;
  });
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
  writeFileSync(SESSION_ORDER_FILE, JSON.stringify(ids));
}
