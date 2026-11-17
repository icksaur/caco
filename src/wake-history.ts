/**
 * Wake history and counters (spec-session-overview, Wake history). Pure
 * helpers over `WakeState`: the wake manager calls them inside its single
 * write path, so every lifecycle path records exactly one terminal run per
 * slot. No I/O.
 */

import type {
  WakeState, WakeCounters, WakeRun, WakeRunOutcome, WakeDefer, WakeDeferKind, WakePendingRun,
} from './session-meta-store.js';

export const WAKE_HISTORY_MAX_RUNS = 20;
export const WAKE_HISTORY_MAX_BYTES = 8 * 1024;
export const WAKE_DEFER_MAX = 5;
const REASON_MAX = 100;

const iso = (ms: number) => new Date(ms).toISOString();

export function emptyCounters(): WakeCounters {
  return { fires: 0, ok: 0, errors: 0, cancelled: 0, interrupted: 0, offered: 0, firesSinceHuman: 0 };
}

function countersOf(w: WakeState): WakeCounters {
  return { ...emptyCounters(), ...w.counters };
}

/** Fields that survive `set` replacing a wake (history is dropped only by `clear`). */
export function carryHistory(prev: WakeState | undefined, next: WakeState, running: boolean): void {
  if (!prev) return;
  if (prev.slotSeq !== undefined) next.slotSeq = prev.slotSeq;
  if (prev.counters) next.counters = { ...prev.counters };
  if (prev.lastOkAt) next.lastOkAt = prev.lastOkAt;
  if (prev.lastOfferedAt) next.lastOfferedAt = prev.lastOfferedAt;
  if (prev.history) next.history = prev.history.map(r => ({ ...r }));
  if (prev.historySince) next.historySince = prev.historySince;
  if (prev.defers) next.defers = prev.defers.map(d => ({ ...d }));
  if (running && prev.pendingRun) next.pendingRun = { ...prev.pendingRun };
}

/** Fire accepted for dispatch: open a slot. */
export function startRun(w: WakeState, o: {
  nowMs: number; dueAt: string; final: boolean; offerBaseline: string | null; lastHumanAt?: string;
}): WakeState {
  const c = countersOf(w);
  const h = o.lastHumanAt;
  if (h && h !== c.humanAnchor && (!c.humanAnchor || !(Date.parse(h) <= Date.parse(c.humanAnchor)))) {
    c.firesSinceHuman = 0;
    c.humanAnchor = h;
  }
  c.fires++;
  c.firesSinceHuman++;
  const slot = (w.slotSeq ?? 0) + 1;
  const pendingRun: WakePendingRun = { slot, dueAt: o.dueAt, firedAt: iso(o.nowMs), offerBaseline: o.offerBaseline };
  if (o.final) pendingRun.final = true;
  return { ...w, slotSeq: slot, counters: c, pendingRun };
}

/** A 409 race: the fire never happened. Undo the slot and the fire counters
 *  (`firesSinceHuman`/`humanAnchor` back to their pre-fire values); history
 *  and any other counters are kept. */
export function undoStart(w: WakeState, slot: number, before: WakeState): WakeState {
  if (w.pendingRun?.slot !== slot) return w;
  const next: WakeState = { ...w };
  delete next.pendingRun;
  next.slotSeq = Math.max(0, (w.slotSeq ?? slot) - 1);
  const c = countersOf(w);
  const b = countersOf(before);
  c.fires = Math.max(0, c.fires - 1);
  c.firesSinceHuman = b.firesSinceHuman;
  if (b.humanAnchor) c.humanAnchor = b.humanAnchor; else delete c.humanAnchor;
  next.counters = c;
  return next;
}

/** A transient retry of the pending run's turn. Recorded once, at settle. */
export function noteRetry(w: WakeState, attempt: number): WakeState {
  if (!w.pendingRun) return w;
  return { ...w, pendingRun: { ...w.pendingRun, retries: Math.max(attempt, w.pendingRun.retries ?? 0) } };
}

