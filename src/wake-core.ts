/**
 * Pure logic for session self-wakes (spec-session-wake): the active-hours
 * window, the per-tick decision, and the wake prompt. No I/O, so every rule is
 * unit-testable with a fixed clock.
 */

import type { WakeState } from './session-meta-store.js';

export interface WakeWindow {
  /** 0 = Sunday ... 6 = Saturday. */
  days: Set<number>;
  startMin: number;
  endMin: number;
  /** IANA zone; undefined = server-local. */
  timeZone?: string;
}

/** `null` = always open. */
export type WakeWindowSpec = WakeWindow | null;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayIndex(name: string): number {
  const i = DAY_NAMES.findIndex(d => d.toLowerCase() === name.slice(0, 3).toLowerCase());
  if (i < 0) throw new Error(`unknown day "${name}"`);
  return i;
}

function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad time "${s}"`);
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) throw new Error(`bad time "${s}"`);
  return h * 60 + mi;
}

function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Parse `CACO_WAKE_WINDOW`: `always`, or `<days> HH:MM-HH:MM [IANA zone]` where
 * days is a comma list of names or ranges (`Mon-Fri`, `Sat,Sun`, `Mon-Sun`).
 * Throws on anything else; the caller falls back to the default.
 */
export function parseWakeWindow(spec: string): WakeWindowSpec {
  const s = spec.trim();
  if (s.toLowerCase() === 'always') return null;
  const parts = s.split(/\s+/);
  if (parts.length < 2 || parts.length > 3) throw new Error('expected "<days> HH:MM-HH:MM [zone]"');
  const days = new Set<number>();
  for (const chunk of parts[0].split(',')) {
    const [a, b] = chunk.split('-');
    const from = dayIndex(a);
    const to = b === undefined ? from : dayIndex(b);
    for (let d = from; ; d = (d + 1) % 7) { days.add(d); if (d === to) break; }
  }
  const [startS, endS] = parts[1].split('-');
  if (!endS) throw new Error('expected HH:MM-HH:MM');
  const startMin = parseHHMM(startS), endMin = parseHHMM(endS);
  if (endMin <= startMin) throw new Error('window must end after it starts (no overnight windows)');
  const timeZone = parts[2];
  if (timeZone && !isValidTimeZone(timeZone)) throw new Error(`unknown time zone "${timeZone}"`);
  return { days, startMin, endMin, ...(timeZone && { timeZone }) };
}

export interface ZonedParts { y: number; mo: number; d: number; h: number; mi: number; dow: number }

export function zonedParts(ms: number, timeZone?: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, dow: dayIndex(p.weekday) };
}

/** The UTC instant of a wall-clock time in `timeZone` (two-pass offset fix for DST). */
function zonedToUtc(y: number, mo: number, d: number, minutes: number, timeZone?: string): number {
  const guess = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  const offsetAt = (ms: number) => {
    const z = zonedParts(ms, timeZone);
    return Date.UTC(z.y, z.mo - 1, z.d, z.h, z.mi) - Math.floor(ms / 60000) * 60000;
  };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return t;
}

/** The zone wake times are read in: the window's zone, else server-local. */
export function wakeTimeZone(win: WakeWindowSpec): string {
  return win?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Human form of a window, e.g. "Mon-Fri 07:00-19:00 America/Los_Angeles". */
export function describeWindow(win: WakeWindowSpec): string {
  if (!win) return 'always';
  const days = DAY_NAMES.filter((_, i) => win.days.has(i)).join(',');
  const hm = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
  return `${days} ${hm(win.startMin)}-${hm(win.endMin)} ${wakeTimeZone(win)}`;
}

/** Local wall-clock form of an instant in `timeZone`, e.g. "Wed 2026-11-11 14:30". */
export function formatZoned(ms: number, timeZone?: string): string {
  const z = zonedParts(ms, timeZone);
  return `${DAY_NAMES[z.dow]} ${z.y}-${pad2(z.mo)}-${pad2(z.d)} ${pad2(z.h)}:${pad2(z.mi)}`;
}

/** How far ahead a first wake may be set. */
export const WAKE_AT_MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolve the optional first-wake time of `caco_wake set`.
 *
 * Accepts `HH:MM` (24h; the next occurrence, today or tomorrow),
 * `YYYY-MM-DDTHH:MM` (wall clock), both in `timeZone`, or an ISO 8601 instant
 * with `Z` or an offset. It must be in the future, within 7 days, and inside
 * the active window: a wake outside the window would be silently deferred, so
 * the caller is told now instead.
 */
export function resolveWakeAt(at: string, nowMs: number, win: WakeWindowSpec): { ok: true; ms: number } | { ok: false; error: string } {
  const tz = wakeTimeZone(win);
  const s = at.trim();
  let ms: number;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec(s);
  if (hm) {
    const h = Number(hm[1]), mi = Number(hm[2]);
    if (h > 23 || mi > 59) return { ok: false, error: `at "${at}" is not a valid 24h time.` };
    const z = zonedParts(nowMs, tz);
    ms = zonedToUtc(z.y, z.mo, z.d, h * 60 + mi, tz);
    if (ms <= nowMs) {
      const t = new Date(Date.UTC(z.y, z.mo - 1, z.d + 1));
      ms = zonedToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), h * 60 + mi, tz);
    }
  } else if (local) {
    const h = Number(local[4]), mi = Number(local[5]);
    if (h > 23 || mi > 59) return { ok: false, error: `at "${at}" is not a valid time.` };
    ms = zonedToUtc(Number(local[1]), Number(local[2]), Number(local[3]), h * 60 + mi, tz);
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    ms = Date.parse(s);
  } else {
    return { ok: false, error: `at must be "HH:MM", "YYYY-MM-DDTHH:MM" (both ${tz}), or an ISO time with an offset.` };
  }
  if (!Number.isFinite(ms)) return { ok: false, error: `at "${at}" is not a valid time.` };
  if (ms <= nowMs) return { ok: false, error: `at ${formatZoned(ms, tz)} ${tz} is in the past.` };
  if (ms - nowMs > WAKE_AT_MAX_AHEAD_MS) return { ok: false, error: 'at must be within 7 days.' };
  if (!inWindow(ms, win)) {
    return { ok: false, error: `at ${formatZoned(ms, tz)} ${tz} is outside the active wake window (${describeWindow(win)}). Pick a time inside it.` };
  }
  return { ok: true, ms };
}

export function inWindow(nowMs: number, win: WakeWindowSpec): boolean {
  if (!win) return true;
  const z = zonedParts(nowMs, win.timeZone);
  const m = z.h * 60 + z.mi;
  return win.days.has(z.dow) && m >= win.startMin && m < win.endMin;
}

/** The next window start strictly after `nowMs`. */
export function nextWindowStart(nowMs: number, win: WakeWindow): number {
  const z = zonedParts(nowMs, win.timeZone);
  for (let i = 0; i <= 7; i++) {
    const day = new Date(Date.UTC(z.y, z.mo - 1, z.d + i));
    const dow = day.getUTCDay();
    if (!win.days.has(dow)) continue;
    const t = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), win.startMin, win.timeZone);
    if (t > nowMs) return t;
  }
  throw new Error('wake window has no open days');
}

export interface WakeDecisionInput {
  wake: WakeState;
  nowMs: number;
  /** meta.lastUsedAt: the last human message or steer. */
  lastHumanAt?: string;
  busy: boolean;
  runningCount: number;
  window: WakeWindowSpec;
  expireMs: number;
  humanQuietMs: number;
  maxRunning: number;
}

export type WakeDecision =
  | { kind: 'paused' }
  | { kind: 'running' }
  | { kind: 'not-due' }
  | { kind: 'defer-window'; nextAtMs: number }
  | { kind: 'defer-busy' }
  | { kind: 'defer-human' }
  | { kind: 'defer-concurrency' }
  | { kind: 'fire'; final: boolean };

/** Expiry keys on human activity only: an agent re-arming its own wake must not
 *  extend it. `registeredAt` is the fallback for a session no human ever wrote to. */
export function isExpired(wake: WakeState, lastHumanAt: string | undefined, nowMs: number, expireMs: number): boolean {
  const anchor = Date.parse(lastHumanAt ?? wake.registeredAt);
  return Number.isFinite(anchor) && nowMs - anchor > expireMs;
}

/** What to do with one wake at a tick. Deferrals other than the window never
 *  move `nextWakeAt`: the next tick simply asks again. */
export function decideWake(i: WakeDecisionInput): WakeDecision {
  const w = i.wake;
  if (w.pausedReason) return { kind: 'paused' };
  if (w.lastResult === 'running') return { kind: 'running' };
  if (Date.parse(w.nextWakeAt) > i.nowMs) return { kind: 'not-due' };
  if (i.window && !inWindow(i.nowMs, i.window)) return { kind: 'defer-window', nextAtMs: nextWindowStart(i.nowMs, i.window) };
  if (i.busy) return { kind: 'defer-busy' };
  if (i.lastHumanAt && i.nowMs - Date.parse(i.lastHumanAt) < i.humanQuietMs) return { kind: 'defer-human' };
  if (i.runningCount >= i.maxRunning) return { kind: 'defer-concurrency' };
  return { kind: 'fire', final: isExpired(w, i.lastHumanAt, i.nowMs, i.expireMs) };
}

export function formatElapsed(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatLocalTime(ms: number, timeZone?: string): string {
  const z = zonedParts(ms, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${DAY_NAMES[z.dow]} ${z.y}-${pad(z.mo)}-${pad(z.d)} ${pad(z.h)}:${pad(z.mi)}${timeZone ? ` ${timeZone}` : ''}`;
}

