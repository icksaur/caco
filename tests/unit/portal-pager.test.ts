import { describe, it, expect, vi } from 'vitest';
import {
  parsePagerView, mergeBoards, cardKey, parseCardKey, instanceStatus, createPortalPager,
  STALE_MS, PENDING_GRACE_MS, ACTION_TIMEOUT_MS, WATCH_EVERY_MS,
  type InstanceRecord, type PortalPeer, type MergedView,
} from '../../public/ts/portal-pager.js';
import { BRIDGE } from '../../public/ts/pager-bridge.js';

const peers: PortalPeer[] = [
  { id: 'local', url: 'http://localhost:53000', name: 'laptop' },
  { id: 'b1', url: 'https://box1.devtunnels.ms/', name: 'devbox1' },
  { id: 'b2', url: 'https://box2.devtunnels.ms', name: 'devbox2' },
];

const waiting = (sessionId: string, idleAt: string, over: Record<string, unknown> = {}) =>
  ({ sessionId, name: 'n-' + sessionId, cwd: '/r', idleAt, options: ['A', 'B'], ...over });

describe('parsePagerView', () => {
  it('keeps valid entries and strips everything else', () => {
    const v = parsePagerView({
      version: 1,
      busy: [{ sessionId: 's1', name: 'one', extra: 1 }, { sessionId: '../bad' }, null],
      waiting: [
        waiting('w1', '2026-01-01T00:00:00Z'),
        { sessionId: 'w2', options: [] },
        { sessionId: 'w3', options: ['ok', 5, null] },
        { sessionId: 'w4' },
      ],
      waitingTruncated: true,
    });
    expect(v).toEqual({
      busy: [{ sessionId: 's1', name: 'one' }],
      waiting: [
        { sessionId: 'w1', name: 'n-w1', cwd: '/r', idleAt: '2026-01-01T00:00:00Z', options: ['A', 'B'] },
        { sessionId: 'w3', name: '', cwd: '', idleAt: '', options: ['ok'] },
      ],
      waitingTruncated: true,
      wakes: [],
    });
  });

  it('validates wake entries and tolerates instances that send none', () => {
    const v = parsePagerView({
      busy: [], waiting: [],
      wakes: [
        { sessionId: 'k1', name: 'track', everyHours: 2, nextWakeAt: '2026-01-01T00:00:00Z', note: 'PR', lastResult: 'ok', waiting: true, extra: 1 },
        { sessionId: '../bad', everyHours: 1 },
        { sessionId: 'k2', everyHours: 0 },
      ],
    })!;
    expect(v.wakes).toEqual([{ sessionId: 'k1', name: 'track', everyHours: 2, nextWakeAt: '2026-01-01T00:00:00Z', note: 'PR', lastResult: 'ok', waiting: true }]);
    expect(parsePagerView({ busy: [], waiting: [] })!.wakes).toEqual([]);
  });

  it('rejects non-views', () => {
    expect(parsePagerView(null)).toBeNull();
    expect(parsePagerView({ busy: 'x', waiting: [] })).toBeNull();
  });
});

describe('wake badge passthrough', () => {
  it('keeps a valid badge and drops a malformed one', () => {
    const v = parsePagerView({
      busy: [{ sessionId: 'b1', name: 'x', wake: { everyHours: 2, pausedReason: 'expired', extra: 1 } }],
      waiting: [
        waiting('w1', '', { wake: { everyHours: 1, failed: true } }),
        waiting('w2', '', { wake: { everyHours: 'soon' } }),
      ],
    })!;
    expect(v.busy[0].wake).toEqual({ everyHours: 2, pausedReason: 'expired' });
    expect(v.waiting[0].wake).toEqual({ everyHours: 1, failed: true });
    expect(v.waiting[1]).not.toHaveProperty('wake');
  });
});

describe('card keys', () => {
  it('round-trips and rejects bad keys', () => {
    expect(parseCardKey(cardKey('b1', 's-1'))).toEqual({ peerId: 'b1', sessionId: 's-1' });
    expect(parseCardKey('nokey')).toBeNull();
    expect(parseCardKey(':s1')).toBeNull();
    expect(parseCardKey('b1:../x')).toBeNull();
  });
});