function isNewer(at: string | undefined, baseline: string | null): boolean {
  if (!at) return false;
  if (!baseline) return true;
  return Date.parse(at) > Date.parse(baseline);
}

/** Close the pending slot with its one terminal run. No pending slot: unchanged. */
export function finishRun(w: WakeState, o: {
  nowMs: number; outcome: WakeRunOutcome; reason?: string; offerAt?: string;
}): WakeState {
  const p = w.pendingRun;
  if (!p) return w;
  const settledAt = iso(o.nowMs);
  const run: WakeRun = { slot: p.slot, dueAt: p.dueAt, firedAt: p.firedAt, settledAt, outcome: o.outcome };
  if (o.reason) run.reason = o.reason.slice(0, REASON_MAX);
  if (p.final) run.final = true;
  if (p.retries) run.retries = p.retries;
  const c = countersOf(w);
  const next: WakeState = { ...w, counters: c };
  delete next.pendingRun;
  if (o.outcome !== 'rejected' && isNewer(o.offerAt, p.offerBaseline)) {
    run.offered = true;
    c.offered++;
    next.lastOfferedAt = settledAt;
  }
  if (o.outcome === 'ok') { c.ok++; next.lastOkAt = settledAt; }
  else if (o.outcome === 'cancelled') c.cancelled++;
  else if (o.outcome === 'interrupted') c.interrupted++;
  else c.errors++;
  return appendRun(next, run);
}

const historyBytes = (h: WakeRun[]) => Buffer.byteLength(JSON.stringify(h), 'utf8');

/** Append with the count and byte caps; `historySince` moves with the oldest run. */
export function appendRun(w: WakeState, run: WakeRun): WakeState {
  const history = [...(w.history ?? []), run];
  let trimmed = false;
  while (history.length > WAKE_HISTORY_MAX_RUNS) { history.shift(); trimmed = true; }
  while (history.length > 1 && historyBytes(history) > WAKE_HISTORY_MAX_BYTES) { history.shift(); trimmed = true; }
  const next: WakeState = { ...w, history };
  if (trimmed || !next.historySince) next.historySince = history[0].dueAt;
  return next;
}

/** Merge one or more deferring ticks into the record for `dueAt`. */
export function recordDefer(w: WakeState, o: { dueAt: string; kind: WakeDeferKind; nowMs: number; count: number }): WakeState {
  const defers = (w.defers ?? []).map(d => ({ ...d }));
  const at = iso(o.nowMs);
  const rec = defers.find(d => d.dueAt === o.dueAt);
  if (rec) {
    rec.kind = o.kind;
    rec.last = at;
    rec.count += o.count;
  } else {
    defers.push({ dueAt: o.dueAt, kind: o.kind, first: at, last: at, count: o.count });
    while (defers.length > WAKE_DEFER_MAX) defers.shift();
  }
  return { ...w, defers };
}

// ---------------------------------------------------------------------------
// Import validation
// ---------------------------------------------------------------------------

