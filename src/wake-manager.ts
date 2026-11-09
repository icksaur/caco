/**
 * Session self-wake manager (spec-session-wake). Owns `meta.wake` and its
 * in-memory index, runs the per-tick decision, fires wakes, and settles each
 * wake when its turn really ends. All I/O is injected (see wake-runtime.ts for
 * the real wiring) so the loop is unit-testable with fakes.
 */

import type { SessionMeta, WakeState } from './session-meta-store.js';
import { decideWake, buildWakePrompt, type WakeWindowSpec } from './wake-core.js';
import type { TurnOutcome } from './turn-outcome.js';

export interface WakeConfig {
  minHours: number;
  maxHours: number;
  noteMax: number;
  maxActive: number;
  maxRunning: number;
  maxFailures: number;
  humanQuietMs: number;
  expireMs: number;
  turnTimeoutMs: number;
  window: WakeWindowSpec;
  archiveFolder: string;
}

export interface WakeManagerDeps {
  now(): number;
  listSessionIds(): string[];
  getMeta(id: string): SessionMeta | undefined;
  /** Read-modify-write that never creates a missing meta. False = not written. */
  updateMeta(id: string, mutate: (m: SessionMeta) => void): boolean;
  isBusy(id: string): boolean;
  /** POST the wake prompt as `source:'scheduler'`; resolves the HTTP status. */
  post(id: string, prompt: string): Promise<number>;
  markUnobserved(id: string): void;
  toolDisabled(): boolean;
  log?(msg: string): void;
  config: WakeConfig;
}

export type WakeSetResult = { ok: true; wake: WakeState } | { ok: false; error: string };

const iso = (ms: number) => new Date(ms).toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;

