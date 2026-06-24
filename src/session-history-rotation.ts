/**
 * History rotation: front-truncate a session's append-only events.jsonl so the
 * SDK's resumeSession (which reads the whole file) stays fast on long-lived
 * "mega-sessions". See docs/history-rotation-spec.md.
 *
 * Safety model (copy-verify-swap): the live events.jsonl is only ever replaced
 * by a candidate that already passed a REAL SDK load (on a throwaway staged
 * copy, via an isolated client — never the shared one). A concurrent write is
 * detected by an mtime/size re-check and aborts the swap. Crash recovery is
 * decidable purely from the presence of the .prerotate / .candidate sidecar
 * files — no marker needed.
 *
 * Cut point: retain session.start (line 1, mandatory) + everything from the
 * last session.compaction_complete onward, so the freshest compaction summary
 * survives. Falls back to a fixed tail when no compaction event exists.
 */

import {
  existsSync, statSync, readFileSync, writeFileSync, renameSync,
  unlinkSync, mkdirSync, rmSync, copyFileSync, openSync, writeSync, fsyncSync, closeSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { STATE_DIR } from './sdk-session-store.js';
import { parseSessionModel } from './sdk-session-store.js';
import { getSessionMeta, updateSessionMeta } from './session-meta-store.js';
import { unobservedTracker } from './unobserved-tracker.js';
import { isSessionViewed } from './session-viewers.js';

const COMPACTION_MARK = '"type":"session.compaction_complete"';
const USER_MESSAGE_MARK = '"type":"user.message"';
const SIBLING_FILES = ['workspace.yaml', 'vscode.metadata.json', 'session.db'];

export interface RotationConfig {
  thresholdBytes: number;
  minTailEvents: number;
  minSavingBytes: number;
}

export function rotationConfigFromEnv(): RotationConfig {
  const num = (v: string | undefined, d: number) => {
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    thresholdBytes: num(process.env.CACO_ROTATE_THRESHOLD_BYTES, 64 * 1024 * 1024),
    minTailEvents: num(process.env.CACO_ROTATE_MIN_TAIL_EVENTS, 4000),
    minSavingBytes: num(process.env.CACO_ROTATE_MIN_SAVING_BYTES, 32 * 1024 * 1024),
  };
}

export interface CutPlan {
  rotate: boolean;
  reason?: string;
  cutIndex: number;
  retainedLines: number;
  archivedLines: number;
  savedBytes: number;
}

function lineBytes(lines: string[]): number {
  let bytes = 0;
  for (const l of lines) bytes += Buffer.byteLength(l, 'utf-8') + 1;
  return bytes;
}

/**
 * Split event lines into the retained file and the archived (removed) head.
 * Retained = session.start (line 0) + EVERY user.message + everything from the
 * last compaction onward (cutIndex). Archived = the rest.
 *
 * Retaining all user.message events is what preserves the model's recall on
 * resume: the SDK rebuilds a resumed session's context from the user-message
 * digest scattered across the whole history, not just the last compaction
 * summary. They are ~0.1% of a mega-session's bytes, so keeping them is nearly
 * free yet makes a rotated session memory-equivalent to the full history
 * (validated against a real SDK resume + probe — see findings doc).
 */
export function partitionRotation(lines: string[], cutIndex: number): { retained: string[]; archived: string[] } {
  const retained: string[] = [];
  const archived: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 0 || i >= cutIndex || lines[i].includes(USER_MESSAGE_MARK)) retained.push(lines[i]);
    else archived.push(lines[i]);
  }
  return { retained, archived };
}

/**
 * Decide whether and where to cut. `lines` must be the non-empty event lines.
 * Uses partitionRotation so the saving estimate matches what performRotation
 * actually archives.
 */
export function planRotation(lines: string[], fileBytes: number, cfg: RotationConfig): CutPlan {
  const none = (reason: string): CutPlan =>
    ({ rotate: false, reason, cutIndex: lines.length, retainedLines: lines.length, archivedLines: 0, savedBytes: 0 });

  if (fileBytes < cfg.thresholdBytes) return none('below-threshold');
  if (lines.length < 3) return none('too-few-events');

  let cutIndex = -1;
  for (let i = lines.length - 1; i >= 1; i--) {
    if (lines[i].includes(COMPACTION_MARK)) { cutIndex = i; break; }
  }
  if (cutIndex < 0) cutIndex = Math.max(1, lines.length - cfg.minTailEvents);

  if (cutIndex <= 1) return none('cut-too-near-head');

  const { retained, archived } = partitionRotation(lines, cutIndex);
  const savedBytes = lineBytes(archived);
  if (savedBytes < cfg.minSavingBytes) return none('saving-too-small');

  return {
    rotate: true,
    cutIndex,
    retainedLines: retained.length,
    archivedLines: archived.length,
    savedBytes,
  };
}

