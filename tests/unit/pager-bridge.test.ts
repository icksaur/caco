import { describe, it, expect, vi } from 'vitest';
import {
  BRIDGE, parseBridgeRequest, isAllowedParentOrigin, actionRequest, originOf, installPagerBridge,
  type PagerBridgeDeps,
} from '../../public/ts/pager-bridge.js';

describe('parseBridgeRequest (P1)', () => {
  it('accepts watch, send and dismiss', () => {
    expect(parseBridgeRequest({ type: BRIDGE.WATCH })).toEqual({ type: BRIDGE.WATCH });
    expect(parseBridgeRequest({ type: BRIDGE.ACTION, reqId: 'r1', action: 'send', sessionId: 'abc-1', text: '  go  ' }))
      .toEqual({ type: BRIDGE.ACTION, reqId: 'r1', action: 'send', sessionId: 'abc-1', text: 'go' });
    expect(parseBridgeRequest({ type: BRIDGE.ACTION, reqId: 'r1', action: 'dismiss', sessionId: 'abc' }))
      .toEqual({ type: BRIDGE.ACTION, reqId: 'r1', action: 'dismiss', sessionId: 'abc' });
  });

  it.each([
    null, 'x', {}, { type: 'caco:status' },
    { type: BRIDGE.ACTION, reqId: 'r1', action: 'delete', sessionId: 'abc' },
    { type: BRIDGE.ACTION, reqId: 'r1', action: 'send', sessionId: 'abc' },
    { type: BRIDGE.ACTION, reqId: 'r1', action: 'send', sessionId: 'abc', text: '   ' },
    { type: BRIDGE.ACTION, reqId: 'r1', action: 'send', sessionId: '../x', text: 'hi' },
    { type: BRIDGE.ACTION, reqId: 'r 1', action: 'dismiss', sessionId: 'abc' },
    { type: BRIDGE.ACTION, action: 'dismiss', sessionId: 'abc' },
    { type: BRIDGE.ACTION, reqId: 'r1', action: 'send', sessionId: 'abc', text: 'x'.repeat(100_001) },
  ])('rejects %j', (msg) => {
    expect(parseBridgeRequest(msg)).toBeNull();
  });
});

describe('origins (P2)', () => {
  it('allows own origin and exact listed origins only', () => {
    const own = 'https://box-1.devtunnels.ms';
    expect(isAllowedParentOrigin(own, own, [])).toBe(true);
    expect(isAllowedParentOrigin('http://localhost:53000', own, ['http://localhost:53000'])).toBe(true);
    expect(isAllowedParentOrigin('http://localhost:53001', own, ['http://localhost:53000'])).toBe(false);
    expect(isAllowedParentOrigin('http://localhost:53000.evil.com', own, ['http://localhost:53000'])).toBe(false);
    expect(isAllowedParentOrigin('null', own, ['null'])).toBe(false);
    expect(isAllowedParentOrigin('', own, [])).toBe(false);
  });

  it('originOf normalizes urls and rejects non-http', () => {
    expect(originOf('https://a.b:8443/x?y')).toBe('https://a.b:8443');
    expect(originOf('javascript:alert(1)')).toBeNull();
    expect(originOf(5)).toBeNull();
  });
});

describe('actionRequest (P3)', () => {
  it('maps send and dismiss to the same routes as pager.html', () => {
    expect(actionRequest({ type: BRIDGE.ACTION, reqId: 'r', action: 'send', sessionId: 's1', text: 'hi' }))
      .toEqual({ url: '/api/sessions/s1/messages', body: { prompt: 'hi' } });
    expect(actionRequest({ type: BRIDGE.ACTION, reqId: 'r', action: 'dismiss', sessionId: 's1' }))
      .toEqual({ url: '/api/sessions/s1/pager-dismiss', body: {} });
  });
});