describe('instanceStatus', () => {
  it('moves pending -> live -> unreachable, and reports refused', () => {
    expect(instanceStatus(undefined, 1000, 0)).toBe('pending');
    expect(instanceStatus(undefined, PENDING_GRACE_MS + 1, 0)).toBe('unreachable');
    expect(instanceStatus({ view: null, lastSeen: 100, refused: false }, 100 + STALE_MS, 0)).toBe('live');
    expect(instanceStatus({ view: null, lastSeen: 100, refused: false }, 101 + STALE_MS, 0)).toBe('unreachable');
    expect(instanceStatus({ view: null, lastSeen: null, refused: true }, 10, 0)).toBe('refused');
  });
});

describe('mergeBoards (P4)', () => {
  it('labels, keys and orders cards newest first across instances, and skips non-live instances', () => {
    const now = 100_000;
    const rec = (view: ReturnType<typeof parsePagerView>, lastSeen: number | null): InstanceRecord => ({ view, lastSeen, refused: false });
    const records = new Map<string, InstanceRecord>([
      ['local', rec(parsePagerView({ busy: [{ sessionId: 'x1', name: 'busy-local' }], waiting: [waiting('s1', '2026-01-01T10:00:00Z')] }), now)],
      ['b1', rec(parsePagerView({ busy: [], waiting: [waiting('s1', '2026-01-01T12:00:00Z')], waitingTruncated: true }), now)],
      ['b2', rec(parsePagerView({ busy: [{ sessionId: 'x2', name: 'old' }], waiting: [waiting('s9', '2026-01-02T00:00:00Z')] }), now - STALE_MS - 1)],
    ]);
    const m = mergeBoards(peers, records, now, 0, 'http://localhost:53000');
    expect(m.waiting.map(w => [w.key, w.instanceName])).toEqual([['b1:s1', 'devbox1'], ['local:s1', 'laptop']]);
    expect(m.busy).toEqual([{ sessionId: 'x1', name: 'busy-local', key: 'local:x1', instanceId: 'local', instanceName: 'laptop' }]);
    expect(m.waitingTruncated).toBe(true);
    expect(m.instances.map(i => i.status)).toEqual(['live', 'live', 'unreachable']);
    expect(m.portalOrigin).toBe('http://localhost:53000');
  });

  it('merges wakes across instances, labeled, soonest first and paused last', () => {
    const now = 100_000;
    const k = (sessionId: string, nextWakeAt: string, over: Record<string, unknown> = {}) => ({ sessionId, name: sessionId, everyHours: 1, nextWakeAt, ...over });
    const records = new Map<string, InstanceRecord>([
      ['local', { view: parsePagerView({ busy: [], waiting: [], wakes: [k('a', '2026-01-01T05:00:00Z'), k('p', '2026-01-01T01:00:00Z', { pausedReason: 'expired' })] }), lastSeen: now, refused: false }],
      ['b1', { view: parsePagerView({ busy: [], waiting: [], wakes: [k('b', '2026-01-01T03:00:00Z')] }), lastSeen: now, refused: false }],
    ]);
    const m = mergeBoards(peers, records, now, 0, 'x');
    expect(m.wakes.map(w => [w.key, w.instanceName])).toEqual([['b1:b', 'devbox1'], ['local:a', 'laptop'], ['local:p', 'laptop']]);
  });
});

function setup() {
  let t = 0;
  const mk = () => ({ postMessage: vi.fn<(msg: unknown, targetOrigin: string) => void>() });
  const frames: Record<string, ReturnType<typeof mk>> = { local: mk(), b1: mk(), b2: mk() };
  const timers: Array<{ fn: () => void; at: number; dead?: boolean }> = [];
  const openSession = vi.fn();
  const pager = createPortalPager({
    getPeers: () => peers,
    getFrameWindow: id => frames[id] ?? null,
    openSession,
    portalOrigin: 'http://localhost:53000',
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimer: h => { (h as { dead?: boolean }).dead = true; },
  });
  const advance = (ms: number) => {
    t += ms;
    for (const h of timers) if (!h.dead && h.at <= t) { h.dead = true; h.fn(); }
  };
  const view = (peerId: string, v: unknown, origin?: string, source?: unknown) => pager.handleMessage({
    origin: origin ?? new URL(peers.find(p => p.id === peerId)!.url).origin,
    source: source ?? frames[peerId],
    data: { type: BRIDGE.VIEW, view: v },
  });
  return { pager, frames, openSession, advance, view };
}

