/**
 * Hub fan-out for `GET /api/overview?scope=all` (spec-session-overview,
 * Cross-machine fetch policy). Asks each registered peer for
 * `/api/overview?scope=local` only (never `/api/sessions`), one hop, with the
 * hop header, and reports a status per instance. A failing, slow, oversized,
 * malformed or impostor peer never fails the call.
 */

import type { CacoPeer } from './peer-store.js';
import { normalizeOrigin, isLoopbackOrigin } from './peer-store.js';
import {
  OVERVIEW_SCHEMA_VERSION, type SessionOverview, type OverviewEntry, type OverviewFlag, type WaitReason, type WakeOverview,
} from './session-overview.js';
import type { LastContext, AskVerdict } from './sdk-session-tail.js';
import type { WakeRun, WakeDefer, WakePendingRun } from './session-meta-store.js';

export const OVERVIEW_HOP_HEADER = 'X-Caco-Overview-Hop';
export const PEER_TIMEOUT_MS = 5000;
export const FANOUT_DEADLINE_MS = 8000;
export const FANOUT_MAX_PARALLEL = 8;
export const PEER_MAX_BYTES = 4 * 1024 * 1024;

export type PeerStatus = 'ok' | 'unreachable' | 'skipped' | 'outdated' | 'invalid' | 'self';

export interface PeerFetchResult {
  instance: { id?: string; name: string; origin?: string };
  status: PeerStatus;
  fetchedAt: string;
  /** A fixed reason string for a non-ok status. */
  reason?: string;
  overview?: SessionOverview;
}

export interface FanoutOptions {
  peers: CacoPeer[];
  selfId: string;
  /** Non-loopback origins explicitly allowed (CACO_PEERS_ALLOW_REMOTE). */
  allowRemote: Set<string>;
  context: 'brief' | 'full' | 'none';
  fetchImpl?: typeof fetch;
  perPeerTimeoutMs?: number;
  deadlineMs?: number;
  maxParallel?: number;
  maxBytes?: number;
  now?: () => number;
  /** Called with a peer's reported instance id after a valid response. */
  onIdentity?: (origin: string, id: string) => void;
}

