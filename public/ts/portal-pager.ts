/**
 * Portal side of the merged pager (docs/spec-portal-pager.md).
 *
 * Built to public/portal-pager.js and loaded by portal.html. Collects each
 * instance's pager view through its iframe, merges them into one board, and
 * routes Send/Dismiss back to the owning instance. pager.html?portal=1 renders
 * the board through `window.cacoPortalPager`.
 */
import { BRIDGE, isValidSessionId, originOf, type ActionResult } from './pager-bridge.js';

export const WATCH_EVERY_MS = 15_000;
export const STALE_MS = 30_000;
export const PENDING_GRACE_MS = 20_000;
export const ACTION_TIMEOUT_MS = 20_000;
const TICK_MS = 5_000;

export interface PortalPeer { id: string; url: string; name: string }

export interface WakeBadge { everyHours: number; pausedReason?: string; failed?: true; archived?: true }
export interface BusyEntry { sessionId: string; name: string; wake?: WakeBadge }
export interface WaitingEntry { sessionId: string; name: string; cwd: string; idleAt: string; options: string[]; wake?: WakeBadge }
export interface WakeEntry {
  sessionId: string; name: string; everyHours: number; nextWakeAt: string;
  note?: string; lastWakeAt?: string; lastResult?: string; pausedReason?: string; archived?: true; waiting?: true; busy?: true;
}
export interface PagerView { busy: BusyEntry[]; waiting: WaitingEntry[]; waitingTruncated: boolean; wakes: WakeEntry[] }

export type InstanceStatus = 'pending' | 'live' | 'unreachable' | 'refused';

export interface InstanceRecord {
  view: PagerView | null;
  lastSeen: number | null;
  refused: boolean;
}

export interface Labeled { key: string; instanceId: string; instanceName: string }
export interface MergedView {
  busy: Array<BusyEntry & Labeled>;
  waiting: Array<WaitingEntry & Labeled>;
  waitingTruncated: boolean;
  wakes: Array<WakeEntry & Labeled>;
  instances: Array<{ id: string; name: string; status: InstanceStatus }>;
  portalOrigin: string;
}

const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '');

export function parseWakeBadge(raw: unknown): WakeBadge | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.everyHours !== 'number' || !Number.isFinite(r.everyHours) || r.everyHours <= 0) return undefined;
  const badge: WakeBadge = { everyHours: r.everyHours };
  if (typeof r.pausedReason === 'string' && r.pausedReason) badge.pausedReason = r.pausedReason.slice(0, 40);
  if (r.failed === true) badge.failed = true;
  if (r.archived === true) badge.archived = true;
  return badge;
}

/** A wake list entry. Older instances send no `wakes`, which is an empty list, not an error. */
export function parseWakeEntry(raw: unknown): WakeEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isValidSessionId(o.sessionId)) return null;
  if (typeof o.everyHours !== 'number' || !Number.isFinite(o.everyHours) || o.everyHours <= 0) return null;
  const e: WakeEntry = { sessionId: o.sessionId, name: str(o.name, 300), everyHours: o.everyHours, nextWakeAt: str(o.nextWakeAt, 64) };
  if (typeof o.note === 'string' && o.note) e.note = o.note.slice(0, 300);
  if (typeof o.lastWakeAt === 'string' && o.lastWakeAt) e.lastWakeAt = o.lastWakeAt.slice(0, 64);
  if (typeof o.lastResult === 'string' && o.lastResult) e.lastResult = o.lastResult.slice(0, 20);
  if (typeof o.pausedReason === 'string' && o.pausedReason) e.pausedReason = o.pausedReason.slice(0, 40);
  if (o.archived === true) e.archived = true;
  if (o.waiting === true) e.waiting = true;
  if (o.busy === true) e.busy = true;
  return e;
}

/** Re-validate a view from an instance: it crosses a trust boundary even from an allowed origin. */
export function parsePagerView(raw: unknown): PagerView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.busy) || !Array.isArray(r.waiting)) return null;
  const busy: BusyEntry[] = [];
  for (const b of r.busy as unknown[]) {
    const o = (b ?? {}) as Record<string, unknown>;
    if (!isValidSessionId(o.sessionId)) continue;
    const wake = parseWakeBadge(o.wake);
    busy.push({ sessionId: o.sessionId, name: str(o.name, 300), ...(wake ? { wake } : {}) });
  }
  const waiting: WaitingEntry[] = [];
  for (const w of r.waiting as unknown[]) {
    const o = (w ?? {}) as Record<string, unknown>;
    if (!isValidSessionId(o.sessionId) || !Array.isArray(o.options)) continue;
    const options = (o.options as unknown[]).filter((x): x is string => typeof x === 'string').map(x => x.slice(0, 20_000));
    if (options.length === 0) continue;
    const wake = parseWakeBadge(o.wake);
    waiting.push({ sessionId: o.sessionId, name: str(o.name, 300), cwd: str(o.cwd, 1000), idleAt: str(o.idleAt, 64), options, ...(wake ? { wake } : {}) });
  }
  const wakes: WakeEntry[] = [];
  if (Array.isArray(r.wakes)) {
    for (const x of (r.wakes as unknown[]).slice(0, 200)) {
      const e = parseWakeEntry(x);
      if (e) wakes.push(e);
    }
  }
  return { busy, waiting, waitingTruncated: r.waitingTruncated === true, wakes };
}