describe('createPortalPager (P5, P6)', () => {
  it('kick sends a watch to every frame with its exact origin', () => {
    const { pager, frames } = setup();
    pager.kick();
    expect(frames.local.postMessage).toHaveBeenCalledWith({ type: BRIDGE.WATCH }, 'http://localhost:53000');
    expect(frames.b1.postMessage).toHaveBeenCalledWith({ type: BRIDGE.WATCH }, 'https://box1.devtunnels.ms');
  });

  it('tick renews watches only after WATCH_EVERY_MS', () => {
    const { pager, frames, advance } = setup();
    pager.tick();
    pager.tick();
    expect(frames.b1.postMessage).toHaveBeenCalledTimes(1);
    advance(WATCH_EVERY_MS);
    pager.tick();
    expect(frames.b1.postMessage).toHaveBeenCalledTimes(2);
  });

  it('accepts a view only when origin and source both match the peer', () => {
    const { pager, frames, view } = setup();
    const v = { busy: [], waiting: [waiting('s1', '2026-01-01T00:00:00Z')] };
    view('b1', v, 'https://evil.example');
    view('b1', v, undefined, frames.b2);
    view('b1', v, 'https://box1.devtunnels.ms.evil.example');
    expect(pager.current().waiting).toEqual([]);
    view('b1', v);
    expect(pager.current().waiting.map(w => w.key)).toEqual(['b1:s1']);
  });

  it('notifies subscribers on change only', () => {
    const { pager, view } = setup();
    const seen: MergedView[] = [];
    pager.subscribe(v => seen.push(v));
    const v = { busy: [], waiting: [waiting('s1', '2026-01-01T00:00:00Z')] };
    view('b1', v);
    view('b1', v);
    expect(seen).toHaveLength(2);
  });

  it('marks a refusing instance refused', () => {
    const { pager, frames } = setup();
    pager.handleMessage({ origin: 'https://box2.devtunnels.ms', source: frames.b2, data: { type: BRIDGE.REFUSED } });
    expect(pager.current().instances.find(i => i.id === 'b2')!.status).toBe('refused');
  });

  it('routes send to the keyed instance and resolves on its result', async () => {
    const { pager, frames } = setup();
    const p = pager.send('b2:s7', 'Go ahead');
    expect(frames.b1.postMessage).not.toHaveBeenCalled();
    const [msg, origin] = frames.b2.postMessage.mock.calls[0] as [Record<string, unknown>, string];
    expect(origin).toBe('https://box2.devtunnels.ms');
    expect(msg).toMatchObject({ type: BRIDGE.ACTION, action: 'send', sessionId: 's7', text: 'Go ahead' });
    // A result from a different instance must not settle it.
    pager.handleMessage({ origin: 'https://box1.devtunnels.ms', source: frames.b1, data: { type: BRIDGE.RESULT, reqId: msg.reqId, ok: false, status: 500 } });
    pager.handleMessage({ origin: 'https://box2.devtunnels.ms', source: frames.b2, data: { type: BRIDGE.RESULT, reqId: msg.reqId, ok: true, status: 200 } });
    await expect(p).resolves.toBeUndefined();
  });

  it('rejects a failed dismiss with its status', async () => {
    const { pager, frames } = setup();
    const p = pager.dismiss('local:s1');
    const [msg] = frames.local.postMessage.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toMatchObject({ action: 'dismiss', sessionId: 's1' });
    expect(msg).not.toHaveProperty('text');
    pager.handleMessage({ origin: 'http://localhost:53000', source: frames.local, data: { type: BRIDGE.RESULT, reqId: msg.reqId, ok: false, status: 409, error: 'busy' } });
    await expect(p).rejects.toMatchObject({ message: 'busy', status: 409 });
  });

  it('times out an unanswered action', async () => {
    const { pager, advance } = setup();
    const p = pager.send('b1:s1', 'hi');
    advance(ACTION_TIMEOUT_MS);
    await expect(p).rejects.toMatchObject({ status: 0, message: 'devbox1 did not answer' });
  });

  it('rejects an action for an unknown instance or bad key', async () => {
    const { pager } = setup();
    await expect(pager.send('zz:s1', 'x')).rejects.toMatchObject({ status: 0 });
    await expect(pager.dismiss('garbage')).rejects.toMatchObject({ status: 0 });
  });

  it('open routes to the owning instance', () => {
    const { pager, openSession } = setup();
    pager.open('b1:s5');
    expect(openSession).toHaveBeenCalledWith('b1', 's5');
  });

  it('a live instance degrades to unreachable when its feed stops', () => {
    const { pager, view, advance } = setup();
    view('b1', { busy: [], waiting: [] });
    expect(pager.current().instances.find(i => i.id === 'b1')!.status).toBe('live');
    advance(STALE_MS + 1);
    expect(pager.current().instances.find(i => i.id === 'b1')!.status).toBe('unreachable');
  });
});