class FanoutError extends Error {
  constructor(readonly status: PeerStatus, readonly reason: string) { super(reason); }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const CONFIDENCE = new Set(['high', 'low', 'info']);
const WAIT_KINDS = new Set(['turn-running', 'retry-pending', 'user-offer', 'wake', 'wake-running', 'children', 'schedule']);
const TIERS = new Set(['full', 'compact']);
const ACTIVITY = new Set(['busy', 'idle']);
const HIDDEN = new Set(['herd-child', 'agent', 'swarm']);
const TITLE_SOURCES = new Set(['name', 'workspace-summary', 'auto-name', 'none']);
const PARENT_STATES = new Set(['ok', 'missing', 'archived']);
const RUN_OUTCOMES = new Set(['ok', 'error', 'cancelled', 'interrupted', 'rejected']);
const MAX_ENTRIES = 20_000;

class Invalid extends Error {}
const bad = (reason: string): never => { throw new Invalid(reason); };

// Typed readers: each returns a clean value or throws Invalid. Optional readers
// return undefined for an absent (undefined) field.
const str = (v: unknown, what: string, max = 10_000): string => (typeof v === 'string' && v.length <= max ? v : bad(what));
const optStr = (v: unknown, what: string, max = 10_000): string | undefined => (v === undefined ? undefined : str(v, what, max));
const num = (v: unknown, what: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : bad(what));
const optNum = (v: unknown, what: string): number | undefined => (v === undefined ? undefined : num(v, what));
const bool = (v: unknown, what: string): boolean => (typeof v === 'boolean' ? v : bad(what));
const obj = (v: unknown, what: string): Record<string, unknown> => (isObj(v) ? v : bad(what));
const arr = (v: unknown, what: string, max = 10_000): unknown[] => (Array.isArray(v) && v.length <= max ? v : bad(what));
const oneOf = <T extends string>(v: unknown, set: Set<string>, what: string): T => (typeof v === 'string' && set.has(v) ? v as T : bad(what));
/** Copy only defined values, so the clean object has no `undefined` keys. */
function defined<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function cleanWait(v: unknown): WaitReason {
  const w = obj(v, 'bad wait');
  const kind = oneOf<WaitReason['kind']>(w.kind, WAIT_KINDS, 'bad wait');
  switch (kind) {
    case 'retry-pending': return { kind, attempt: num(w.attempt, 'bad wait') };
    case 'wake': return { kind, nextAt: str(w.nextAt, 'bad wait', 40) };
    case 'children': return { kind, busy: num(w.busy, 'bad wait') };
    case 'schedule': return { kind, nextRun: str(w.nextRun, 'bad wait', 40) };
    default: return { kind } as WaitReason;
  }
}

function cleanFlag(v: unknown): OverviewFlag {
  const f = obj(v, 'bad flag');
  return {
    code: str(f.code, 'bad flag', 100) as OverviewFlag['code'],
    detail: str(f.detail, 'bad flag', 2000),
    confidence: oneOf<OverviewFlag['confidence']>(f.confidence, CONFIDENCE, 'bad flag'),
  };
}

function cleanAt(v: unknown, what: string, textMax: number, withSource = false) {
  if (v === undefined) return undefined;
  const o = obj(v, what);
  const out: Record<string, unknown> = { at: str(o.at, what, 40), text: str(o.text, what, textMax) };
  if (withSource) out.source = str(o.source, what, 20);
  return out;
}

function cleanContext(v: unknown): LastContext {
  const c = obj(v, 'bad context');
  return defined({
    status: str(c.status, 'bad context', 40) as LastContext['status'],
    errorCode: optStr(c.errorCode, 'bad context', 40),
    windowCoversTurn: c.windowCoversTurn === undefined ? undefined : bool(c.windowCoversTurn, 'bad context'),
    lastUser: cleanAt(c.lastUser, 'bad context', 2000, true) as LastContext['lastUser'],
    lastAssistant: cleanAt(c.lastAssistant, 'bad context', 2000) as LastContext['lastAssistant'],
    lastError: cleanAt(c.lastError, 'bad context', 2000) as LastContext['lastError'],
    lastEventType: optStr(c.lastEventType, 'bad context', 100),
    lastEventAt: optStr(c.lastEventAt, 'bad context', 40),
  });
}

function cleanAsk(v: unknown): AskVerdict | undefined {
  if (v === undefined) return undefined;
  const a = obj(v, 'bad ask');
  if ('unavailable' in a) {
    const u = str(a.unavailable, 'bad ask', 40);
    if (u !== 'oversized' && u !== 'truncated-start') bad('bad ask');
    return { unavailable: u as 'oversized' | 'truncated-start' };
  }
  return { matched: a.matched === null ? null : str(a.matched, 'bad ask', 200) };
}

function cleanWake(v: unknown): WakeOverview | undefined {
  if (v === undefined) return undefined;
  const w = obj(v, 'bad wake');
  const c = obj(w.counters, 'bad wake');
  const counters = defined({
    fires: num(c.fires, 'bad wake'), ok: num(c.ok, 'bad wake'), errors: num(c.errors, 'bad wake'),
    cancelled: num(c.cancelled, 'bad wake'), interrupted: num(c.interrupted, 'bad wake'), offered: num(c.offered, 'bad wake'),
    firesSinceHuman: num(c.firesSinceHuman, 'bad wake'), humanAnchor: optStr(c.humanAnchor, 'bad wake', 40),
  });
  const history = arr(w.history, 'bad wake', 50).map(x => {
    const r = obj(x, 'bad wake');
    return defined({
      slot: num(r.slot, 'bad wake'), dueAt: str(r.dueAt, 'bad wake', 40),
      firedAt: optStr(r.firedAt, 'bad wake', 40), settledAt: optStr(r.settledAt, 'bad wake', 40),
      outcome: oneOf<WakeRun['outcome']>(r.outcome, RUN_OUTCOMES, 'bad wake'),
      reason: optStr(r.reason, 'bad wake', 100),
      offered: r.offered === undefined ? undefined : (r.offered === true ? true as const : bad('bad wake')),
      final: r.final === undefined ? undefined : (r.final === true ? true as const : bad('bad wake')),
      retries: optNum(r.retries, 'bad wake'),
    }) as WakeRun;
  });
  const defers = arr(w.defers, 'bad wake', 20).map(x => {
    const d = obj(x, 'bad wake');
    return {
      dueAt: str(d.dueAt, 'bad wake', 40), kind: str(d.kind, 'bad wake', 20) as WakeDefer['kind'],
      first: str(d.first, 'bad wake', 40), last: str(d.last, 'bad wake', 40), count: num(d.count, 'bad wake'),
    };
  });
  let pendingRun: WakePendingRun | undefined;
  if (w.pendingRun !== undefined) {
    const p = obj(w.pendingRun, 'bad wake');
    pendingRun = defined({
      slot: num(p.slot, 'bad wake'), dueAt: str(p.dueAt, 'bad wake', 40), firedAt: str(p.firedAt, 'bad wake', 40),
      offerBaseline: p.offerBaseline === null ? null : str(p.offerBaseline, 'bad wake', 40),
      final: p.final === undefined ? undefined : (p.final === true ? true as const : bad('bad wake')),
      retries: optNum(p.retries, 'bad wake'),
    }) as WakePendingRun;
  }
  return defined({
    everyHours: num(w.everyHours, 'bad wake'), registeredAt: str(w.registeredAt, 'bad wake', 40), nextWakeAt: str(w.nextWakeAt, 'bad wake', 40),
    note: optStr(w.note, 'bad wake', 500), lastWakeAt: optStr(w.lastWakeAt, 'bad wake', 40),
    lastResult: optStr(w.lastResult, 'bad wake', 20) as WakeOverview['lastResult'], lastError: optStr(w.lastError, 'bad wake', 200),
    pausedReason: optStr(w.pausedReason, 'bad wake', 20) as WakeOverview['pausedReason'], finalWakeAt: optStr(w.finalWakeAt, 'bad wake', 40),
    consecutiveFailures: num(w.consecutiveFailures, 'bad wake'), slotSeq: num(w.slotSeq, 'bad wake'), counters,
    lastOkAt: optStr(w.lastOkAt, 'bad wake', 40), lastOfferedAt: optStr(w.lastOfferedAt, 'bad wake', 40),
    historySince: optStr(w.historySince, 'bad wake', 40), history, defers, pendingRun,
  }) as WakeOverview;
}

function cleanEntry(v: unknown, inst: { id: string; name: string }): OverviewEntry {
  const e = obj(v, 'bad entry');
  const sessionId = str(e.sessionId, 'bad entry', 200);
  const ei = obj(e.instance, 'bad entry');
  if (ei.id !== inst.id || e.key !== `${inst.id}:${sessionId}`) bad('entry from another instance');
  let offer: OverviewEntry['offer'];
  if (e.offer !== undefined) {
    const o = obj(e.offer, 'bad offer');
    offer = {
      options: arr(o.options, 'bad offer', 50).map(x => str(x, 'bad offer', 500)),
      at: o.at === null ? null : str(o.at, 'bad offer', 40),
      dismissed: bool(o.dismissed, 'bad offer'),
      ageMs: o.ageMs === null ? null : num(o.ageMs, 'bad offer'),
      onPager: bool(o.onPager, 'bad offer'),
    };
  }
  let busy: OverviewEntry['busy'];
  if (e.busy !== undefined) {
    const b = obj(e.busy, 'bad busy');
    busy = defined({ since: str(b.since, 'bad busy', 40), pendingTools: optNum(b.pendingTools, 'bad busy'), currentIntent: optStr(b.currentIntent, 'bad busy', 500) });
  }
  let schedule: OverviewEntry['schedule'];
  if (e.schedule !== undefined) {
    const sc = obj(e.schedule, 'bad schedule');
    schedule = defined({
      slug: str(sc.slug, 'bad schedule', 200), enabled: bool(sc.enabled, 'bad schedule'),
      nextRun: sc.nextRun === null ? null : str(sc.nextRun, 'bad schedule', 40), lastResult: optStr(sc.lastResult, 'bad schedule', 40),
    });
  }
  let herd: OverviewEntry['herd'];
  if (e.herd !== undefined) {
    const h = obj(e.herd, 'bad herd');
    herd = defined({
      parent: optStr(h.parent, 'bad herd', 200),
      parentState: h.parentState === undefined ? undefined : oneOf<NonNullable<NonNullable<OverviewEntry['herd']>['parentState']>>(h.parentState, PARENT_STATES, 'bad herd'),
      children: optNum(h.children, 'bad herd'), busyChildren: optNum(h.busyChildren, 'bad herd'),
    });
  }
  return defined({
    key: e.key as string,
    instance: { id: inst.id, name: inst.name },
    sessionId,
    title: str(e.title, 'bad entry', 1000),
    titleSource: oneOf<OverviewEntry['titleSource']>(e.titleSource, TITLE_SOURCES, 'bad entry'),
    kind: str(e.kind, 'bad entry', 40) as OverviewEntry['kind'],
    folder: optStr(e.folder, 'bad entry', 200),
    cwd: e.cwd === null ? null : str(e.cwd, 'bad entry', 2000),
    hidden: e.hidden === undefined ? undefined : oneOf<NonNullable<OverviewEntry['hidden']>>(e.hidden, HIDDEN, 'bad entry'),
    tier: oneOf<OverviewEntry['tier']>(e.tier, TIERS, 'bad entry'),
    activity: oneOf<OverviewEntry['activity']>(e.activity, ACTIVITY, 'bad entry'),
    busy,
    waits: arr(e.waits, 'bad entry', 20).map(cleanWait),
    offer,
    wake: cleanWake(e.wake),
    schedule,
    herd,
    lastHumanAt: optStr(e.lastHumanAt, 'bad entry', 40),
    lastActivityAt: optStr(e.lastActivityAt, 'bad entry', 40),
    context: cleanContext(e.context),
    ask: cleanAsk(e.ask),
    flags: arr(e.flags, 'bad entry', 50).map(cleanFlag),
    primaryFlag: optStr(e.primaryFlag, 'bad entry', 100) as OverviewEntry['primaryFlag'],
  }) as OverviewEntry;
}

/**
 * Validate a peer's overview and rebuild it from known fields only, so every
 * field the merge, classifier or a renderer dereferences has the right type.
 * Every entry must belong to the reporting instance (`key` and
 * `instance.id`), so a peer cannot speak for another.
 */
export function validateOverviewPayload(v: unknown): { ok: true; value: SessionOverview } | { ok: false; reason: string } {
  try {
    const o = obj(v, 'not an object');
    if (o.schemaVersion !== OVERVIEW_SCHEMA_VERSION) bad('schemaVersion mismatch');
    const ri = obj(o.instance, 'bad instance');
    const inst = { id: str(ri.id, 'bad instance', 100), name: str(ri.name, 'bad instance', 200) };
    if (!inst.id) bad('bad instance');
    const c = obj(o.counts, 'bad counts');
    const counts = {
      total: num(c.total, 'bad counts'), shown: num(c.shown, 'bad counts'), omitted: num(c.omitted, 'bad counts'),
      omittedFlagged: num(c.omittedFlagged, 'bad counts'), full: num(c.full, 'bad counts'), compact: num(c.compact, 'bad counts'),
      archivedExcluded: num(c.archivedExcluded, 'bad counts'),
    };
    const value: SessionOverview = {
      schemaVersion: OVERVIEW_SCHEMA_VERSION,
      instance: inst,
      generatedAt: str(o.generatedAt, 'bad envelope', 40),
      show: (typeof o.show === 'string' ? o.show : 'all') as SessionOverview['show'],
      wakeLoopEnabled: o.wakeLoopEnabled === undefined ? true : bool(o.wakeLoopEnabled, 'bad envelope'),
      counts,
      entries: arr(o.entries, 'bad envelope', MAX_ENTRIES).map(e => cleanEntry(e, inst)),
    };
    return { ok: true, value };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, reason: e.message };
    return { ok: false, reason: 'bad payload' };
  }
}