export function cardKey(peerId: string, sessionId: string): string {
  return peerId + ':' + sessionId;
}

export function parseCardKey(key: unknown): { peerId: string; sessionId: string } | null {
  if (typeof key !== 'string') return null;
  const i = key.indexOf(':');
  if (i <= 0) return null;
  const peerId = key.slice(0, i);
  const sessionId = key.slice(i + 1);
  if (!isValidSessionId(sessionId)) return null;
  return { peerId, sessionId };
}

export function instanceStatus(rec: InstanceRecord | undefined, now: number, startedAt: number): InstanceStatus {
  const lastSeen = rec?.lastSeen ?? null;
  if (lastSeen !== null && now - lastSeen <= STALE_MS) return 'live';
  if (rec?.refused) return 'refused';
  if (lastSeen === null && now - startedAt < PENDING_GRACE_MS) return 'pending';
  return 'unreachable';
}

/** One board from many. Only live instances contribute; cards are newest-first across instances. */
export function mergeBoards(
  peers: readonly PortalPeer[],
  records: ReadonlyMap<string, InstanceRecord>,
  now: number,
  startedAt: number,
  portalOrigin: string,
): MergedView {
  const busy: MergedView['busy'] = [];
  const waiting: MergedView['waiting'] = [];
  const wakes: MergedView['wakes'] = [];
  const instances: MergedView['instances'] = [];
  let waitingTruncated = false;
  for (const p of peers) {
    const rec = records.get(p.id);
    const status = instanceStatus(rec, now, startedAt);
    instances.push({ id: p.id, name: p.name, status });
    if (status !== 'live' || !rec?.view) continue;
    const label = { instanceId: p.id, instanceName: p.name };
    for (const b of rec.view.busy) busy.push({ ...b, ...label, key: cardKey(p.id, b.sessionId) });
    for (const w of rec.view.waiting) waiting.push({ ...w, ...label, key: cardKey(p.id, w.sessionId) });
    for (const k of rec.view.wakes) wakes.push({ ...k, ...label, key: cardKey(p.id, k.sessionId) });
    waitingTruncated ||= rec.view.waitingTruncated;
  }
  const t = (iso: string): number => { const n = Date.parse(iso); return Number.isFinite(n) ? n : 0; };
  // Array.prototype.sort is stable, so ties keep sidebar and server order.
  waiting.sort((a, b) => t(b.idleAt) - t(a.idleAt));
  // Same order as one instance's list: soonest first, then archived, then paused.
  const rank = (e: WakeEntry): number => (e.pausedReason ? 2 : e.archived ? 1 : 0);
  wakes.sort((a, b) => rank(a) - rank(b) || t(a.nextWakeAt) - t(b.nextWakeAt));
  return { busy, waiting, waitingTruncated, wakes, instances, portalOrigin };
}

export interface PortalPagerDeps {
  getPeers(): PortalPeer[];
  getFrameWindow(peerId: string): { postMessage(msg: unknown, targetOrigin: string): void } | null;
  openSession(peerId: string, sessionId: string): void;
  portalOrigin: string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  setRepeat?: (fn: () => void, ms: number) => unknown;
  onChange?: (view: MergedView) => void;
}

export interface PortalPager {
  handleMessage(e: { origin: string; source: unknown; data: unknown }): void;
  subscribe(cb: (view: MergedView) => void): () => void;
  current(): MergedView;
  send(key: string, text: string): Promise<void>;
  dismiss(key: string): Promise<void>;
  open(key: string): void;
  kick(): void;
  tick(): void;
}

interface Pending { peerId: string; resolve(): void; reject(e: Error): void; timer: unknown }