const OUTCOMES = new Set<string>(['ok', 'error', 'cancelled', 'interrupted', 'rejected']);
const DEFER_KINDS = new Set<string>(['busy', 'human', 'window', 'concurrency', 'archived']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const optIso = (v: unknown) => v === undefined || isIso(v);
const optTrue = (v: unknown) => v === undefined || v === true;
const optCount = (v: unknown) => v === undefined || isCount(v);

function cleanRun(v: unknown): WakeRun | null {
  if (!isObj(v)) return null;
  if (!isCount(v.slot) || !isIso(v.dueAt) || !optIso(v.firedAt) || !optIso(v.settledAt)) return null;
  if (typeof v.outcome !== 'string' || !OUTCOMES.has(v.outcome)) return null;
  if (v.reason !== undefined && (typeof v.reason !== 'string' || v.reason.length > REASON_MAX)) return null;
  if (!optTrue(v.offered) || !optTrue(v.final) || !optCount(v.retries)) return null;
  const r: WakeRun = { slot: v.slot, dueAt: v.dueAt, outcome: v.outcome as WakeRunOutcome };
  if (v.firedAt) r.firedAt = v.firedAt as string;
  if (v.settledAt) r.settledAt = v.settledAt as string;
  if (v.reason) r.reason = v.reason;
  if (v.offered) r.offered = true;
  if (v.final) r.final = true;
  if (v.retries !== undefined) r.retries = v.retries as number;
  return r;
}

function cleanDefer(v: unknown): WakeDefer | null {
  if (!isObj(v)) return null;
  if (!isIso(v.dueAt) || !isIso(v.first) || !isIso(v.last) || !isCount(v.count)) return null;
  if (typeof v.kind !== 'string' || !DEFER_KINDS.has(v.kind)) return null;
  return { dueAt: v.dueAt, kind: v.kind as WakeDeferKind, first: v.first, last: v.last, count: v.count };
}

function cleanCounters(v: unknown): WakeCounters | null {
  if (!isObj(v)) return null;
  const c = emptyCounters();
  for (const k of ['fires', 'ok', 'errors', 'cancelled', 'interrupted', 'offered', 'firesSinceHuman'] as const) {
    if (!isCount(v[k])) return null;
    c[k] = v[k] as number;
  }
  if (!optIso(v.humanAnchor)) return null;
  if (v.humanAnchor) c.humanAnchor = v.humanAnchor as string;
  return c;
}

function cleanPending(v: unknown): WakePendingRun | null {
  if (!isObj(v)) return null;
  if (!isCount(v.slot) || !isIso(v.dueAt) || !isIso(v.firedAt)) return null;
  if (v.offerBaseline !== null && !isIso(v.offerBaseline)) return null;
  if (!optTrue(v.final) || !optCount(v.retries)) return null;
  const p: WakePendingRun = { slot: v.slot, dueAt: v.dueAt, firedAt: v.firedAt, offerBaseline: v.offerBaseline as string | null };
  if (v.final) p.final = true;
  if (v.retries !== undefined) p.retries = v.retries as number;
  return p;
}

/**
 * Validate the history fields of an imported wake. Each malformed group
 * (history, defers, counters, pending run, timestamps) is dropped; valid
 * groups are rebuilt with known keys only. The rest of the wake is untouched.
 */
export function sanitizeWakeHistory(w: WakeState): WakeState {
  const next: WakeState = { ...w };
  const raw = w as unknown as Record<string, unknown>;

  if (raw.history !== undefined) {
    const h = Array.isArray(raw.history) && raw.history.length <= WAKE_HISTORY_MAX_RUNS ? raw.history.map(cleanRun) : null;
    if (h && h.every((r): r is WakeRun => r !== null) && historyBytes(h) <= WAKE_HISTORY_MAX_BYTES) next.history = h;
    else { delete next.history; delete next.historySince; }
  }
  if (raw.defers !== undefined) {
    const d = Array.isArray(raw.defers) && raw.defers.length <= WAKE_DEFER_MAX ? raw.defers.map(cleanDefer) : null;
    if (d && d.every((x): x is WakeDefer => x !== null)) next.defers = d; else delete next.defers;
  }
  if (raw.counters !== undefined) {
    const c = cleanCounters(raw.counters);
    if (c) next.counters = c; else delete next.counters;
  }
  if (raw.pendingRun !== undefined) {
    const p = cleanPending(raw.pendingRun);
    if (p) next.pendingRun = p; else delete next.pendingRun;
  }
  for (const k of ['lastOkAt', 'lastOfferedAt', 'historySince'] as const) {
    if (next[k] !== undefined && !isIso(next[k])) delete next[k];
  }
  const maxSlot = Math.max(0, ...(next.history ?? []).map(r => r.slot), next.pendingRun?.slot ?? 0);
  if (raw.slotSeq !== undefined || maxSlot > 0) {
    next.slotSeq = isCount(raw.slotSeq) ? Math.max(raw.slotSeq, maxSlot) : maxSlot;
  }
  return next;
}
