/**
 * Hub peer proxy (spec-portal-single-port, Phase B).
 *
 * Serves each proxyable peer at `/peer/<key>/` on this instance, so a browser
 * that reaches only this instance (one tunnel) can use every peer. `<key>` is
 * base64url of the peer's normalized origin. Requests are forwarded as if they
 * came from the peer's own same-origin browser tab: Host and Origin are
 * rewritten to the peer, the browser's cookies, authorization and forwarded
 * headers are dropped, and `X-Caco-Base-Path` tells the peer its prefix
 * (Phase A). Bodies stream both ways; nothing is buffered.
 *
 * Mounted before the body parsers. It runs its own same-origin check: only this
 * instance's own browser tab may use it.
 */

import http, { type IncomingMessage, type ServerResponse, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'http';
import https from 'https';
import type { Duplex } from 'stream';
import { getPeers, normalizeOrigin, isLoopbackOrigin, parseAllowRemote, type CacoPeer } from './peer-store.js';
import { isSameOriginRequest, trustedHosts as defaultTrustedHosts } from './security/same-origin.js';
import { BASE_PATH_HEADER } from './page-base.js';

const BASE_HEADER = BASE_PATH_HEADER.toLowerCase();
const PEER_URL_RE = /^\/peer\/([A-Za-z0-9_-]{1,200})(.*)$/s;
/** Request headers never forwarded to a peer. */
const DROP_REQUEST = new Set(['host', 'origin', 'cookie', 'authorization', 'referer', 'forwarded', BASE_HEADER]);
/** Hop-by-hop headers, dropped on plain (non-upgrade) requests and responses. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']);

/** The route key for a normalized origin: base64url, so Express never decodes it. */
export function routeKey(origin: string): string {
  return Buffer.from(origin, 'utf8').toString('base64url');
}

/** The peer's normalized origin when the hub may proxy it (the overview's origin
 *  rule: loopback, or listed in CACO_PEERS_ALLOW_REMOTE), else null. */
export function proxyableOrigin(peer: CacoPeer, allowRemote: Set<string>): string | null {
  const origin = normalizeOrigin(peer.origin ?? peer.url);
  return origin && (isLoopbackOrigin(origin) || allowRemote.has(origin)) ? origin : null;
}

/** `/peer/<key>/` for a proxyable peer, else undefined. */
export function proxyPathFor(peer: CacoPeer, allowRemote: Set<string> = parseAllowRemote(process.env.CACO_PEERS_ALLOW_REMOTE)): string | undefined {
  const origin = proxyableOrigin(peer, allowRemote);
  return origin ? `/peer/${routeKey(origin)}/` : undefined;
}

/** Map a peer redirect into the proxied space: a root path or a URL on the peer's
 *  own origin gets the prefix; relative and foreign URLs are left alone. */
export function rewriteLocation(location: string, peerOrigin: string, base: string): string {
  let loc = location;
  if (loc === peerOrigin || loc.startsWith(peerOrigin + '/') || loc.startsWith(peerOrigin + '?')) loc = loc.slice(peerOrigin.length) || '/';
  if (loc.startsWith('?')) loc = '/' + loc;
  return loc.startsWith('/') && !loc.startsWith('//') ? base + loc.slice(1) : loc;
}

function forwardHeaders(h: IncomingHttpHeaders, target: URL, base: string, upgrade: boolean): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || DROP_REQUEST.has(k) || k.startsWith('x-forwarded-')) continue;
    if (!upgrade && HOP_BY_HOP.has(k)) continue;
    out[k] = v;
  }
  out.host = target.host;
  if (h.origin !== undefined) out.origin = target.origin;
  out[BASE_HEADER] = base;
  return out;
}

export interface PeerProxyDeps {
  getPeers?: () => CacoPeer[];
  allowRemote?: () => Set<string>;
  trustedHosts?: ReadonlySet<string>;
}

type Resolved =
  | { kind: 'pass' }
  | { kind: 'error'; status: number; text: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'proxy'; target: URL; base: string; path: string };

