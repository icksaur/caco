/**
 * Session overview classifier (spec-session-overview) — pure.
 *
 * Inputs are what the read-only collector gathered (`session-overview-io.ts`)
 * plus `now`; the output is one entry per non-archived session with its wait
 * reasons, flags, tier and a deterministic order. Every session is classified
 * first; `show` only decides what is returned, and omissions are counted.
 * No I/O, no clock, no env reads except through `overviewThresholdsFromEnv`.
 */

import type { SessionKind, SessionMeta, WakeState, WakeCounters, WakeRun, WakeDefer, WakePendingRun } from './session-meta-store.js';
import type { LastContext, AskVerdict, TailResult } from './sdk-session-tail.js';
import { needsTriage, offerAtOf, PAGER_MAX_OFFER_AGE_MS, type PagerSessionInput } from './pager-view.js';
import { isExpired, zonedParts } from './wake-core.js';

export const OVERVIEW_SCHEMA_VERSION = 1;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface OverviewThresholds {
  offerStaleMs: number;
  wakeQuietFires: number;
  wakeQuietOfferMs: number;
  wakeFailing: number;
  wakeOverdueCadences: number;
  wakeDeferredLongMs: number;
  busyLongMs: number;
  retryExhaustingAttempt: number;
  humanRecentMs: number;
  /** The wake expiry window (CACO_WAKE_EXPIRE_MS), for `wake-expiring`. */
  wakeExpireMs: number;
}

export const DEFAULT_OVERVIEW_THRESHOLDS: OverviewThresholds = {
  offerStaleMs: 2 * DAY,
  wakeQuietFires: 6,
  wakeQuietOfferMs: 7 * DAY,
  wakeFailing: 2,
  wakeOverdueCadences: 2,
  wakeDeferredLongMs: DAY,
  busyLongMs: HOUR,
  retryExhaustingAttempt: 5,
  humanRecentMs: 30 * MIN,
  wakeExpireMs: 7 * DAY,
};

const ENV_KEYS: Record<keyof OverviewThresholds, string> = {
  offerStaleMs: 'CACO_OVERVIEW_OFFER_STALE_MS',
  wakeQuietFires: 'CACO_OVERVIEW_WAKE_QUIET_FIRES',
  wakeQuietOfferMs: 'CACO_OVERVIEW_WAKE_QUIET_OFFER_MS',
  wakeFailing: 'CACO_OVERVIEW_WAKE_FAILING',
  wakeOverdueCadences: 'CACO_OVERVIEW_WAKE_OVERDUE_CADENCES',
  wakeDeferredLongMs: 'CACO_OVERVIEW_WAKE_DEFERRED_LONG_MS',
  busyLongMs: 'CACO_OVERVIEW_BUSY_LONG_MS',
  retryExhaustingAttempt: 'CACO_OVERVIEW_RETRY_EXHAUSTING_ATTEMPT',
  humanRecentMs: 'CACO_OVERVIEW_HUMAN_RECENT_MS',
  wakeExpireMs: 'CACO_WAKE_EXPIRE_MS',
};

