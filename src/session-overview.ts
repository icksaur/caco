/**
 * Session overview (spec-session-overview, r6: facts only) — pure.
 *
 * Inputs are what the read-only collector gathered (`session-overview-io.ts`)
 * plus `now`; the output is one entry per non-archived session with facts Caco
 * can compute exactly: why it may move again (`waits`), offer, busy, retry,
 * wake, schedule, herd and last-event context. No judgments: the consumer (an
 * LLM) classifies. Order is last activity descending, then key. `show` only
 * decides what is returned, and omissions are counted. No I/O, no clock.
 */

import type { SessionKind, SessionMeta, WakeState, WakeCounters, WakeRun, WakeDefer, WakePendingRun } from './session-meta-store.js';
import type { LastContext, TailResult } from './sdk-session-tail.js';
import { needsTriage, offerAtOf, PAGER_MAX_OFFER_AGE_MS, type PagerSessionInput } from './pager-view.js';
import { isExpired } from './wake-core.js';

export const OVERVIEW_SCHEMA_VERSION = 2;

export type WaitReason =
  | { kind: 'turn-running' }
  | { kind: 'retry-pending'; attempt: number }
  | { kind: 'user-offer' }
  | { kind: 'wake'; nextAt: string }
  | { kind: 'wake-running' }
  | { kind: 'children'; busy: number }
  | { kind: 'schedule'; nextRun: string };

export interface WakeOverview {
  everyHours: number;
  registeredAt: string;
  nextWakeAt: string;
  /** The next fire will be the final one under the expiry rule (loop enabled, not paused). */
  nextIsFinal?: true;
  note?: string;
  lastWakeAt?: string;
  lastResult?: WakeState['lastResult'];
  lastError?: string;
  pausedReason?: WakeState['pausedReason'];
  finalWakeAt?: string;
  consecutiveFailures: number;
  slotSeq: number;
  counters: WakeCounters;
  lastOkAt?: string;
  lastOfferedAt?: string;
  historySince?: string;
  /** Newest last. */
  history: WakeRun[];
  defers: WakeDefer[];
  pendingRun?: WakePendingRun;
}

export interface OverviewEntry {
  key: string;
  instance: { id: string; name: string };
  sessionId: string;
  title: string;
  titleSource: 'name' | 'workspace-summary' | 'auto-name' | 'none';
  kind: SessionKind;
  folder?: string;
  cwd: string | null;
  hidden?: 'herd-child' | 'agent';
  activity: 'busy' | 'idle';
  busy?: { since: string; pendingTools?: number; currentIntent?: string };
  waits: WaitReason[];
  offer?: { options: string[]; at: string | null; dismissed: boolean; ageMs: number | null; onPager: boolean };
  wake?: WakeOverview;
  schedule?: { slug: string; enabled: boolean; nextRun: string | null; lastResult?: string };
  herd?: { parent?: string; parentState?: 'ok' | 'missing' | 'archived'; children?: number; busyChildren?: number };
  /** Hub merge only: names (or short ids) of other instances reporting the same session id. */
  duplicateOn?: string[];
  lastHumanAt?: string;
  /** max(context.lastEventAt, lastHumanAt, workspace updatedAt); used for ordering. */
  lastActivityAt?: string;
  context: LastContext;
}

/** One session as gathered by the collector. */
export interface OverviewSessionInput {
  sessionId: string;
  cwd: string | null;
  meta: Partial<Pick<SessionMeta,
    'name' | 'autoName' | 'kind' | 'folder' | 'orchestratedBy' | 'responseOptions' | 'responseOptionsAt'
    | 'pagerDismissedAt' | 'lastIdleAt' | 'lastUsedAt' | 'wake'>> | null;
  workspace?: { summary?: string; updatedAt?: string } | null;
  /** Epoch ms the active dispatch started; null/undefined = idle. */
  busySince?: number | null;
  pendingTools?: number;
  currentIntent?: string;
  /** Pending transient retry attempt; undefined = none pending. */
  retryAttempt?: number;
  schedule?: { slug: string; enabled: boolean; nextRun: string | null; lastResult?: string };
  /** Absent for archived sessions (not read) or when context was not requested. */
  tail?: TailResult;
}