export function buildWakePrompt(o: { nowMs: number; wake: WakeState; final: boolean; timeZone?: string; expireDays: number }): string {
  const since = o.wake.lastWakeAt
    ? `Last wake ${formatElapsed(o.nowMs - Date.parse(o.wake.lastWakeAt))} ago.`
    : `Registered ${formatElapsed(o.nowMs - Date.parse(o.wake.registeredAt))} ago.`;
  const lines = [`Scheduled wake. Local time ${formatLocalTime(o.nowMs, o.timeZone)}. ${since}`];
  if (o.wake.note) lines.push(`Note: ${o.wake.note}`);
  if (o.final) {
    lines.push(
      `This is the FINAL wake: nobody has messaged this session for ${o.expireDays} days, so wakes pause after this turn unless renewed.`,
      'Check once more, then end your reply with a caco-actions block offering to keep waiting (for example "Keep waiting on <what you wait for>").',
      'If the user asks you to keep waiting, call caco_wake with action "set" again.',
    );
  } else {
    lines.push(
      'Check whether what you are waiting on has changed.',
      'If you are no longer waiting on external data, call caco_wake with action "clear" to stop these wakes.',
    );
  }
  return lines.join('\n');
}

/** The wire shape of a wake for the session list and `/api/wakes`. */
export interface WakeSummary {
  everyHours: number;
  nextWakeAt: string;
  note?: string;
  lastWakeAt?: string;
  lastResult?: WakeState['lastResult'];
  lastError?: string;
  pausedReason?: WakeState['pausedReason'];
  /** The session is staged in auto-archive: the wake is suspended and would
   *  resume if the session were moved out. */
  archived?: true;
}

export function summarizeWake(w: WakeState, archived = false): WakeSummary {
  const s: WakeSummary = { everyHours: w.everyMinutes / 60, nextWakeAt: w.nextWakeAt };
  if (archived) s.archived = true;
  if (w.note) s.note = w.note;
  if (w.lastWakeAt) s.lastWakeAt = w.lastWakeAt;
  if (w.lastResult) s.lastResult = w.lastResult;
  if (w.lastError) s.lastError = w.lastError;
  if (w.pausedReason) s.pausedReason = w.pausedReason;
  return s;
}