export function createPeerProxy(deps: PeerProxyDeps = {}) {
  const peers = deps.getPeers ?? (() => getPeers());
  const allowRemote = deps.allowRemote ?? (() => parseAllowRemote(process.env.CACO_PEERS_ALLOW_REMOTE));
  const trusted = deps.trustedHosts ?? defaultTrustedHosts;

  function resolve(req: IncomingMessage): Resolved {
    const url = req.url ?? '';
    if (url !== '/peer' && !url.startsWith('/peer/') && !url.startsWith('/peer?')) return { kind: 'pass' };
    if (req.headers[BASE_HEADER] !== undefined) return { kind: 'error', status: 400, text: 'Already proxied.' };
    if (!isSameOriginRequest(req.headers.origin, req.headers.host, trusted)) {
      console.warn(`[PEER-PROXY] Rejected cross-origin request: origin=${req.headers.origin ?? '(none)'} host=${req.headers.host ?? '(none)'}`);
      return { kind: 'error', status: 403, text: 'Forbidden.' };
    }
    const m = PEER_URL_RE.exec(url);
    if (!m) return { kind: 'error', status: 404, text: 'Unknown peer.' };
    const [, key, rest] = m;
    const allow = allowRemote();
    let origin: string | null = null;
    for (const p of peers()) {
      const o = proxyableOrigin(p, allow);
      if (o && routeKey(o) === key) { origin = o; break; }
    }
    if (!origin) return { kind: 'error', status: 404, text: 'Unknown peer.' };
    const base = `/peer/${key}/`;
    if (!rest.startsWith('/')) return { kind: 'redirect', location: base.slice(0, -1) + '/' + rest };
    return { kind: 'proxy', target: new URL(origin), base, path: rest };
  }

  function requestOptions(target: URL, method: string, path: string, headers: OutgoingHttpHeaders): http.RequestOptions {
    return {
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method,
      path,
      headers,
    };
  }

  /** Express/Node middleware: proxies `/peer/...`, passes anything else on. */
  function middleware(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const r = resolve(req);
    if (r.kind === 'pass') { next(); return; }
    if (r.kind === 'error') {
      res.writeHead(r.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(r.text);
      return;
    }
    if (r.kind === 'redirect') {
      res.writeHead(301, { Location: r.location });
      res.end();
      return;
    }
    const mod = r.target.protocol === 'https:' ? https : http;
    const headers = forwardHeaders(req.headers, r.target, r.base, false);
    const up = mod.request(requestOptions(r.target, req.method ?? 'GET', r.path, headers), upRes => {
      const out: OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
      }
      if (typeof out.location === 'string') out.location = rewriteLocation(out.location, r.target.origin, r.base);
      res.writeHead(upRes.statusCode ?? 502, out);
      // A peer that goes away mid-response (restart, dropped forward) must not
      // leave the browser's response hanging open.
      upRes.on('aborted', () => res.destroy());
      upRes.on('error', () => res.destroy());
      upRes.on('close', () => { if (!upRes.complete) res.destroy(); });
      upRes.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Peer unreachable.');
      } else {
        res.destroy();
      }
    });
    // A client that goes away (e.g. a long poll is abandoned) cancels the upstream request.
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  }

  /** HTTP server 'upgrade' handler. Returns false for paths outside `/peer/`. */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const r = resolve(req);
    if (r.kind === 'pass') return false;
    socket.on('error', () => socket.destroy());
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return true;
    };
    if (r.kind === 'error') return refuse(r.status, r.status === 403 ? 'Forbidden' : r.status === 400 ? 'Bad Request' : 'Not Found');
    if (r.kind === 'redirect') return refuse(404, 'Not Found');
    const mod = r.target.protocol === 'https:' ? https : http;
    const up = mod.request(requestOptions(r.target, 'GET', r.path, forwardHeaders(req.headers, r.target, r.base, true)));
    // A browser that leaves before the peer answers cancels the upstream handshake.
    // An upgrade socket starts paused and would never notice the close, so it
    // flows until the handshake completes; any early bytes are held and replayed.
    // HTTP server sockets are half-open, so a browser's FIN is 'end', not 'close'.
    const cancel = () => { up.destroy(); socket.destroy(); };
    const early: Buffer[] = [];
    const hold = (chunk: Buffer) => { early.push(chunk); };
    socket.once('close', cancel);
    socket.once('end', cancel);
    socket.on('data', hold);
    up.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}`];
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      socket.off('close', cancel);
      socket.off('end', cancel);
      socket.off('data', hold);
      socket.pause();
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      for (const chunk of early) upSocket.write(chunk);
      upSocket.on('error', () => socket.destroy());
      upSocket.on('close', () => socket.destroy());
      socket.on('close', () => upSocket.destroy());
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    up.on('response', upRes => {
      upRes.resume();
      refuse(upRes.statusCode ?? 502, upRes.statusMessage ?? 'Bad Gateway');
    });
    up.on('error', () => { if (socket.writable) refuse(502, 'Bad Gateway'); });
    up.end();
    return true;
  }

  return { middleware, upgrade };
}