function harness(opts: { allowed?: string[]; fetchImpl?: PagerBridgeDeps['fetchFn'] } = {}) {
  const posted: Array<{ msg: Record<string, unknown>; origin: string }> = [];
  const parent = { postMessage: (msg: Record<string, unknown>, origin: string) => { posted.push({ msg, origin }); } };
  let listener: ((e: MessageEvent) => void) | null = null;
  const win = {
    parent,
    location: { origin: 'https://box.example' },
    addEventListener: (_t: 'message', fn: (e: MessageEvent) => void) => { listener = fn; },
  };
  const fetchFn = opts.fetchImpl ?? (vi.fn(() => new Promise(() => {})) as unknown as typeof fetch);
  let t = 1000;
  const bridge = installPagerBridge({
    win, allowed: opts.allowed ?? ['http://localhost:53000'], fetchFn,
    now: () => t, sleep: () => new Promise(() => {}),
  });
  const send = (data: unknown, origin = 'http://localhost:53000', source: unknown = parent) =>
    listener!({ data, origin, source } as unknown as MessageEvent);
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return { posted, send, flush, fetchFn, bridge, parent, advance: (ms: number) => { t += ms; } };
}

describe('installPagerBridge (P2, P3)', () => {
  it('ignores messages not from the parent window', async () => {
    const h = harness();
    h.send({ type: BRIDGE.WATCH }, 'http://localhost:53000', {});
    await h.flush();
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.posted).toEqual([]);
  });

  it('answers a disallowed origin with refused only, never data or actions', async () => {
    const h = harness();
    h.send({ type: BRIDGE.WATCH }, 'https://evil.example');
    h.send({ type: BRIDGE.ACTION, reqId: 'r1', action: 'send', sessionId: 's1', text: 'rm -rf' }, 'https://evil.example');
    await h.flush();
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.posted).toEqual([
      { msg: { type: BRIDGE.REFUSED }, origin: 'https://evil.example' },
      { msg: { type: BRIDGE.REFUSED }, origin: 'https://evil.example' },
    ]);
  });

  it('ignores malformed requests even from an allowed origin', async () => {
    const h = harness();
    h.send({ type: BRIDGE.ACTION, reqId: 'r1', action: 'nuke', sessionId: 's1' });
    await h.flush();
    expect(h.posted).toEqual([]);
  });

  it('watch starts a feed that posts the pager view to the exact parent origin', async () => {
    const view = { version: 3, busy: [], waiting: [] };
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(view) })
      .mockImplementation(() => new Promise(() => {}));
    const h = harness({ fetchImpl: fetchFn as unknown as typeof fetch });
    h.send({ type: BRIDGE.WATCH });
    await h.flush();
    expect(fetchFn.mock.calls[0][0]).toBe('/api/pager?wait=0');
    expect(fetchFn.mock.calls[1][0]).toBe('/api/pager?wait=10000&since=3');
    expect(h.posted).toEqual([{ msg: { type: BRIDGE.VIEW, view }, origin: 'http://localhost:53000' }]);
    expect(h.bridge.feedRunning()).toBe(true);
  });

  it('own origin is allowed without configuration', async () => {
    const h = harness({ allowed: [] });
    h.send({ type: BRIDGE.WATCH }, 'https://box.example');
    await h.flush();
    expect(h.fetchFn).toHaveBeenCalled();
  });

  it('performs a send and reports the result', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    const h = harness({ fetchImpl: fetchFn as unknown as typeof fetch });
    h.send({ type: BRIDGE.ACTION, reqId: 'r1', action: 'send', sessionId: 's1', text: 'Ship it' });
    await h.flush();
    expect(fetchFn).toHaveBeenCalledWith('/api/sessions/s1/messages', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ prompt: 'Ship it' }),
    }));
    expect(h.posted).toEqual([{ msg: { type: BRIDGE.RESULT, reqId: 'r1', ok: true, status: 200 }, origin: 'http://localhost:53000' }]);
  });

  it('reports a failed dismiss with its status and server error', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 409, json: () => Promise.resolve({ error: 'busy' }) });
    const h = harness({ fetchImpl: fetchFn as unknown as typeof fetch });
    h.send({ type: BRIDGE.ACTION, reqId: 'r2', action: 'dismiss', sessionId: 's1' });
    await h.flush();
    expect(fetchFn.mock.calls[0][0]).toBe('/api/sessions/s1/pager-dismiss');
    expect(h.posted[0].msg).toEqual({ type: BRIDGE.RESULT, reqId: 'r2', ok: false, status: 409, error: 'busy' });
  });

  it('reports a network failure as status 0', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('down'));
    const h = harness({ fetchImpl: fetchFn as unknown as typeof fetch });
    h.send({ type: BRIDGE.ACTION, reqId: 'r3', action: 'dismiss', sessionId: 's1' });
    await h.flush();
    expect(h.posted[0].msg).toMatchObject({ ok: false, status: 0 });
  });
});