export interface OverviewInputs {
  instance: { id: string; name: string };
  sessions: OverviewSessionInput[];
  archiveFolder: string;
  /** False while caco_wake is hard-disabled: armed wakes will not fire. */
  wakeLoopEnabled: boolean;
  /** The wake expiry window (CACO_WAKE_EXPIRE_MS), for `wake.nextIsFinal`. Default 7 days. */
  wakeExpireMs?: number;
  /** False when the caller asked for `context: 'none'`: no tail was read. */
  contextRead: boolean;
}

export type OverviewShow = 'all' | 'busy' | 'wakes' | 'waiting';
export const OVERVIEW_SHOWS: readonly OverviewShow[] = ['all', 'busy', 'wakes', 'waiting'];

export interface OverviewOptions {
  show?: OverviewShow;
  /** `instanceId:sessionId` or bare session ids. */
  keys?: string[];
}

export interface SessionOverview {
  schemaVersion: number;
  instance: { id: string; name: string };
  generatedAt: string;
  show: OverviewShow;
  /** False while caco_wake is hard-disabled: armed wakes will not fire. */
  wakeLoopEnabled: boolean;
  counts: {
    /** Non-archived sessions collected. */
    total: number;
    shown: number;
    omitted: number;
    /** Sessions in the auto-archive folder: not collected (v1). */
    archivedExcluded: number;
  };
  entries: OverviewEntry[];
}

const DEFAULT_WAKE_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;

const ms = (v: string | undefined | null): number | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const iso = (t: number) => new Date(t).toISOString();
const hasText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function emptyCounters(): WakeCounters {
  return { fires: 0, ok: 0, errors: 0, cancelled: 0, interrupted: 0, offered: 0, firesSinceHuman: 0 };
}

export function wakeOverview(w: WakeState): WakeOverview {
  const o: WakeOverview = {
    everyHours: w.everyMinutes / 60,
    registeredAt: w.registeredAt,
    nextWakeAt: w.nextWakeAt,
    consecutiveFailures: w.consecutiveFailures ?? 0,
    slotSeq: w.slotSeq ?? 0,
    counters: { ...emptyCounters(), ...w.counters },
    history: (w.history ?? []).map(r => ({ ...r })),
    defers: (w.defers ?? []).map(d => ({ ...d })),
  };
  if (w.note) o.note = w.note;
  if (w.lastWakeAt) o.lastWakeAt = w.lastWakeAt;
  if (w.lastResult) o.lastResult = w.lastResult;
  if (w.lastError) o.lastError = w.lastError;
  if (w.pausedReason) o.pausedReason = w.pausedReason;
  if (w.finalWakeAt) o.finalWakeAt = w.finalWakeAt;
  if (w.lastOkAt) o.lastOkAt = w.lastOkAt;
  if (w.lastOfferedAt) o.lastOfferedAt = w.lastOfferedAt;
  if (w.historySince) o.historySince = w.historySince;
  if (w.pendingRun) o.pendingRun = { ...w.pendingRun };
  return o;
}

function titleOf(i: OverviewSessionInput): Pick<OverviewEntry, 'title' | 'titleSource'> {
  if (hasText(i.meta?.name)) return { title: i.meta!.name!, titleSource: 'name' };
  if (hasText(i.workspace?.summary)) return { title: i.workspace!.summary!, titleSource: 'workspace-summary' };
  if (hasText(i.meta?.autoName)) return { title: i.meta!.autoName!, titleSource: 'auto-name' };
  return { title: 'No summary', titleSource: 'none' };
}