export interface RotationResult {
  ok: boolean;
  reason?: string;
  beforeBytes?: number;
  afterBytes?: number;
  savedBytes?: number;
  archivedLines?: number;
  error?: string;
}

export interface RotationDeps {
  stateDir: string;
  /** Throws if the staged session fails to load. Default: isolated CopilotClient. */
  verify: (stagedDir: string, stagedId: string) => Promise<void>;
  /** Persist the resolved model to meta before truncating. Returns false to abort. */
  preserveModel: (sessionId: string) => boolean;
  /** True iff a client currently has the session on-screen. Re-checked just
   *  before the swap so a session viewed mid-verify is not rotated. */
  isViewed: (sessionId: string) => boolean;
  config: RotationConfig;
  log: (msg: string) => void;
}

/** Persist the session's model to meta so post-rotation reads don't depend on
 *  pre-cut session.start / model_change events. Meta-first keeps BYOK/provider
 *  identity; only parses events as a fallback. Abort (false) if meta is corrupt. */
export function defaultPreserveModel(sessionId: string): boolean {
  if (getSessionMeta(sessionId)?.model) return true;
  const parsed = parseSessionModel(sessionId);
  if (!parsed) return true;
  return updateSessionMeta(sessionId, m => { m.model = parsed; });
}

async function verifyWithIsolatedClient(stagedDir: string, stagedId: string): Promise<void> {
  const { CopilotClient, approveAll } = await import('@github/copilot-sdk');
  void stagedDir;
  const client = new CopilotClient({ workingDirectory: process.cwd() }) as unknown as {
    start(): Promise<void>;
    resumeSession(id: string, cfg: unknown): Promise<{ disconnect?: () => Promise<void> }>;
    stop?(): Promise<void>;
  };
  await client.start();
  try {
    const session = await client.resumeSession(stagedId, {
      streaming: true,
      onPermissionRequest: approveAll,
      configDir: join(homedir(), '.copilot'),
      suppressResumeEvent: true,
    });
    try { await session.disconnect?.(); } catch { /* best effort */ }
  } finally {
    try { await client.stop?.(); } catch { /* best effort */ }
  }
}

function defaultDeps(): RotationDeps {
  return {
    stateDir: STATE_DIR,
    verify: verifyWithIsolatedClient,
    preserveModel: defaultPreserveModel,
    isViewed: isSessionViewed,
    config: rotationConfigFromEnv(),
    log: (msg: string) => console.log(msg),
  };
}

/** Read a file's non-empty lines without ever building a single >512MB string
 *  (which readFileSync(path,'utf-8') would on a mega-session). Reads the bytes
 *  as a Buffer and decodes per line, so it is safe at the exact sizes rotation
 *  exists to shrink. Uses native Buffer.indexOf for speed. */
function readEventLinesNonEmpty(path: string): string[] {
  const buf = readFileSync(path);
  const lines: string[] = [];
  let start = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(0x0a, start);
    if (nl === -1) nl = buf.length;
    if (nl > start) lines.push(buf.toString('utf-8', start, nl));
    start = nl + 1;
  }
  return lines;
}