export function createWakeManager(deps: WakeManagerDeps) {
  const cfg = deps.config;
  const index = new Map<string, WakeState>();
  let executing = false;
  const log = (msg: string) => deps.log?.(`[WAKE] ${msg}`);

  /** The single write path for `meta.wake`; keeps the index in step. */
  function write(id: string, mutate: (cur: WakeState | undefined) => WakeState | undefined): WakeState | undefined {
    let out: WakeState | undefined;
    const ok = deps.updateMeta(id, m => {
      out = mutate(m.wake ? { ...m.wake } : undefined);
      if (out) m.wake = out; else delete m.wake;
    });
    if (!ok) { index.delete(id); return undefined; }
    if (out) index.set(id, { ...out }); else index.delete(id);
    return out;
  }

  function refresh(id: string): void {
    const w = deps.getMeta(id)?.wake;
    if (w) index.set(id, { ...w }); else index.delete(id);
  }

  /** Boot: rebuild the index from meta. A `running` wake cannot survive a
   *  restart, so it is recorded as interrupted (not counted as a failure). */
  function rebuild(): void {
    index.clear();
    for (const id of deps.listSessionIds()) {
      const w = deps.getMeta(id)?.wake;
      if (!w) continue;
      if (w.lastResult === 'running') {
        write(id, cur => cur && { ...cur, lastResult: 'error', lastError: 'interrupted by restart' });
      } else {
        index.set(id, { ...w });
      }
    }
  }

  function activeCount(excluding?: string): number {
    let n = 0;
    for (const [id, w] of index) if (id !== excluding && !w.pausedReason) n++;
    return n;
  }

  function runningCount(): number {
    let n = 0;
    for (const w of index.values()) if (w.lastResult === 'running') n++;
    return n;
  }

  function set(id: string, everyHours: unknown, note?: unknown): WakeSetResult {
    if (typeof everyHours !== 'number' || !Number.isInteger(everyHours) || everyHours < cfg.minHours || everyHours > cfg.maxHours) {
      return { ok: false, error: `everyHours must be a whole number from ${cfg.minHours} to ${cfg.maxHours}.` };
    }
    if (note !== undefined && typeof note !== 'string') return { ok: false, error: 'note must be a string.' };
    const trimmed = typeof note === 'string' ? note.trim() : '';
    if (trimmed.length > cfg.noteMax) return { ok: false, error: `note must be at most ${cfg.noteMax} characters.` };
    if (activeCount(id) >= cfg.maxActive) {
      return { ok: false, error: `Wake limit reached: at most ${cfg.maxActive} sessions may have an active wake.` };
    }
    if (!deps.getMeta(id)) return { ok: false, error: 'Session metadata not found.' };
    const now = deps.now();
    const wake = write(id, prev => {
      // Re-arming from inside a running wake keeps that wake's bookkeeping, so
      // the turn still settles (and a final wake still pauses) when it ends.
      const running = prev?.lastResult === 'running';
      const next: WakeState = {
        everyMinutes: everyHours * 60,
        registeredAt: prev?.registeredAt ?? iso(now),
        nextWakeAt: iso(now + everyHours * 60 * 60 * 1000),
        consecutiveFailures: running ? prev!.consecutiveFailures : 0,
      };
      if (trimmed) next.note = trimmed;
      if (prev?.lastWakeAt) next.lastWakeAt = prev.lastWakeAt;
      if (prev?.lastResult) next.lastResult = prev.lastResult;
      if (prev?.lastError) next.lastError = prev.lastError;
      if (running && prev?.finalWakeAt) next.finalWakeAt = prev.finalWakeAt;
      return next;
    });
    if (!wake) return { ok: false, error: 'Could not write session metadata.' };
    log(`set ${id.slice(0, 8)} every ${everyHours}h`);
    return { ok: true, wake };
  }

  function clear(id: string): boolean {
    const had = !!(index.get(id) ?? deps.getMeta(id)?.wake);
    if (had) { write(id, () => undefined); log(`cleared ${id.slice(0, 8)}`); }
    return had;
  }

  function get(id: string): WakeState | undefined {
    return deps.getMeta(id)?.wake;
  }

  function list(): Array<{ sessionId: string; wake: WakeState }> {
    return [...index].map(([sessionId, wake]) => ({ sessionId, wake: { ...wake } }));
  }

  /** Record a running wake's outcome at the REAL end of its turn. */
  function settle(id: string, outcome: TurnOutcome, reason?: string): void {
    if (index.get(id)?.lastResult !== 'running') return;
    let paused: WakeState['pausedReason'];
    write(id, cur => {
      if (!cur || cur.lastResult !== 'running') return cur;
      const next: WakeState = { ...cur };
      if (outcome === 'ok') {
        next.lastResult = 'ok';
        delete next.lastError;
        next.consecutiveFailures = 0;
      } else {
        next.lastResult = 'error';
        next.lastError = reason ?? 'error';
        next.consecutiveFailures = (cur.consecutiveFailures ?? 0) + 1;
        if (next.consecutiveFailures >= cfg.maxFailures) next.pausedReason = 'failures';
      }
      if (next.finalWakeAt && !next.pausedReason) next.pausedReason = 'expired';
      paused = next.pausedReason;
      return next;
    });
    if (paused) {
      log(`paused ${id.slice(0, 8)} (${paused})`);
      deps.markUnobserved(id);
    }
  }

  async function fire(id: string, wake: WakeState, final: boolean, now: number): Promise<boolean> {
    const prompt = buildWakePrompt({
      nowMs: now, wake, final,
      timeZone: cfg.window?.timeZone,
      expireDays: Math.round(cfg.expireMs / DAY_MS),
    });
    const prev = { ...wake };
    write(id, cur => {
      if (!cur) return cur;
      const next: WakeState = { ...cur, lastWakeAt: iso(now), lastResult: 'running', nextWakeAt: iso(now + cur.everyMinutes * 60 * 1000) };
      delete next.lastError;
      if (final) next.finalWakeAt = iso(now);
      return next;
    });
    let status = 0;
    try { status = await deps.post(id, prompt); } catch { status = 0; }
    if (status >= 200 && status < 300) {
      log(`fired ${id.slice(0, 8)}${final ? ' (final)' : ''}`);
      return true;
    }
    if (status === 409) {
      // Lost a race with a human send: the same as a busy defer. Restore the
      // pre-fire fields so nothing advanced.
      write(id, cur => (cur && cur.lastResult === 'running' ? { ...prev } : cur));
      return false;
    }
    settle(id, 'error', status ? `HTTP ${status}` : 'network error');
    return false;
  }

  async function tick(): Promise<void> {
    if (executing) return;
    executing = true;
    try {
      if (deps.toolDisabled()) return;
      const now = deps.now();
      for (const [id, w] of [...index]) {
        if (w.lastResult === 'running' && w.lastWakeAt && now - Date.parse(w.lastWakeAt) > cfg.turnTimeoutMs) {
          settle(id, 'error', 'no idle within timeout');
        }
      }
      let running = runningCount();
      const due = [...index]
        .filter(([, w]) => !w.pausedReason && w.lastResult !== 'running' && Date.parse(w.nextWakeAt) <= now)
        .sort((a, b) => Date.parse(a[1].nextWakeAt) - Date.parse(b[1].nextWakeAt));
      for (const [id] of due) {
        const meta = deps.getMeta(id);
        if (!meta?.wake) { index.delete(id); continue; }
        if (meta.folder === cfg.archiveFolder) {
          write(id, () => undefined);
          log(`cleared ${id.slice(0, 8)} (staged for archive)`);
          continue;
        }
        const d = decideWake({
          wake: meta.wake, nowMs: now, lastHumanAt: meta.lastUsedAt, busy: deps.isBusy(id),
          runningCount: running, window: cfg.window, expireMs: cfg.expireMs,
          humanQuietMs: cfg.humanQuietMs, maxRunning: cfg.maxRunning,
        });
        if (d.kind === 'defer-window') {
          write(id, cur => cur && { ...cur, nextWakeAt: iso(d.nextAtMs) });
        } else if (d.kind === 'fire') {
          running++;
          if (!(await fire(id, meta.wake, d.final, now))) running--;
        }
      }
    } finally {
      executing = false;
    }
  }

  /** Imported session (spec-session-wake, Import). A migration export keeps the
   *  wake armed; a plain copy arrives paused so two machines never wake one session. */
  function applyImport(id: string, migrated: boolean): void {
    const w = deps.getMeta(id)?.wake;
    if (!w) { index.delete(id); return; }
    write(id, cur => {
      if (!cur) return cur;
      const next: WakeState = { ...cur };
      if (next.lastResult === 'running') { next.lastResult = 'error'; next.lastError = 'interrupted by transfer'; }
      if (!migrated && !next.pausedReason) next.pausedReason = 'imported';
      return next;
    });
  }

  return { set, clear, get, list, refresh, rebuild, tick, settle, applyImport, runningCount };
}

export type WakeManager = ReturnType<typeof createWakeManager>;
