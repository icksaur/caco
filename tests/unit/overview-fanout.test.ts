/**
 * scope=all fan-out (spec-session-overview, O5) against real loopback HTTP
 * peers: merge, unreachable, outdated, invalid, impostor, self, skipped,
 * redirect refused, size cap, per-peer timeout, deadline, parallel cap, hop
 * header, and never /api/sessions.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { fetchPeerOverviews, validateOverviewPayload, type FanoutOptions } from '../../src/overview-fanout.js';
import { buildSessionOverview, mergeSessionOverviews, type OverviewSessionInput, type SessionOverview } from '../../src/session-overview.js';
import type { CacoPeer } from '../../src/peer-store.js';

const NOW = Date.parse('2026-11-17T18:00:00Z');
const SELF = 'aaaaaaaa-0000-4000-8000-000000000000';

function overview(id: string, name: string, sessions: Array<{ sid: string; meta?: OverviewSessionInput['meta'] }>): SessionOverview {
  return buildSessionOverview({
    instance: { id, name },
    sessions: sessions.map(s => ({
      sessionId: s.sid, cwd: null, meta: s.meta ?? { name: s.sid, lastUsedAt: new Date(NOW - 3_600_000 * 3).toISOString() },
      tail: { context: { status: 'ok', lastEventAt: new Date(NOW - 3_600_000).toISOString() } },
    })),
    archiveFolder: 'auto-archive', wakeLoopEnabled: true, contextRead: true,
  }, NOW);
}

interface FakePeer { origin: string; server: Server; hits: Array<{ url: string; hop?: string }> }
const servers: Server[] = [];

async function peer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<FakePeer> {
  const hits: FakePeer['hits'] = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url ?? '', hop: req.headers['x-caco-overview-hop'] as string | undefined });
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, hits };
}
const json = (body: unknown, status = 200) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const p = (origin: string, name = 'peer', extra: Partial<CacoPeer> = {}): CacoPeer => ({ url: origin, hostname: name, name, origin, ...extra });
const run = (peers: CacoPeer[], over: Partial<FanoutOptions> = {}) =>
  fetchPeerOverviews({ peers, selfId: SELF, allowRemote: new Set(), context: 'brief', ...over });

afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections?.(); await new Promise(r => s.close(() => r(undefined))); }
});

describe('fetchPeerOverviews (O5)', () => {
  it('fetches a valid peer with the hop header, scope=local only, and records its id', async () => {
    const id = 'bbbbbbbb-0000-4000-8000-000000000001';
    const a = await peer(json(overview(id, 'devbox', [{ sid: 's1' }])));
    const seen: string[] = [];
    const [r] = await run([p(a.origin, 'devbox')], { onIdentity: (o, i) => seen.push(`${o}=${i}`) });
    expect(r).toMatchObject({ status: 'ok', instance: { id, name: 'devbox', origin: a.origin.replace('127.0.0.1', '127.0.0.1') } });
    expect(r.overview!.entries[0].key).toBe(`${id}:s1`);
    expect(a.hits).toEqual([{ url: '/api/overview?scope=local&show=all&context=brief', hop: '1' }]);
    expect(seen).toEqual([`${r.instance.origin}=${id}`]);
  });

  it('reports unreachable, outdated (404 or another schemaVersion), invalid JSON and an impostor without failing (R5)', async () => {
    const closed = await peer(json({}));
    const closedOrigin = closed.origin;
    await new Promise(r => closed.server.close(() => r(undefined)));
    servers.splice(servers.indexOf(closed.server), 1);
    const outdated = await peer(json({ error: 'nope' }, 404));
    const notJson = await peer((_q, res) => { res.writeHead(200); res.end('<html>'); });
    // A v1 peer (r5 payload: flags, tier) is outdated, never merged.
    const v1Body = { ...overview('cccccccc-0000-4000-8000-000000000002', 'x', [{ sid: 's' }]), schemaVersion: 1 } as unknown as { entries: Array<Record<string, unknown>> };
    v1Body.entries[0].flags = [{ code: 'no-driver', detail: 'x', confidence: 'high' }];
    v1Body.entries[0].tier = 'full';
    const v1 = await peer(json(v1Body));
    const noVersion = await peer(json({ instance: { id: 'x', name: 'x' } }));
    const imp = overview('dddddddd-0000-4000-8000-000000000003', 'imp', [{ sid: 's' }]);
    imp.entries[0] = { ...imp.entries[0], key: 'someone-else:s' };
    const impostor = await peer(json(imp));
    const err500 = await peer(json({}, 500));
    const rs = await run([p(closedOrigin), p(outdated.origin), p(notJson.origin), p(v1.origin), p(noVersion.origin), p(impostor.origin), p(err500.origin)]);
    expect(rs.map(r => [r.status, r.reason])).toEqual([
      ['unreachable', 'network error'],
      ['outdated', 'no /api/overview'],
      ['invalid', 'not JSON'],
      ['outdated', 'schemaVersion 1'],
      ['outdated', 'no schemaVersion'],
      ['invalid', 'entry from another instance'],
      ['unreachable', 'HTTP 500'],
    ]);
    expect(rs.every(r => typeof r.fetchedAt === 'string' && !r.overview)).toBe(true);
    expect(outdated.hits.map(h => h.url)).toEqual(['/api/overview?scope=local&show=all&context=brief']);
  });

  it('a peer reporting our own instance id is self; a known self id is not fetched', async () => {
    const mirror = await peer(json(overview(SELF, 'me', [{ sid: 's' }])));
    const [r1] = await run([p(mirror.origin)]);
    expect(r1.status).toBe('self');
    const [r2] = await run([p(mirror.origin, 'me', { id: SELF })]);
    expect(r2.status).toBe('self');
    expect(mirror.hits).toHaveLength(1);
  });

  it('non-loopback peers are skipped unless allowlisted; invalid origins are invalid', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(overview('eeeeeeee-0000-4000-8000-000000000004', 'r', [])), { status: 200 }));
    const remote = 'http://10.1.2.3:53000';
    const rs = await run([p(remote), { url: 'http://x:1/path', hostname: 'bad' }], { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(rs.map(r => [r.status, r.reason])).toEqual([['skipped', 'needs browser auth'], ['invalid', 'invalid origin']]);
    expect(fetchImpl).not.toHaveBeenCalled();
    const [ok] = await run([p(remote)], { fetchImpl: fetchImpl as unknown as typeof fetch, allowRemote: new Set([remote]) });
    expect(ok.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledWith(`${remote}/api/overview?scope=local&show=all&context=brief`, expect.objectContaining({ redirect: 'error' }));
  });

  it('refuses redirects (the target is never called)', async () => {
    const target = await peer(json(overview('ffffffff-0000-4000-8000-000000000005', 't', [])));
    const redirector = await peer((_q, res) => { res.writeHead(302, { Location: `${target.origin}/api/overview?scope=local` }); res.end(); });
    const [r] = await run([p(redirector.origin)]);
    expect(r.status).toBe('invalid');
    expect(r.reason).toBe('redirect refused');
    expect(target.hits).toHaveLength(0);
  });

  it('caps the body size, declared or streamed', async () => {
    const big = JSON.stringify(overview('11111111-0000-4000-8000-000000000006', 'big', Array.from({ length: 50 }, (_, i) => ({ sid: `s${i}` }))));
    const declared = await peer((_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(big) }); res.end(big); });
    const streamed = await peer((_q, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      for (let i = 0; i < big.length; i += 500) res.write(big.slice(i, i + 500));
      res.end();
    });
    const rs = await run([p(declared.origin), p(streamed.origin)], { maxBytes: 2000 });
    expect(rs.map(r => [r.status, r.reason])).toEqual([['invalid', 'response too large'], ['invalid', 'response too large']]);
    const [ok] = await run([p(streamed.origin)]);
    expect(ok.status).toBe('ok');
  });

  it('a slow peer times out per peer; the whole call has a deadline', async () => {
    const slow = await peer((_q, res) => { setTimeout(() => json(overview('22222222-0000-4000-8000-000000000007', 's', []))(_q, res), 1500); });
    const fast = await peer(json(overview('33333333-0000-4000-8000-000000000008', 'f', [])));
    const t0 = Date.now();
    const [r] = await run([p(slow.origin)], { perPeerTimeoutMs: 100 });
    expect(r).toMatchObject({ status: 'unreachable', reason: 'timeout' });
    const rs = await run([p(slow.origin), p(slow.origin), p(fast.origin)], { maxParallel: 1, deadlineMs: 200, perPeerTimeoutMs: 5000 });
    expect(rs.map(x => x.status)).toEqual(['unreachable', 'unreachable', 'unreachable']);
    expect(rs.map(x => x.reason)).toEqual(['deadline', 'deadline', 'deadline']);
    expect(Date.now() - t0).toBeLessThan(1400);
  });

  it('fetches at most 8 peers in parallel', async () => {
    let inFlight = 0, max = 0;
    const fetchImpl = (async () => {
      inFlight++; max = Math.max(max, inFlight);
      await new Promise(r => setTimeout(r, 20));
      inFlight--;
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
    const peers = Array.from({ length: 12 }, (_, i) => p(`http://127.0.0.1:${40000 + i}`));
    const rs = await run(peers, { fetchImpl });
    expect(max).toBe(8);
    expect(rs.every(r => r.status === 'outdated')).toBe(true);
  });

  it('a peer with malformed nested data is invalid, never a thrown error', async () => {
    const o = overview('66666666-0000-4000-8000-00000000000b', 'm', [{ sid: 's' }]) as unknown as { entries: Array<Record<string, unknown>> };
    o.entries[0].waits = [null];
    const a = await peer(json(o));
    const [r] = await run([p(a.origin)]);
    expect(r).toMatchObject({ status: 'invalid', reason: 'bad wait' });
  });

  it('never calls /api/sessions', async () => {
    const a = await peer(json(overview('44444444-0000-4000-8000-000000000009', 'a', [])));
    await run([p(a.origin)], { context: 'full' });
    expect(a.hits.every(h => h.url.startsWith('/api/overview?scope=local'))).toBe(true);
    expect(a.hits.some(h => h.url.includes('/api/sessions'))).toBe(false);
  });
});

describe('validateOverviewPayload', () => {
  const base = () => overview('55555555-0000-4000-8000-00000000000a', 'v', [{ sid: 's' }]);
  type Mut = (e: Record<string, unknown>) => void;
  it.each<[string, Mut]>([
    ['null wait', e => { e.waits = [null]; }],
    ['wait without kind', e => { e.waits = [{}]; }],
    ['unknown wait kind', e => { e.waits = [{ kind: 'bogus' }]; }],
    ['wake wait without nextAt', e => { e.waits = [{ kind: 'wake' }]; }],
    ['numeric title', e => { e.title = 42; }],
    ['bad activity', e => { e.activity = null; }],
    ['context null', e => { e.context = null; }],
    ['context lastUser without text', e => { e.context = { status: 'ok', lastUser: { at: 'x', source: 'user' } }; }],
    ['wake without counters', e => { e.wake = { everyHours: 1, nextWakeAt: 'x', registeredAt: 'x', consecutiveFailures: 0, slotSeq: 0, history: [], defers: [] }; }],
    ['wake history item null', e => { e.wake = { ...(base().entries[0] as unknown as Record<string, unknown>), everyHours: 1, nextWakeAt: 'x', registeredAt: 'x', consecutiveFailures: 0, slotSeq: 0, counters: { fires: 0, ok: 0, errors: 0, cancelled: 0, interrupted: 0, offered: 0, firesSinceHuman: 0 }, history: [null], defers: [] }; }],
    ['offer options not strings', e => { e.offer = { options: [1], at: null, dismissed: false, ageMs: null, onPager: false }; }],
    ['offer missing onPager', e => { e.offer = { options: [], at: null, dismissed: false, ageMs: null }; }],
    ['herd parentState bogus', e => { e.herd = { parentState: 'gone' }; }],
    ['busy since number', e => { e.busy = { since: 5 }; }],
    ['lastActivityAt object', e => { e.lastActivityAt = {}; }],
    ['duplicateOn not an array', e => { e.duplicateOn = 'devbox'; }],
    ['duplicateOn with a number', e => { e.duplicateOn = [3]; }],
    ['wake.nextIsFinal false', e => { e.wake = { everyHours: 1, nextWakeAt: 'x', registeredAt: 'x', consecutiveFailures: 0, slotSeq: 0, counters: { fires: 0, ok: 0, errors: 0, cancelled: 0, interrupted: 0, offered: 0, firesSinceHuman: 0 }, history: [], defers: [], nextIsFinal: false }; }],
    ['cwd number', e => { e.cwd = 3; }],
  ])('rejects an entry with %s', (_label, mut) => {
    const v = structuredClone(base()) as unknown as { entries: Array<Record<string, unknown>> };
    mut(v.entries[0]);
    expect(validateOverviewPayload(v).ok).toBe(false);
  });

  it('rejects ids that are not plain tokens', () => {
    const b = base();
    expect(validateOverviewPayload({ ...b, instance: { id: 'a\n### X', name: 'n' } }).ok).toBe(false);
    const v = structuredClone(b) as unknown as { entries: Array<Record<string, unknown>> };
    v.entries[0].sessionId = 's\nx';
    v.entries[0].key = `${b.instance.id}:s\nx`;
    expect(validateOverviewPayload(v).ok).toBe(false);
  });

  it('rejects null entries and a null instance', () => {
    expect(validateOverviewPayload({ ...base(), entries: [null] }).ok).toBe(false);
    expect(validateOverviewPayload({ ...base(), instance: null }).ok).toBe(false);
  });

  it('rebuilds entries from known fields only', () => {
    const v = structuredClone(base()) as unknown as { entries: Array<Record<string, unknown>> };
    v.entries[0].evil = { __proto__: 'x' };
    const r = validateOverviewPayload(v);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('evil' in r.value.entries[0]).toBe(false);
      expect(r.value.entries[0]).toEqual(base().entries[0]);
    }
  });

  it('accepts a real overview and rejects malformed ones', () => {
    const ok = overview('55555555-0000-4000-8000-00000000000a', 'v', [{ sid: 's' }]);
    expect(validateOverviewPayload(ok).ok).toBe(true);
    expect(validateOverviewPayload(null)).toMatchObject({ ok: false });
    expect(validateOverviewPayload({ ...ok, counts: {} })).toMatchObject({ ok: false, reason: 'bad counts' });
    // Removed r5 fields are dropped, not echoed; new r6 fields are kept.
    const withOld = structuredClone(ok) as unknown as { entries: Array<Record<string, unknown>>; counts: Record<string, unknown> };
    Object.assign(withOld.entries[0], { flags: [{ code: 'no-driver' }], tier: 'full', primaryFlag: 'no-driver', ask: { matched: '?' }, duplicateOn: ['devbox'] });
    Object.assign(withOld.counts, { omittedFlagged: 1, full: 1, compact: 0 });
    const r = validateOverviewPayload(withOld);
    expect(r.ok).toBe(true);
    if (r.ok) {
      for (const k of ['flags', 'tier', 'primaryFlag', 'ask']) expect(k in r.value.entries[0]).toBe(false);
      expect(r.value.entries[0].duplicateOn).toEqual(['devbox']);
      expect(r.value.counts).toEqual({ total: 1, shown: 1, omitted: 0, archivedExcluded: 0 });
    }
    const otherInstance = structuredClone(ok);
    otherInstance.entries[0].instance = { id: 'zzz', name: 'z' };
    expect(validateOverviewPayload(otherInstance)).toMatchObject({ ok: false, reason: 'entry from another instance' });
  });
});

describe('mergeSessionOverviews', () => {
  const a = () => overview('aaaa0000-0000-4000-8000-000000000001', 'laptop', [{ sid: 'shared' }, { sid: 'only-a' }]);
  const b = () => overview('bbbb0000-0000-4000-8000-000000000002', 'devbox', [{ sid: 'shared' }, { sid: 'only-b' }]);

  it('sets duplicateOn on both copies of a session id present on two instances (R3)', () => {
    const m = mergeSessionOverviews([a(), b()]);
    const shared = m.entries.filter(e => e.sessionId === 'shared');
    expect(shared).toHaveLength(2);
    expect(shared.find(e => e.instance.name === 'laptop')!.duplicateOn).toEqual(['devbox']);
    expect(shared.find(e => e.instance.name === 'devbox')!.duplicateOn).toEqual(['laptop']);
    expect(m.entries.filter(e => e.sessionId !== 'shared').every(e => e.duplicateOn === undefined)).toBe(true);
    expect(m.counts).toEqual({ total: 4, shown: 4, omitted: 0, archivedExcluded: 0 });
  });

  it('is independent of instance arrival order and filters after merging', () => {
    const order = (parts: SessionOverview[]) => mergeSessionOverviews(parts).entries.map(e => e.key);
    expect(order([b(), a()])).toEqual(order([a(), b()]));
    const keyed = mergeSessionOverviews([a(), b()], { keys: ['shared'] });
    expect(keyed.entries.map(e => e.sessionId)).toEqual(['shared', 'shared']);
    expect(keyed.counts).toMatchObject({ shown: 2, omitted: 2 });
    // Re-merging recomputes duplicateOn; it does not stack.
    const again = mergeSessionOverviews([{ ...a(), entries: mergeSessionOverviews([a(), b()]).entries.filter(e => e.instance.name === 'laptop') }, b()]);
    expect(again.entries.find(e => e.instance.name === 'laptop' && e.sessionId === 'shared')!.duplicateOn).toEqual(['devbox']);
  });
});
