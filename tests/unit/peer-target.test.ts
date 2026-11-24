import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolvePeerTarget, peerFetch, peerKey, PEER_HOP_HEADER } from '../../src/peer-target.js';
import type { CacoPeer } from '../../src/peer-store.js';

const peer = (name: string, origin: string, id?: string): CacoPeer =>
  ({ url: origin, hostname: name, name, origin, addedBy: 'portal', rev: 1, ...(id && { id }) });

const deps = {
  self: { id: 'self-id', name: 'Laptop' },
  peers: [
    peer('devbox', 'http://localhost:53001', 'dev-id'),
    peer('twin', 'http://localhost:53002'),
    peer('twin', 'http://localhost:53003'),
    peer('far', 'http://10.0.0.5:53000', 'far-id'),
    peer('a:b', 'http://localhost:53004'),
  ],
  allowRemote: new Set<string>(),
};

describe('resolvePeerTarget', () => {
  it('treats bare ids, prefixed ids and self keys as local', () => {
    expect(resolvePeerTarget('abc', deps)).toEqual({ kind: 'local', sessionId: 'abc' });
    expect(resolvePeerTarget(' caco-session:abc ', deps)).toEqual({ kind: 'local', sessionId: 'abc' });
    expect(resolvePeerTarget('self-id:abc', deps)).toEqual({ kind: 'local', sessionId: 'abc' });
    expect(resolvePeerTarget('laptop:abc', deps)).toEqual({ kind: 'local', sessionId: 'abc' });
  });

  it('resolves a peer by id, then by name', () => {
    expect(resolvePeerTarget('dev-id:s1', deps)).toEqual({ kind: 'peer', sessionId: 's1', peer: { origin: 'http://localhost:53001', name: 'devbox', id: 'dev-id' } });
    expect(resolvePeerTarget('DevBox:s1', deps)).toMatchObject({ kind: 'peer', peer: { id: 'dev-id' } });
    expect(resolvePeerTarget('caco-session:dev-id:s1', deps)).toMatchObject({ kind: 'peer', sessionId: 's1' });
  });

  it('splits at the last colon', () => {
    expect(resolvePeerTarget('a:b:s1', deps)).toMatchObject({ kind: 'peer', sessionId: 's1', peer: { origin: 'http://localhost:53004' } });
  });

  it('reports unknown, ambiguous and unreachable instances', () => {
    expect(resolvePeerTarget('nope:s1', deps)).toEqual({ kind: 'error', error: 'Unknown instance "nope". Run caco_sessions_overview to list instances.' });
    expect(resolvePeerTarget('twin:s1', deps)).toEqual({ kind: 'error', error: 'Instance name "twin" matches more than one peer; use the instance id.' });
    expect(resolvePeerTarget('far-id:s1', deps)).toMatchObject({ kind: 'error', error: expect.stringContaining('not reachable') });
    expect(resolvePeerTarget('far-id:s1', { ...deps, allowRemote: new Set(['http://10.0.0.5:53000']) })).toMatchObject({ kind: 'peer' });
  });

  it('prints keys like the overview', () => {
    expect(peerKey({ origin: 'o', name: 'devbox', id: 'dev-id' }, 's1')).toBe('dev-id:s1');
    expect(peerKey({ origin: 'o', name: 'devbox' }, 's1')).toBe('devbox:s1');
  });
});

describe('peerFetch', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends the hop header, refuses redirects, and parses JSON', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ ok: 1 }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await peerFetch('http://localhost:53001', '/api/x', { method: 'POST', body: { a: 1 } });
    expect(r).toEqual({ status: 201, json: { ok: 1 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:53001/api/x');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>)[PEER_HOP_HEADER]).toBe('1');
    expect(init.body).toBe('{"a":1}');
  });

  it('returns null json for a non-JSON body and rejects an oversized one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
    expect(await peerFetch('http://localhost:1', '/x')).toEqual({ status: 500, json: null });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'content-length': String(5 * 1024 * 1024) } })));
    await expect(peerFetch('http://localhost:1', '/x')).rejects.toThrow();
  });
});
