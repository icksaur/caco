import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { createPeerProxy, routeKey, proxyPathFor, proxyableOrigin, rewriteLocation } from '../../src/peer-proxy.js';
import { parseTrustedHosts } from '../../src/security/same-origin.js';
import type { CacoPeer } from '../../src/peer-store.js';

const peerOf = (origin: string): CacoPeer => ({ url: origin, hostname: 'p', name: 'p', origin, addedBy: 'portal', rev: 1 });

describe('route keys and proxyable peers', () => {
  it('keys by base64url of the full origin', () => {
    expect(routeKey('http://localhost:53001')).toBe(Buffer.from('http://localhost:53001').toString('base64url'));
    expect(routeKey('http://localhost:53001')).not.toBe(routeKey('https://localhost:53001'));
    expect(routeKey('http://localhost:53001')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('proxies loopback and allow-listed origins only', () => {
    const none = new Set<string>();
    expect(proxyableOrigin(peerOf('http://localhost:53001'), none)).toBe('http://localhost:53001');
    expect(proxyableOrigin(peerOf('http://10.0.0.5:53000'), none)).toBeNull();
    expect(proxyableOrigin(peerOf('http://10.0.0.5:53000'), new Set(['http://10.0.0.5:53000']))).toBe('http://10.0.0.5:53000');
    expect(proxyableOrigin({ url: 'http://x:1/odd', hostname: 'o' }, none)).toBeNull();
    expect(proxyPathFor(peerOf('http://localhost:53001'), none)).toBe(`/peer/${routeKey('http://localhost:53001')}/`);
    expect(proxyPathFor(peerOf('http://10.0.0.5:53000'), none)).toBeUndefined();
  });

  it('rewrites peer redirects into the proxied space', () => {
    const o = 'http://localhost:53001', b = '/peer/k/';
    expect(rewriteLocation('/x?y=1', o, b)).toBe('/peer/k/x?y=1');
    expect(rewriteLocation('http://localhost:53001/x', o, b)).toBe('/peer/k/x');
    expect(rewriteLocation('http://localhost:53001', o, b)).toBe('/peer/k/');
    expect(rewriteLocation('http://localhost:53001?a=1', o, b)).toBe('/peer/k/?a=1');
    expect(rewriteLocation('api/x', o, b)).toBe('api/x');
    expect(rewriteLocation('?a=1', o, b)).toBe('/peer/k/?a=1');
    expect(rewriteLocation('https://login.example.com/x', o, b)).toBe('https://login.example.com/x');
    expect(rewriteLocation('//cdn/x', o, b)).toBe('//cdn/x');
  });
});

describe('hub proxy against a real peer (A7)', () => {
  let peer: http.Server, hub: http.Server, wssPeer: WebSocketServer, slow: http.Server;
  let peerOrigin: string, hubOrigin: string, key: string, deadKey: string, slowKey: string;
  let slowSocketClosed: Promise<void>;
  const seen: Array<{ url: string; headers: IncomingHttpHeaders; bytes: number }> = [];
  const wsSeen: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    peer = http.createServer((req, res) => {
      let bytes = 0;
      req.on('data', c => { bytes += c.length; });
      req.on('end', () => {
        seen.push({ url: req.url ?? '', headers: req.headers, bytes });
        if (req.url === '/redir') { res.writeHead(302, { Location: '/landing' }); res.end(); return; }
        if (req.url === '/truncate') { res.writeHead(200, { 'Content-Length': '1000' }); res.write('partial'); setTimeout(() => res.socket?.destroy(), 20); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'keep-alive', 'X-Peer': '1' });
        res.end(JSON.stringify({ url: req.url, bytes }));
      });
    });
    wssPeer = new WebSocketServer({ server: peer, path: '/ws' });
    wssPeer.on('connection', (ws, req) => {
      wsSeen.push(req.headers);
      ws.on('message', m => ws.send(`echo:${m.toString()}`));
    });
    await new Promise<void>(r => peer.listen(0, '127.0.0.1', () => r()));
    peerOrigin = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;
    key = routeKey(peerOrigin);

    const dead = http.createServer();
    await new Promise<void>(r => dead.listen(0, '127.0.0.1', () => r()));
    const deadOrigin = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    await new Promise<void>(r => dead.close(() => r()));
    deadKey = routeKey(deadOrigin);

    // A peer that accepts a WebSocket upgrade request and never answers it.
    slow = http.createServer();
    slowSocketClosed = new Promise<void>(resolve => {
      slow.on('upgrade', (_req, socket) => { socket.on('close', () => resolve()); socket.on('end', () => { resolve(); socket.destroy(); }); socket.resume(); });
    });
    await new Promise<void>(r => slow.listen(0, '127.0.0.1', () => r()));
    const slowOrigin = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    slowKey = routeKey(slowOrigin);

    const proxy = createPeerProxy({
      getPeers: () => [peerOf(peerOrigin), peerOf(deadOrigin), peerOf(slowOrigin), peerOf('http://10.9.9.9:53000')],
      allowRemote: () => new Set(),
      trustedHosts: parseTrustedHosts(undefined),
    });
    hub = http.createServer((req, res) => proxy.middleware(req, res, () => { res.writeHead(418); res.end('hub'); }));
    hub.on('upgrade', (req, socket, head) => {
      if (!proxy.upgrade(req, socket, head)) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    await new Promise<void>(r => hub.listen(0, '127.0.0.1', () => r()));
    hubOrigin = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const c of wssPeer.clients) c.terminate();
    await new Promise<void>(r => wssPeer.close(() => r()));
    peer.closeAllConnections?.(); hub.closeAllConnections?.();
    await new Promise<void>(r => peer.close(() => r()));
    await new Promise<void>(r => hub.close(() => r()));
    slow.closeAllConnections?.();
    await new Promise<void>(r => slow.close(() => r()));
  });

  function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}) {
    return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request(`${hubOrigin}${path}`, { method: opts.method ?? 'GET', headers: opts.headers }, res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end(opts.body);
    });
  }

  it('passes other paths through', async () => {
    expect((await call('/api/sessions')).status).toBe(418);
    expect((await call('/peerless')).status).toBe(418);
  });

  it('forwards as the peer\'s own tab: Host, Origin, prefix header; drops browser credentials', async () => {
    const res = await call(`/peer/${key}/api/x?y=1`, { headers: {
      Origin: hubOrigin, Cookie: 'tunnel=secret', Authorization: 'Bearer t', 'X-Forwarded-For': '1.2.3.4', Referer: `${hubOrigin}/portal.html`, 'X-Custom': 'kept',
    } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: '/api/x?y=1', bytes: 0 });
    expect(res.headers['x-peer']).toBe('1');
    const h = seen.at(-1)!.headers;
    expect(h.host).toBe(new URL(peerOrigin).host);
    expect(h.origin).toBe(peerOrigin);
    expect(h['x-caco-base-path']).toBe(`/peer/${key}/`);
    expect(h['x-custom']).toBe('kept');
    for (const k of ['cookie', 'authorization', 'x-forwarded-for', 'referer']) expect(h[k]).toBeUndefined();
  });

  it('sends no Origin when the browser sent none', async () => {
    await call(`/peer/${key}/`);
    expect(seen.at(-1)!.headers.origin).toBeUndefined();
  });

  it('refuses a foreign Origin, a chained request, and unknown or unproxyable peers', async () => {
    const before = seen.length;
    expect((await call(`/peer/${key}/api/x`, { headers: { Origin: 'http://evil.example' } })).status).toBe(403);
    expect((await call(`/peer/${key}/api/x`, { headers: { 'X-Caco-Base-Path': '/peer/z/' } })).status).toBe(400);
    expect((await call(`/peer/${routeKey('http://localhost:1')}/`)).status).toBe(404);
    expect((await call(`/peer/${routeKey('http://10.9.9.9:53000')}/`)).status).toBe(404);
    expect((await call('/peer/bad.key/')).status).toBe(404);
    expect((await call('/peer')).status).toBe(404);
    expect(seen.length).toBe(before);
  });

  it('redirects the bare prefix to its trailing slash, keeping the query', async () => {
    const a = await call(`/peer/${key}`);
    expect(a.status).toBe(301);
    expect(a.headers.location).toBe(`/peer/${key}/`);
    expect((await call(`/peer/${key}?session=s`)).headers.location).toBe(`/peer/${key}/?session=s`);
  });

  it('rewrites the peer\'s redirects', async () => {
    const r = await call(`/peer/${key}/redir`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(`/peer/${key}/landing`);
  });

  it('streams a JSON POST and a large upload unchanged', async () => {
    const json = JSON.stringify({ prompt: 'hi' });
    const r = await call(`/peer/${key}/api/sessions/s/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: hubOrigin }, body: json });
    expect(JSON.parse(r.body).bytes).toBe(Buffer.byteLength(json));
    const big = Buffer.alloc(6 * 1024 * 1024, 7);
    const u = await call(`/peer/${key}/api/sessions/import`, { method: 'POST', headers: { 'Content-Type': 'application/gzip', Origin: hubOrigin }, body: big });
    expect(JSON.parse(u.body).bytes).toBe(big.length);
  });

  it('ends the browser response when the peer drops mid-response', async () => {
    const outcome = await new Promise<string>(resolve => {
      const req = http.request(`${hubOrigin}/peer/${key}/truncate`, res => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.complete ? 'complete' : 'truncated'));
        res.on('aborted', () => resolve('truncated'));
        res.on('error', () => resolve('truncated'));
        res.on('close', () => resolve(res.complete ? 'complete' : 'truncated'));
      });
      req.on('error', () => resolve('truncated'));
      req.end();
    });
    expect(outcome).toBe('truncated');
  });

  it('cancels the upstream handshake when the browser leaves first', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(hubOrigin).port}/peer/${slowKey}/ws`, { origin: hubOrigin });
    ws.on('error', () => {});
    await new Promise(r => setTimeout(r, 100));
    ws.terminate();
    await expect(Promise.race([slowSocketClosed.then(() => 'closed'), new Promise(r => setTimeout(() => r('hung'), 3000))])).resolves.toBe('closed');
  });

  it('answers 502 when the peer is down', async () => {
    const r = await call(`/peer/${deadKey}/api/x`);
    expect(r.status).toBe(502);
  });

  it('proxies a WebSocket upgrade with the same rewriting', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(hubOrigin).port}/peer/${key}/ws`, { origin: hubOrigin });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('ping'));
      ws.on('message', m => resolve(m.toString()));
      ws.on('error', reject);
    });
    ws.close();
    expect(reply).toBe('echo:ping');
    const h = wsSeen.at(-1)!;
    expect(h.origin).toBe(peerOrigin);
    expect(h.host).toBe(new URL(peerOrigin).host);
    expect(h['x-caco-base-path']).toBe(`/peer/${key}/`);
  });

  it('refuses a WebSocket upgrade from a foreign Origin and for an unknown peer', async () => {
    const statusOf = (path: string, origin: string) => new Promise<number>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${new URL(hubOrigin).port}${path}`, { origin });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
      ws.on('open', () => { ws.close(); resolve(101); });
    });
    expect(await statusOf(`/peer/${key}/ws`, 'http://evil.example')).toBe(403);
    expect(await statusOf(`/peer/${routeKey('http://localhost:1')}/ws`, hubOrigin)).toBe(404);
  });
});