function maxIso(...vals: Array<string | undefined>): string | undefined {
  let best: number | null = null;
  for (const v of vals) {
    const t = ms(v);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best === null ? undefined : iso(best);
}

function describeOne(
  i: OverviewSessionInput, inputs: OverviewInputs, now: number,
  byId: Map<string, OverviewSessionInput>, children: Map<string, OverviewSessionInput[]>,
): OverviewEntry {
  const meta: NonNullable<OverviewSessionInput['meta']> = i.meta ?? {};
  const kind: SessionKind = meta.kind ?? 'interactive';
  const busy = typeof i.busySince === 'number';
  const entry: OverviewEntry = {
    key: `${inputs.instance.id}:${i.sessionId}`,
    instance: { ...inputs.instance },
    sessionId: i.sessionId,
    ...titleOf(i),
    kind,
    cwd: i.cwd,
    activity: busy ? 'busy' : 'idle',
    waits: [],
    context: i.tail?.context ?? (inputs.contextRead ? { status: 'unavailable', errorCode: 'not-collected' } : { status: 'not-read' }),
  };
  if (meta.folder) entry.folder = meta.folder;
  if (meta.orchestratedBy) entry.hidden = 'herd-child';
  else if (kind === 'agent') entry.hidden = kind;
  if (meta.lastUsedAt) entry.lastHumanAt = meta.lastUsedAt;
  const lastActivityAt = maxIso(entry.context.lastEventAt, meta.lastUsedAt, i.workspace?.updatedAt);
  if (lastActivityAt) entry.lastActivityAt = lastActivityAt;

  if (busy) {
    entry.busy = { since: iso(i.busySince as number) };
    if (i.pendingTools) entry.busy.pendingTools = i.pendingTools;
    if (i.currentIntent) entry.busy.currentIntent = i.currentIntent;
    entry.waits.push({ kind: 'turn-running' });
  }
  if (i.retryAttempt !== undefined) entry.waits.push({ kind: 'retry-pending', attempt: i.retryAttempt });

  // Offer facts, separate from pager visibility.
  const options = meta.responseOptions ?? [];
  if (options.length > 0) {
    const pagerInput: PagerSessionInput = {
      sessionId: i.sessionId, name: meta.name ?? '', cwd: i.cwd, kind, isBusy: busy,
      orchestratedBy: meta.orchestratedBy, responseOptions: options,
      responseOptionsAt: meta.responseOptionsAt, pagerDismissedAt: meta.pagerDismissedAt, lastIdleAt: meta.lastIdleAt,
    };
    const at = offerAtOf(pagerInput);
    const dismissedAt = ms(meta.pagerDismissedAt);
    const dismissed = at !== null && dismissedAt !== null && at <= dismissedAt;
    const ageMs = at === null ? null : now - at;
    entry.offer = { options: [...options], at: at === null ? null : iso(at), dismissed, ageMs, onPager: needsTriage(pagerInput, now) };
    if (!dismissed && ageMs !== null && ageMs <= PAGER_MAX_OFFER_AGE_MS && !busy) entry.waits.push({ kind: 'user-offer' });
  }

  const w = meta.wake;
  if (w) {
    entry.wake = wakeOverview(w);
    // An armed wake only moves the session while the wake loop runs; a turn
    // already running settles on its own.
    if (w.lastResult === 'running') entry.waits.push({ kind: 'wake-running' });
    else if (!w.pausedReason && inputs.wakeLoopEnabled) entry.waits.push({ kind: 'wake', nextAt: w.nextWakeAt });
    if (!w.finalWakeAt && !w.pausedReason && inputs.wakeLoopEnabled
      && isExpired(w, meta.lastUsedAt, ms(w.nextWakeAt) ?? now, inputs.wakeExpireMs ?? DEFAULT_WAKE_EXPIRE_MS)) {
      entry.wake.nextIsFinal = true;
    }
  }

  if (i.schedule) {
    entry.schedule = { ...i.schedule };
    if (i.schedule.enabled && i.schedule.nextRun) entry.waits.push({ kind: 'schedule', nextRun: i.schedule.nextRun });
  }

  if (meta.orchestratedBy) {
    const parent = byId.get(meta.orchestratedBy);
    const parentState = !parent ? 'missing' : parent.meta?.folder === inputs.archiveFolder ? 'archived' : 'ok';
    entry.herd = { parent: meta.orchestratedBy, parentState };
  }
  const kids = (children.get(i.sessionId) ?? []).filter(k => k.meta?.folder !== inputs.archiveFolder);
  if (kids.length > 0) {
    const busyKids = kids.filter(k => typeof k.busySince === 'number').length;
    entry.herd = { ...entry.herd, children: kids.length, busyChildren: busyKids };
    if (busyKids > 0) entry.waits.push({ kind: 'children', busy: busyKids });
  }
  return entry;
}

/** The one order: last activity descending (missing sorts oldest), then key ascending. */
export function compareEntries(a: OverviewEntry, b: OverviewEntry): number {
  const ta = ms(a.lastActivityAt) ?? Number.NEGATIVE_INFINITY;
  const tb = ms(b.lastActivityAt) ?? Number.NEGATIVE_INFINITY;
  if (ta !== tb) return tb > ta ? 1 : -1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function matchesShow(e: OverviewEntry, show: OverviewShow): boolean {
  switch (show) {
    case 'all': return true;
    case 'busy': return e.activity === 'busy';
    case 'wakes': return !!e.wake;
    case 'waiting': return e.activity === 'idle' && (e.waits.length > 0 || !!e.offer);
  }
}

function matchesKeys(e: OverviewEntry, keys: string[] | undefined): boolean {
  if (!keys || keys.length === 0) return true;
  return keys.some(k => k === e.key || k === e.sessionId);
}

function filterAndCount(all: OverviewEntry[], show: OverviewShow, keys: string[] | undefined) {
  const shown = all.filter(e => matchesShow(e, show) && matchesKeys(e, keys));
  return { shown, counts: { total: all.length, shown: shown.length, omitted: all.length - shown.length } };
}

/**
 * Hub merge (scope=all): combine unfiltered (`show: 'all'`) overviews from
 * several instances, set `duplicateOn` on every copy of a session id seen on
 * more than one instance, order with `compareEntries` (so peer arrival order
 * never matters), then filter and count.
 */
export function mergeSessionOverviews(
  parts: SessionOverview[],
  opts: { show?: OverviewShow; keys?: string[] } = {},
): { entries: OverviewEntry[]; counts: SessionOverview['counts'] } {
  const show = opts.show ?? 'all';
  const all: OverviewEntry[] = parts.flatMap(p => p.entries.map(e => {
    const copy = { ...e };
    delete copy.duplicateOn;
    return copy;
  }));
  const bySession = new Map<string, OverviewEntry[]>();
  for (const e of all) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e]);
  for (const copies of bySession.values()) {
    if (new Set(copies.map(e => e.instance.id)).size < 2) continue;
    for (const e of copies) {
      const others = copies.filter(o => o.instance.id !== e.instance.id).map(o => o.instance.name || o.instance.id.slice(0, 8));
      e.duplicateOn = [...new Set(others)].sort();
    }
  }
  all.sort(compareEntries);
  const { shown, counts } = filterAndCount(all, show, opts.keys);
  return {
    entries: shown,
    counts: { ...counts, archivedExcluded: parts.reduce((n, p) => n + (p.counts.archivedExcluded ?? 0), 0) },
  };
}