/** Read a body with a hard byte cap, streaming (never buffers past the cap). */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new FanoutError('invalid', 'response too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => { /* ignore */ });
      throw new FanoutError('invalid', 'response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
}

function classifyFetchError(e: unknown, deadline: AbortSignal): FanoutError {
  if (e instanceof FanoutError) return e;
  if (deadline.aborted) return new FanoutError('unreachable', 'deadline');
  const err = e as { name?: string; cause?: { message?: string } ; message?: string };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new FanoutError('unreachable', 'timeout');
  const msg = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`;
  if (/redirect/i.test(msg)) return new FanoutError('invalid', 'redirect refused');
  return new FanoutError('unreachable', 'network error');
}

/** Fetch every peer's local overview under the fetch policy. Results are in peer order. */
export async function fetchPeerOverviews(o: FanoutOptions): Promise<PeerFetchResult[]> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const maxBytes = o.maxBytes ?? PEER_MAX_BYTES;
  const perPeer = o.perPeerTimeoutMs ?? PEER_TIMEOUT_MS;
  const deadlineCtl = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineCtl.abort(), o.deadlineMs ?? FANOUT_DEADLINE_MS);
  deadlineTimer.unref?.();
  const results: PeerFetchResult[] = new Array(o.peers.length);
  const seenIds = new Set<string>();
  let next = 0;

  const one = async (peer: CacoPeer): Promise<PeerFetchResult> => {
    const name = peer.name || peer.hostname || '';
    const origin = normalizeOrigin(peer.origin ?? peer.url);
    const base: PeerFetchResult['instance'] = { name, ...(peer.id && { id: peer.id }), ...(origin && { origin }) };
    const done = (status: PeerStatus, reason?: string, overview?: SessionOverview): PeerFetchResult =>
      ({ instance: base, status, fetchedAt: new Date(now()).toISOString(), ...(reason && { reason }), ...(overview && { overview }) });
    if (!origin) return done('invalid', 'invalid origin');
    if (!isLoopbackOrigin(origin) && !o.allowRemote.has(origin)) return done('skipped', 'needs browser auth');
    if (peer.id && peer.id === o.selfId) return done('self');
    if (deadlineCtl.signal.aborted) return done('unreachable', 'deadline');
    try {
      const signal = AbortSignal.any([AbortSignal.timeout(perPeer), deadlineCtl.signal]);
      const url = `${origin}/api/overview?scope=local&show=all&context=${encodeURIComponent(o.context)}`;
      const res = await fetchImpl(url, { redirect: 'error', signal, headers: { [OVERVIEW_HOP_HEADER]: '1', Accept: 'application/json' } });
      if (res.status === 404) { await res.body?.cancel().catch(() => { /* ignore */ }); return done('outdated', 'no /api/overview'); }
      if (!res.ok) { await res.body?.cancel().catch(() => { /* ignore */ }); return done('unreachable', `HTTP ${res.status}`); }
      const text = await readCapped(res, maxBytes);
      let json: unknown;
      try { json = JSON.parse(text); } catch { return done('invalid', 'not JSON'); }
      const v = validateOverviewPayload(json);
      if (!v.ok) return done('invalid', v.reason);
      const id = v.value.instance.id;
      base.id = id;
      if (id === o.selfId) return done('self');
      if (seenIds.has(id)) return done('skipped', 'duplicate instance id');
      seenIds.add(id);
      try { o.onIdentity?.(origin, id); } catch { /* best effort: never fails the fetch */ }
      return done('ok', undefined, v.value);
    } catch (e) {
      const f = classifyFetchError(e, deadlineCtl.signal);
      return done(f.status, f.reason);
    }
  };

  const worker = async () => {
    while (next < o.peers.length) {
      const i = next++;
      results[i] = await one(o.peers[i]);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(o.maxParallel ?? FANOUT_MAX_PARALLEL, o.peers.length) }, worker));
  } finally {
    clearTimeout(deadlineTimer);
  }
  return results;
}