export function createPortalPager(deps: PortalPagerDeps): PortalPager {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>));
  const startedAt = now();
  const records = new Map<string, InstanceRecord>();
  const pending = new Map<string, Pending>();
  const subs = new Set<(v: MergedView) => void>();
  let lastWatchAt = -Infinity;
  let lastSig = '';
  let seq = 0;

  function peerFor(e: { origin: string; source: unknown }): PortalPeer | null {
    for (const p of deps.getPeers()) {
      if (originOf(p.url) !== e.origin) continue;
      const w = deps.getFrameWindow(p.id);
      if (w && w === e.source) return p;
    }
    return null;
  }

  function record(id: string): InstanceRecord {
    let r = records.get(id);
    if (!r) { r = { view: null, lastSeen: null, refused: false }; records.set(id, r); }
    return r;
  }

  function current(): MergedView {
    return mergeBoards(deps.getPeers(), records, now(), startedAt, deps.portalOrigin);
  }

  function emit(force = false): void {
    const v = current();
    const sig = JSON.stringify(v);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    deps.onChange?.(v);
    subs.forEach(cb => { try { cb(v); } catch { /* one bad subscriber must not starve the rest */ } });
  }

  function kick(): void {
    lastWatchAt = now();
    for (const p of deps.getPeers()) {
      const origin = originOf(p.url);
      const w = deps.getFrameWindow(p.id);
      if (origin && w) w.postMessage({ type: BRIDGE.WATCH }, origin);
    }
  }

  function tick(): void {
    if (now() - lastWatchAt >= WATCH_EVERY_MS) kick();
    emit();
  }

  function handleMessage(e: { origin: string; source: unknown; data: unknown }): void {
    const d = e.data as Record<string, unknown> | null;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string' || !d.type.startsWith('caco:pager:')) return;
    const peer = peerFor(e);
    if (!peer) return;
    if (d.type === BRIDGE.VIEW) {
      const view = parsePagerView(d.view);
      if (!view) return;
      const r = record(peer.id);
      r.view = view; r.lastSeen = now(); r.refused = false;
      emit();
      return;
    }
    if (d.type === BRIDGE.REFUSED) {
      record(peer.id).refused = true;
      emit();
      return;
    }
    if (d.type === BRIDGE.RESULT) {
      const res = d as unknown as ActionResult;
      const p = typeof res.reqId === 'string' ? pending.get(res.reqId) : undefined;
      // A result only settles the request it answers, from the instance it was sent to.
      if (!p || p.peerId !== peer.id) return;
      pending.delete(res.reqId);
      clearTimer(p.timer);
      if (res.ok === true) p.resolve();
      else {
        const err = new Error(typeof res.error === 'string' ? res.error : 'Failed') as Error & { status?: number };
        err.status = typeof res.status === 'number' ? res.status : 0;
        p.reject(err);
      }
    }
  }

  function act(key: string, action: 'send' | 'dismiss', text?: string): Promise<void> {
    const parsed = parseCardKey(key);
    const peer = parsed ? deps.getPeers().find(p => p.id === parsed.peerId) : undefined;
    const origin = peer ? originOf(peer.url) : null;
    const w = peer ? deps.getFrameWindow(peer.id) : null;
    if (!parsed || !peer || !origin || !w) return Promise.reject(Object.assign(new Error('Instance not available'), { status: 0 }));
    const reqId = 'r' + (++seq) + '_' + Math.random().toString(36).slice(2, 10);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimer(() => {
        pending.delete(reqId);
        reject(Object.assign(new Error(peer.name + ' did not answer'), { status: 0 }));
      }, ACTION_TIMEOUT_MS);
      pending.set(reqId, { peerId: peer.id, resolve, reject, timer });
      w.postMessage({ type: BRIDGE.ACTION, reqId, action, sessionId: parsed.sessionId, ...(text !== undefined ? { text } : {}) }, origin);
    });
  }

  if (deps.setRepeat) deps.setRepeat(tick, TICK_MS);

  return {
    handleMessage,
    subscribe(cb) { subs.add(cb); cb(current()); return () => { subs.delete(cb); }; },
    current,
    send: (key, text) => act(key, 'send', text),
    dismiss: key => act(key, 'dismiss'),
    open(key) {
      const parsed = parseCardKey(key);
      if (parsed) deps.openSession(parsed.peerId, parsed.sessionId);
    },
    kick,
    tick,
  };
}

interface PortalHost {
  getPeers(): PortalPeer[];
  getFrameWindow(peerId: string): Window | null;
  openSession(peerId: string, sessionId: string): void;
  setPagerCount?(n: number): void;
}

// Browser bootstrap: portal.html defines window.cacoPortal before this module runs.
const g = globalThis as unknown as { window?: Window & { cacoPortal?: PortalHost; cacoPortalPager?: PortalPager } };
const host = g.window?.cacoPortal;
if (g.window && host) {
  const w = g.window;
  const pager = createPortalPager({
    getPeers: () => host.getPeers(),
    getFrameWindow: id => host.getFrameWindow(id),
    openSession: (peerId, sessionId) => host.openSession(peerId, sessionId),
    portalOrigin: w.location.origin,
    setRepeat: (fn, ms) => setInterval(fn, ms),
    onChange: v => host.setPagerCount?.(v.waiting.length),
  });
  w.cacoPortalPager = pager;
  w.addEventListener('message', e => pager.handleMessage(e));
  pager.kick();
}