/** Defaults overridden by positive numeric env values. */
export function overviewThresholdsFromEnv(env: Record<string, string | undefined>): OverviewThresholds {
  const t = { ...DEFAULT_OVERVIEW_THRESHOLDS };
  for (const k of Object.keys(ENV_KEYS) as Array<keyof OverviewThresholds>) {
    const v = Number(env[ENV_KEYS[k]]);
    if (Number.isFinite(v) && v > 0) t[k] = v;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WaitReason =
  | { kind: 'turn-running' }
  | { kind: 'retry-pending'; attempt: number }
  | { kind: 'user-offer' }
  | { kind: 'wake'; nextAt: string }
  | { kind: 'wake-running' }
  | { kind: 'children'; busy: number }
  | { kind: 'schedule'; nextRun: string };

export type OverviewFlagCode =
  | 'awaiting-user-no-offer' | 'no-driver' | 'wake-failing' | 'busy-long' | 'retry-exhausting'
  | 'orphan-child' | 'offer-stale' | 'wake-overdue' | 'wake-paused' | 'wake-expiring'
  | 'wake-quiet-long' | 'wake-deferred-long' | 'duplicate-session' | 'context-unavailable'
  | 'children-stuck' | 'offer-dismissed-no-driver' | 'wake-note-dated' | 'human-recent' | 'wake-loop-disabled';

export interface OverviewFlag {
  code: OverviewFlagCode;
  detail: string;
  confidence: 'high' | 'low' | 'info';
}

/** Fixed primary-flag rank (spec, Tool: Ordering). `no-driver` appears twice:
 *  high confidence ranks second, low confidence near the end. */
export const FLAG_RANK: ReadonlyArray<{ code: OverviewFlagCode; confidence?: 'high' | 'low' }> = [
  { code: 'awaiting-user-no-offer' },
  { code: 'no-driver', confidence: 'high' },
  { code: 'wake-failing' },
  { code: 'busy-long' },
  { code: 'retry-exhausting' },
  { code: 'orphan-child' },
  { code: 'offer-stale' },
  { code: 'wake-overdue' },
  { code: 'wake-paused' },
  { code: 'wake-expiring' },
  { code: 'wake-quiet-long' },
  { code: 'wake-deferred-long' },
  { code: 'duplicate-session' },
  { code: 'context-unavailable' },
  { code: 'children-stuck' },
  { code: 'offer-dismissed-no-driver' },
  { code: 'no-driver', confidence: 'low' },
  { code: 'wake-note-dated' },
];

export function flagRank(f: OverviewFlag): number {
  if (f.confidence === 'info') return Number.POSITIVE_INFINITY;
  const i = FLAG_RANK.findIndex(r => r.code === f.code && (!r.confidence || r.confidence === f.confidence));
  return i < 0 ? FLAG_RANK.length : i;
}

export interface WakeOverview {
  everyHours: number;
  registeredAt: string;
  nextWakeAt: string;
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
  hidden?: 'herd-child' | 'agent' | 'swarm';
  tier: 'full' | 'compact';
  activity: 'busy' | 'idle';
  busy?: { since: string; pendingTools?: number; currentIntent?: string };
  waits: WaitReason[];
  offer?: { options: string[]; at: string | null; dismissed: boolean; ageMs: number | null; onPager: boolean };
  wake?: WakeOverview;
  schedule?: { slug: string; enabled: boolean; nextRun: string | null; lastResult?: string };
  herd?: { parent?: string; parentState?: 'ok' | 'missing' | 'archived'; children?: number; busyChildren?: number };
  lastHumanAt?: string;
  /** max(context.lastEventAt, lastHumanAt, workspace updatedAt); used for ordering. */
  lastActivityAt?: string;
  context: LastContext;
  /** The reader's ask verdict (spec, Ask heuristic). */
  ask?: AskVerdict;
  flags: OverviewFlag[];
  /** Code of the highest-ranked (FLAG_RANK) non-info flag; absent when unflagged. */
  primaryFlag?: OverviewFlagCode;
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
  /** False while caco_wake is hard-disabled: wakes cannot be overdue then. */
  wakeLoopEnabled: boolean;
  /** Zone for `wake-note-dated` ("today"); undefined = server-local. */
  timeZone?: string;
  /** False when the caller asked for `context: 'none'`: no tail was read. */
  contextRead: boolean;
}

export type OverviewShow = 'all' | 'attention' | 'busy' | 'wakes' | 'waiting';

export interface OverviewOptions {
  show?: OverviewShow;
  /** `instanceId:sessionId` or bare session ids. */
  keys?: string[];
  thresholds?: OverviewThresholds;
}

export interface SessionOverview {
  schemaVersion: number;
  instance: { id: string; name: string };
  generatedAt: string;
  show: OverviewShow;
  /** False while caco_wake is hard-disabled: armed wakes will not fire. */
  wakeLoopEnabled: boolean;
  counts: {
    /** Non-archived sessions classified. */
    total: number;
    shown: number;
    omitted: number;
    /** Omitted sessions with a high or low confidence flag. */
    omittedFlagged: number;
    full: number;
    compact: number;
    /** Sessions in the auto-archive folder: not collected (v1). */
    archivedExcluded: number;
  };
  entries: OverviewEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ms = (v: string | undefined | null): number | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const iso = (t: number) => new Date(t).toISOString();
const hasText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function fmtAge(deltaMs: number): string {
  const m = Math.max(0, Math.round(deltaMs / MIN));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

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

/** Dates in a wake note: ISO `YYYY-MM-DD` or `M/D` (current year). Returns the
 *  first one before `today` (a `YYYY-MM-DD` string in the given zone). */
export function datedNote(note: string, nowMs: number, timeZone?: string): string | null {
  const z = zonedParts(nowMs, timeZone);
  const today = z.y * 10000 + z.mo * 100 + z.d;
  for (const m of note.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const v = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
    if (Number(m[2]) >= 1 && Number(m[2]) <= 12 && v < today) return m[0];
  }
  for (const m of note.matchAll(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/.])/g)) {
    const mo = Number(m[1]), d = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    if (z.y * 10000 + mo * 100 + d < today) return m[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface Draft {
  entry: OverviewEntry;
  input: OverviewSessionInput;
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

function classifyOne(
  i: OverviewSessionInput, inputs: OverviewInputs, now: number, th: OverviewThresholds,
  byId: Map<string, OverviewSessionInput>, children: Map<string, OverviewSessionInput[]>,
): Draft {
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
    tier: 'compact',
    activity: busy ? 'busy' : 'idle',
    waits: [],
    context: i.tail?.context ?? (inputs.contextRead ? { status: 'unavailable', errorCode: 'not-collected' } : { status: 'not-read' }),
    flags: [],
  };
  if (meta.folder) entry.folder = meta.folder;
  if (meta.orchestratedBy) entry.hidden = 'herd-child';
  else if (kind === 'agent' || kind === 'swarm') entry.hidden = kind;
  if (i.tail?.ask) entry.ask = i.tail.ask;
  if (meta.lastUsedAt) entry.lastHumanAt = meta.lastUsedAt;
  const lastActivityAt = maxIso(entry.context.lastEventAt, meta.lastUsedAt, i.workspace?.updatedAt);
  if (lastActivityAt) entry.lastActivityAt = lastActivityAt;

  const flag = (code: OverviewFlagCode, detail: string, confidence: OverviewFlag['confidence'] = 'high') =>
    entry.flags.push({ code, detail, confidence });

  // --- busy / retry
  if (busy) {
    entry.busy = { since: iso(i.busySince as number) };
    if (i.pendingTools) entry.busy.pendingTools = i.pendingTools;
    if (i.currentIntent) entry.busy.currentIntent = i.currentIntent;
    entry.waits.push({ kind: 'turn-running' });
    const age = now - (i.busySince as number);
    if (age > th.busyLongMs) flag('busy-long', `busy for ${fmtAge(age)} since ${entry.busy.since}`);
  }
  if (i.retryAttempt !== undefined) {
    entry.waits.push({ kind: 'retry-pending', attempt: i.retryAttempt });
    if (i.retryAttempt >= th.retryExhaustingAttempt) flag('retry-exhausting', `transient retry attempt ${i.retryAttempt} pending`);
  }

  // --- offer facts (separate from pager visibility)
  const options = meta.responseOptions ?? [];
  let undismissedOffer = false;
  let dismissedOffer = false;
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
    undismissedOffer = !dismissed;
    dismissedOffer = dismissed;
    if (!dismissed && ageMs !== null && ageMs <= PAGER_MAX_OFFER_AGE_MS && !busy) entry.waits.push({ kind: 'user-offer' });
    if (!dismissed && ageMs !== null && ageMs > th.offerStaleMs) {
      flag('offer-stale', `offer from ${entry.offer.at} is ${fmtAge(ageMs)} old${entry.offer.onPager ? '' : ' (off the pager)'}`);
    }
  }

  // --- wake
  const w = meta.wake;
  if (w) {
    entry.wake = wakeOverview(w);
    const c = entry.wake.counters;
    // An armed wake only moves the session while the wake loop runs: with
    // caco_wake hard-disabled the manager never fires, so it is not a wait (and
    // the driver flags below can see the session is stuck). A turn already
    // running still settles on its own.
    if (w.lastResult === 'running') entry.waits.push({ kind: 'wake-running' });
    else if (!w.pausedReason && inputs.wakeLoopEnabled) entry.waits.push({ kind: 'wake', nextAt: w.nextWakeAt });
    else if (!w.pausedReason) {
      flag('wake-loop-disabled', 'caco_wake is disabled on this instance, so this wake will not fire', 'info');
    }

    if (w.consecutiveFailures >= th.wakeFailing || w.pausedReason === 'failures') {
      flag('wake-failing', `${w.consecutiveFailures} failures in a row${w.lastError ? `, last: ${w.lastError}` : ''}${w.pausedReason === 'failures' ? ', paused' : ''}`);
    }
    if (w.pausedReason === 'expired' || w.pausedReason === 'imported') flag('wake-paused', `paused: ${w.pausedReason}`);
    if (w.finalWakeAt) flag('wake-expiring', `final wake fired at ${w.finalWakeAt}`);
    else if (!w.pausedReason && inputs.wakeLoopEnabled && isExpired(w, meta.lastUsedAt, ms(w.nextWakeAt) ?? now, th.wakeExpireMs)) {
      flag('wake-expiring', `next wake at ${w.nextWakeAt} will be the final one`);
    }
    const next = ms(w.nextWakeAt);
    const cadence = w.everyMinutes * MIN;
    if (inputs.wakeLoopEnabled && !w.pausedReason && w.lastResult !== 'running' && next !== null
      && now - next > th.wakeOverdueCadences * cadence) {
      flag('wake-overdue', `due ${w.nextWakeAt}, ${fmtAge(now - next)} overdue (cadence ${w.everyMinutes / 60}h)`);
    }
    const defer = w.defers?.find(d => d.dueAt === w.nextWakeAt);
    const firstDefer = ms(defer?.first);
    if (defer && firstDefer !== null && now - firstDefer > th.wakeDeferredLongMs) {
      flag('wake-deferred-long', `deferred (${defer.kind}) ${defer.count} times since ${defer.first}`);
    }
    // Quiet: firing without producing an offer.
    const anchor = ms(c.humanAnchor);
    const lastOffered = ms(w.lastOfferedAt);
    const since = ms(w.historySince);
    const noOfferSinceHuman = lastOffered === null || (anchor !== null && lastOffered <= anchor);
    if (c.firesSinceHuman >= th.wakeQuietFires && noOfferSinceHuman) {
      const covered = since !== null && anchor !== null && since <= anchor;
      flag('wake-quiet-long', `${c.firesSinceHuman} fires since the last human message, no offer${w.lastOfferedAt ? ` (last offer ${w.lastOfferedAt})` : ''}`,
        covered ? 'high' : 'low');
    } else if (c.fires > 0 && (lastOffered === null || now - lastOffered > th.wakeQuietOfferMs)) {
      const covered = since !== null && now - since > th.wakeQuietOfferMs;
      if (covered || lastOffered !== null) {
        flag('wake-quiet-long', `no offer from a wake run ${w.lastOfferedAt ? `since ${w.lastOfferedAt}` : 'in the recorded history'} (history since ${w.historySince ?? 'unknown'})`,
          covered ? 'high' : 'low');
      }
    }
    if (w.note) {
      const d = datedNote(w.note, now, inputs.timeZone);
      if (d) flag('wake-note-dated', `note mentions ${d}, which has passed`, 'low');
    }
  }

  // --- schedule
  if (i.schedule) {
    entry.schedule = { ...i.schedule };
    if (i.schedule.enabled && i.schedule.nextRun) entry.waits.push({ kind: 'schedule', nextRun: i.schedule.nextRun });
  }

  // --- herd
  if (meta.orchestratedBy) {
    const parent = byId.get(meta.orchestratedBy);
    const parentState = !parent ? 'missing' : parent.meta?.folder === inputs.archiveFolder ? 'archived' : 'ok';
    entry.herd = { parent: meta.orchestratedBy, parentState };
    if (parentState !== 'ok') flag('orphan-child', `parent ${meta.orchestratedBy.slice(0, 8)} is ${parentState}`);
  }
  const kids = (children.get(i.sessionId) ?? []).filter(k => k.meta?.folder !== inputs.archiveFolder);
  if (kids.length > 0) {
    const busyKids = kids.filter(k => typeof k.busySince === 'number').length;
    entry.herd = { ...entry.herd, children: kids.length, busyChildren: busyKids };
    if (busyKids > 0) entry.waits.push({ kind: 'children', busy: busyKids });
  }

  // --- drivers (idle, nothing will move it)
  if (!busy && entry.waits.length === 0) {
    const ctx = entry.context;
    const errAt = ms(ctx.lastError?.at);
    const endedInError = errAt !== null
      && errAt >= (ms(ctx.lastUser?.at) ?? 0) && errAt >= (ms(ctx.lastAssistant?.at) ?? 0);
    if (endedInError) {
      flag('no-driver', `idle, nothing will move it; last turn ended in session.error at ${ctx.lastError!.at}`);
    } else if (!undismissedOffer && entry.ask && 'matched' in entry.ask && entry.ask.matched) {
      flag('awaiting-user-no-offer', `last assistant message asks the user ("${entry.ask.matched}") but no offer was made`, 'low');
    }
    if (!endedInError && !undismissedOffer && !dismissedOffer && ctx.lastUser && ctx.lastUser.source !== 'user') {
      flag('no-driver', `idle, nothing will move it; last turn was unattended (${ctx.lastUser.source}) and made no offer`, 'low');
    }
    if (dismissedOffer) flag('offer-dismissed-no-driver', `offer from ${entry.offer!.at} was dismissed; nothing will move it`, 'low');
  }

  if (inputs.contextRead && entry.context.status !== 'ok' && entry.context.status !== 'not-read') {
    flag('context-unavailable', `context ${entry.context.status}${entry.context.errorCode ? ` (${entry.context.errorCode})` : ''}`);
  }

  const human = ms(meta.lastUsedAt);
  if (human !== null && now - human < th.humanRecentMs) {
    flag('human-recent', `human message ${fmtAge(now - human)} ago: do not disturb`, 'info');
  }
  return { entry, input: i };
}

function finish(entry: OverviewEntry): void {
  const real = entry.flags.filter(f => f.confidence !== 'info');
  entry.tier = real.length > 0 || entry.waits.some(w => w.kind === 'user-offer') ? 'full' : 'compact';
  if (real.length > 0) {
    const primary = [...real].sort((a, b) => flagRank(a) - flagRank(b))[0];
    entry.primaryFlag = primary.code;
  } else {
    delete entry.primaryFlag;
  }
}

function primaryRank(e: OverviewEntry): number {
  const real = e.flags.filter(f => f.confidence !== 'info');
  return real.length ? Math.min(...real.map(flagRank)) : Number.POSITIVE_INFINITY;
}

/** Deterministic order: full rows by primary-flag rank, then compact rows;
 *  within a group by last activity descending (missing = oldest), then key. */
export function compareEntries(a: OverviewEntry, b: OverviewEntry): number {
  if (a.tier !== b.tier) return a.tier === 'full' ? -1 : 1;
  if (a.tier === 'full') {
    const ra = primaryRank(a), rb = primaryRank(b);
    if (ra !== rb) return ra - rb;
  }
  const ta = ms(a.lastActivityAt) ?? Number.NEGATIVE_INFINITY;
  const tb = ms(b.lastActivityAt) ?? Number.NEGATIVE_INFINITY;
  if (ta !== tb) return tb > ta ? 1 : -1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

const WAITING_FLAGS = new Set<OverviewFlagCode>(['awaiting-user-no-offer', 'no-driver', 'offer-stale', 'offer-dismissed-no-driver']);

function matchesShow(e: OverviewEntry, show: OverviewShow): boolean {
  switch (show) {
    case 'all': return true;
    case 'attention': return e.tier === 'full';
    case 'busy': return e.activity === 'busy';
    case 'wakes': return !!e.wake;
    case 'waiting':
      return e.activity === 'idle' && (e.waits.length > 0 || e.flags.some(f => WAITING_FLAGS.has(f.code)));
  }
}

function matchesKeys(e: OverviewEntry, keys: string[] | undefined): boolean {
  if (!keys || keys.length === 0) return true;
  return keys.some(k => k === e.key || k === e.sessionId);
}

/** Classify every non-archived session, then filter what is returned. */
export function buildSessionOverview(inputs: OverviewInputs, now: number, opts: OverviewOptions = {}): SessionOverview {
  const th = opts.thresholds ?? DEFAULT_OVERVIEW_THRESHOLDS;
  const show = opts.show ?? 'all';
  const byId = new Map(inputs.sessions.map(s => [s.sessionId, s]));
  const children = new Map<string, OverviewSessionInput[]>();
  for (const s of inputs.sessions) {
    const p = s.meta?.orchestratedBy;
    if (p) children.set(p, [...(children.get(p) ?? []), s]);
  }
  const live = inputs.sessions.filter(s => s.meta?.folder !== inputs.archiveFolder);
  const drafts = live.map(s => classifyOne(s, inputs, now, th, byId, children));

  // children-stuck: a herd parent whose (non-archived) children are all idle with no-driver.
  const draftById = new Map(drafts.map(d => [d.entry.sessionId, d]));
  for (const d of drafts) {
    const kids = (children.get(d.entry.sessionId) ?? []).map(k => draftById.get(k.sessionId)).filter((k): k is Draft => !!k);
    if (kids.length > 0 && kids.every(k => k.entry.activity === 'idle' && k.entry.flags.some(f => f.code === 'no-driver'))) {
      d.entry.flags.push({ code: 'children-stuck', detail: `all ${kids.length} children idle with nothing to move them`, confidence: 'low' });
    }
  }
  for (const d of drafts) finish(d.entry);

  const all = drafts.map(d => d.entry).sort(compareEntries);
  const shown = all.filter(e => matchesShow(e, show) && matchesKeys(e, opts.keys));
  const shownSet = new Set(shown);
  const omitted = all.filter(e => !shownSet.has(e));
  return {
    schemaVersion: OVERVIEW_SCHEMA_VERSION,
    instance: { ...inputs.instance },
    generatedAt: iso(now),
    show,
    wakeLoopEnabled: inputs.wakeLoopEnabled,
    counts: {
      total: all.length,
      shown: shown.length,
      omitted: omitted.length,
      omittedFlagged: omitted.filter(e => e.flags.some(f => f.confidence !== 'info')).length,
      full: all.filter(e => e.tier === 'full').length,
      compact: all.filter(e => e.tier === 'compact').length,
      archivedExcluded: inputs.sessions.length - live.length,
    },
    entries: shown,
  };
}