function appendAndFsync(path: string, text: string): void {  const fd = openSync(path, 'a');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Core rotation against a session directory. Injectable deps keep it free of the
 * SDK and the real state root for testing. Does NOT acquire the SessionManager
 * rotation lock — callers (rotateSessionHistory) do, after confirming the
 * session is inactive.
 */
export async function performRotation(sessionId: string, overrides: Partial<RotationDeps> = {}): Promise<RotationResult> {
  const deps = { ...defaultDeps(), ...overrides };
  const dir = join(deps.stateDir, sessionId);
  const eventsPath = join(dir, 'events.jsonl');
  const prerotate = eventsPath + '.prerotate';
  const candidate = eventsPath + '.candidate';
  const archivePath = join(dir, 'events-archive.jsonl');

  if (!existsSync(eventsPath)) return { ok: false, reason: 'missing' };
  if (existsSync(prerotate) || existsSync(candidate)) return { ok: false, reason: 'rotation-artifacts-present' };

  const srcStat = statSync(eventsPath);
  const lines = readEventLinesNonEmpty(eventsPath);

  const plan = planRotation(lines, srcStat.size, deps.config);
  if (!plan.rotate) return { ok: false, reason: plan.reason };

  if (!deps.preserveModel(sessionId)) return { ok: false, reason: 'model-persist-failed' };

  const { retained, archived } = partitionRotation(lines, plan.cutIndex);
  writeFileSync(candidate, retained.join('\n') + '\n');

  const stagedId = `rotcheck-${sessionId.slice(0, 8)}-${Date.now()}`;
  const stagedDir = join(deps.stateDir, stagedId);
  try {
    mkdirSync(stagedDir, { recursive: true });
    copyFileSync(candidate, join(stagedDir, 'events.jsonl'));
    for (const f of SIBLING_FILES) {
      const p = join(dir, f);
      if (existsSync(p)) copyFileSync(p, join(stagedDir, f));
    }
    await deps.verify(stagedDir, stagedId);
  } catch (e) {
    safeUnlink(candidate);
    return { ok: false, reason: 'verify-failed', error: e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(stagedDir, { recursive: true, force: true });
  }

  const recheck = statSync(eventsPath);
  if (recheck.size !== srcStat.size || recheck.mtimeMs !== srcStat.mtimeMs) {
    safeUnlink(candidate);
    return { ok: false, reason: 'concurrent-write' };
  }

  // A client may have opened (subscribed to) this session during the multi-second
  // verify. Don't swap the file out from under an on-screen session — abort and
  // leave the original untouched.
  if (deps.isViewed(sessionId)) {
    safeUnlink(candidate);
    return { ok: false, reason: 'became-viewed' };
  }
  try {
    appendAndFsync(archivePath, archived.join('\n') + '\n');
  } catch (e) {
    safeUnlink(candidate);
    return { ok: false, reason: 'archive-failed', error: e instanceof Error ? e.message : String(e) };
  }

  // Swap. Decidable crash recovery relies on this exact order (see reconcileRotation).
  renameSync(eventsPath, prerotate);
  renameSync(candidate, eventsPath);
  safeUnlink(prerotate);

  updateSessionMeta(sessionId, m => { m.lastRotatedAt = Date.now(); });

  const afterBytes = statSync(eventsPath).size;
  deps.log(`[ROTATE] ${sessionId.slice(0, 8)} ${(srcStat.size / 1048576).toFixed(1)}MB → ${(afterBytes / 1048576).toFixed(1)}MB (archived ${plan.archivedLines} events)`);
  return {
    ok: true,
    beforeBytes: srcStat.size,
    afterBytes,
    savedBytes: srcStat.size - afterBytes,
    archivedLines: plan.archivedLines,
  };
}

function safeUnlink(path: string): void {
  try { if (existsSync(path)) unlinkSync(path); } catch { /* best effort */ }
}

/**
 * Reconcile a session dir after a possible mid-rotation crash, using only file
 * presence (the swap order in performRotation makes every state decidable).
 * Returns a short status for logging. Safe to call when nothing is pending.
 */
export function reconcileRotation(sessionId: string, overrides: Partial<Pick<RotationDeps, 'stateDir'>> = {}): string {
  const stateDir = overrides.stateDir ?? STATE_DIR;
  const dir = join(stateDir, sessionId);
  const eventsPath = join(dir, 'events.jsonl');
  const prerotate = eventsPath + '.prerotate';
  const candidate = eventsPath + '.candidate';

  const hasPre = existsSync(prerotate);
  const hasCand = existsSync(candidate);
  if (!hasPre && !hasCand) return 'clean';
  const hasEvents = existsSync(eventsPath);

  if (!hasPre && hasCand) {
    // Crash before the first swap rename: live events.jsonl is the untouched
    // original. The candidate was verified but never installed — discard it.
    if (hasEvents) { safeUnlink(candidate); return 'discarded-candidate'; }
    // No live file but a verified candidate exists — install it.
    renameSync(candidate, eventsPath);
    return 'installed-candidate';
  }

  // prerotate (original) exists.
  if (hasEvents) {
    // Swap completed through the second rename: events.jsonl is the verified
    // candidate, prerotate is the stale original. Drop the leftovers.
    safeUnlink(candidate);
    safeUnlink(prerotate);
    return 'committed-cleanup';
  }
  // events.jsonl missing → crash between the two renames.
  if (hasCand) {
    renameSync(candidate, eventsPath);
    safeUnlink(prerotate);
    return 'recovered-candidate';
  }
  renameSync(prerotate, eventsPath);
  return 'restored-original';
}

/**
 * Public entry: reconcile any prior crash, then rotate under the SessionManager
 * exclusivity lock (refuses if the session is active/busy/already rotating).
 */
export async function rotateSessionHistory(sessionId: string, overrides: Partial<RotationDeps> = {}): Promise<RotationResult> {
  const { sessionManager } = await import('./session-manager.js');
  reconcileRotation(sessionId, overrides);
  return sessionManager.runExclusiveRotation(sessionId, () => performRotation(sessionId, overrides));
}

const AUTO_ROTATE_COOLDOWN_MS = 60 * 60 * 1000;

function envMs(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export interface AutoRotateOverrides extends Partial<RotationDeps> {
  isUnobserved?: (sessionId: string) => boolean;
  /** Sweep-only coldness gate: require the session idle for ≥ this long (and
   *  already observed). 0 (default, the stop() path) disables the age check. */
  minIdleAgeMs?: number;
  /** True iff the session is active/busy/resuming/rotating — skip without
   *  stamping cooldown. Default consults SessionManager. */
  isBlocked?: (sessionId: string) => boolean | Promise<boolean>;
}

/**
 * Phase 2 auto-rotation entry, called fire-and-forget when a session deactivates
 * and per-session by the idle sweep. Cheap gates run BEFORE the isolated verify
 * client, so ineligible sessions cost ~nothing. Never throws.
 *
 * Gate order (cheapest-first): env → observed → not-viewed → idle-age (sweep) →
 * size → not-blocked → cooldown → stamp → rotate. The size check precedes the
 * (SessionManager-importing) not-blocked check so small/missing sessions never
 * pull in the manager. The not-blocked check precedes the cooldown stamp so a
 * temporarily active/busy session is not spuriously cooled down for an hour.
 */
export async function autoRotateIfEligible(
  sessionId: string,
  overrides: AutoRotateOverrides = {},
): Promise<RotationResult | null> {
  if (process.env.CACO_ROTATE_AUTO !== '1') return null;

  const isUnobserved = overrides.isUnobserved ?? defaultIsUnobserved;
  if (isUnobserved(sessionId)) return null;

  const isViewed = overrides.isViewed ?? isSessionViewed;
  if (isViewed(sessionId)) return null;

  const meta = getSessionMeta(sessionId);

  const minIdleAgeMs = overrides.minIdleAgeMs ?? 0;
  if (minIdleAgeMs > 0) {
    const lastIdleAt = meta?.lastIdleAt ? Date.parse(meta.lastIdleAt) : NaN;
    if (!Number.isFinite(lastIdleAt)) return null; // never idle / no metadata ⇒ not provably cold
    if (Date.now() - lastIdleAt < minIdleAgeMs) return null;
  }

  const stateDir = overrides.stateDir ?? STATE_DIR;
  let size = 0;
  try { size = statSync(join(stateDir, sessionId, 'events.jsonl')).size; } catch { return null; }
  const cfg = overrides.config ?? rotationConfigFromEnv();
  if (size < cfg.thresholdBytes) return null;

  const isBlocked = overrides.isBlocked ?? defaultIsRotationBlocked;
  if (await isBlocked(sessionId)) return null;

  // Back off on the most recent attempt OR success — a session that keeps
  // failing verify must not re-spin the isolated client on every deactivation.
  const lastTouch = Math.max(meta?.lastRotatedAt ?? 0, meta?.lastRotateAttemptAt ?? 0);
  if (lastTouch && Date.now() - lastTouch < AUTO_ROTATE_COOLDOWN_MS) return null;

  // Record the attempt BEFORE the expensive work so a failure still cools down.
  updateSessionMeta(sessionId, m => { m.lastRotateAttemptAt = Date.now(); });
  try {
    return await rotateSessionHistory(sessionId, overrides);
  } catch {
    return null;
  }
}

/** Real unobserved check: a session that went idle but whose result the user
 *  hasn't viewed yet (they're likely about to open it). */
function defaultIsUnobserved(sessionId: string): boolean {
  return unobservedTracker.isUnobserved(sessionId);
}

/** A session is "blocked" for rotation if it's active/busy/resuming/rotating.
 *  Imported lazily to avoid an import cycle with session-manager. */
async function defaultIsRotationBlocked(sessionId: string): Promise<boolean> {
  const { sessionManager } = await import('./session-manager.js');
  return sessionManager.isActive(sessionId)
    || sessionManager.isBusy(sessionId)
    || sessionManager.isRotating(sessionId)
    || sessionManager.isResuming(sessionId);
}

export interface SweepSummary { scanned: number; rotated: number; savedBytes: number; }

export interface SweepDeps {
  rotate?: (sessionId: string, overrides: AutoRotateOverrides) => Promise<RotationResult | null>;
  knownSessionIds?: () => string[] | Promise<string[]>;
  minIdleAgeMs?: number;
  bootExcludeId?: string | null;
  log?: (msg: string) => void;
}

let sweeping = false;

/**
 * Idle sweep: discover rotation-eligible sessions and rotate them sequentially
 * (one isolated verify client at a time). Pure discovery — every gate lives in
 * autoRotateIfEligible. No-op unless CACO_ROTATE_AUTO=1; guarded against overlap.
 */
export async function sweepRotateEligible(deps: SweepDeps = {}): Promise<SweepSummary> {
  const summary: SweepSummary = { scanned: 0, rotated: 0, savedBytes: 0 };
  if (process.env.CACO_ROTATE_AUTO !== '1') return summary;
  if (sweeping) return summary;
  sweeping = true;
  try {
    const ids = deps.knownSessionIds
      ? await deps.knownSessionIds()
      : (await import('./session-manager.js')).sessionManager.knownSessionIds();
    const rotate = deps.rotate ?? autoRotateIfEligible;
    const minIdleAgeMs = deps.minIdleAgeMs ?? envMs('CACO_ROTATE_MIN_IDLE_AGE_MS', 4 * 60 * 60 * 1000);
    for (const id of ids) {
      if (deps.bootExcludeId && id === deps.bootExcludeId) continue;
      summary.scanned++;
      try {
        const r = await rotate(id, { minIdleAgeMs });
        if (r?.ok) { summary.rotated++; summary.savedBytes += r.savedBytes ?? 0; }
      } catch { /* one session must never break the sweep */ }
    }
    (deps.log ?? ((m: string) => console.log(m)))(
      `[ROTATE-SWEEP] scanned=${summary.scanned} rotated=${summary.rotated} freed=${(summary.savedBytes / 1048576).toFixed(1)} MB`,
    );
    return summary;
  } finally {
    sweeping = false;
  }
}

export interface SweeperHandle { stop(): void; }

/**
 * Start the background sweeper: one boot sweep (delayed so reconnecting clients
 * register as viewers first) + a periodic sweep. Timers are unref'd so they
 * never keep the process alive. Behind CACO_ROTATE_AUTO=1 via sweepRotateEligible.
 */
export function startRotationSweeper(opts: {
  bootDelayMs?: number;
  intervalMs?: number;
  getBootExcludeId?: () => string | null;
} = {}): SweeperHandle {
  const bootDelay = opts.bootDelayMs ?? envMs('CACO_ROTATE_BOOT_DELAY_MS', 60 * 1000);
  const intervalMs = opts.intervalMs ?? envMs('CACO_ROTATE_SWEEP_INTERVAL_MS', 4 * 60 * 60 * 1000);

  const bootTimer = setTimeout(() => {
    void sweepRotateEligible({ bootExcludeId: opts.getBootExcludeId?.() ?? null });
  }, bootDelay);
  bootTimer.unref?.();

  const intervalTimer = setInterval(() => { void sweepRotateEligible(); }, intervalMs);
  intervalTimer.unref?.();

  return {
    stop() {
      clearTimeout(bootTimer);
      clearInterval(intervalTimer);
    },
  };
}