/** Describe every non-archived session the session list shows, then filter what is returned. */
export function buildSessionOverview(inputs: OverviewInputs, now: number, opts: OverviewOptions = {}): SessionOverview {
  const show = opts.show ?? 'all';
  const byId = new Map(inputs.sessions.map(s => [s.sessionId, s]));
  const children = new Map<string, OverviewSessionInput[]>();
  for (const s of inputs.sessions) {
    const p = s.meta?.orchestratedBy;
    if (p) children.set(p, [...(children.get(p) ?? []), s]);
  }
  const unarchived = inputs.sessions.filter(s => s.meta?.folder !== inputs.archiveFolder);
  // Same rule as the session list: a session with no cwd is not listed in the UI.
  const live = unarchived.filter(s => s.cwd && s.cwd !== '(unknown)');
  const all = live.map(s => describeOne(s, inputs, now, byId, children)).sort(compareEntries);
  const { shown, counts } = filterAndCount(all, show, opts.keys);
  return {
    schemaVersion: OVERVIEW_SCHEMA_VERSION,
    instance: { ...inputs.instance },
    generatedAt: iso(now),
    show,
    wakeLoopEnabled: inputs.wakeLoopEnabled,
    counts: { ...counts, archivedExcluded: inputs.sessions.length - unarchived.length },
    entries: shown,
  };
}
