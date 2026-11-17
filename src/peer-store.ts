/**
 * Peer store — known Caco peers (other instances, used by the portal and the
 * session overview fan-out).
 *
 * Persisted as ~/.caco/peers.json. Entries written by older portals are just
 * `{url, hostname}`; they are read as `addedBy: 'portal'` with an `origin`
 * derived from `url` when it is valid. `CACO_PEERS` (`name=origin,...`) adds
 * `config` peers at read time; they cannot be removed through the API. The
 * mutations change one entry at a time (`addPeer`, `removePeer`); the legacy
 * whole-list write is `mergePeers`, which never deletes, so a stale portal tab
 * cannot drop a peer (spec-session-overview).
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { STORAGE_ROOT, ensureDir } from './storage-paths.js';

const peersFile = () => join(STORAGE_ROOT, 'peers.json');

export interface CacoPeer {
  /** Legacy field kept for the /api/sessions fan-out and old portals; equals `origin` for new entries. */
  url: string;
  /** Legacy display name; mirrors `name`. */
  hostname: string;
  /** The peer's instance id, learned on the first successful overview fetch. */
  id?: string;
  name?: string;
  /** Normalized `scheme://host:port`; absent when `url` is not a valid origin. */
  origin?: string;
  addedBy?: 'portal' | 'config';
  /** Bumped on every change to the entry. */
  rev?: number;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** `scheme://host:port` for an http(s) URL with no credentials, path, query or
 *  fragment (a trailing `/` is allowed), else null. */
export function normalizeOrigin(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  let u: URL;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  if (/[?#]/.test(text)) return null; // an empty `?` or `#` still marks a query or fragment
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `${u.protocol}//${u.hostname.toLowerCase()}:${port}`;
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return LOOPBACK.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch { return false; }
}

/** `CACO_PEERS`: `name=origin,name=origin`. Invalid items are skipped. */
export function parsePeersEnv(value: string | undefined): CacoPeer[] {
  if (!value) return [];
  const out: CacoPeer[] = [];
  for (const item of value.split(',')) {
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    const name = item.slice(0, eq).trim();
    const origin = normalizeOrigin(item.slice(eq + 1));
    if (!name || !origin || out.some(p => p.origin === origin)) continue;
    out.push({ url: origin, hostname: name, name, origin, addedBy: 'config', rev: 0 });
  }
  return out;
}

/** `CACO_PEERS_ALLOW_REMOTE`: explicit comma list of non-loopback origins the
 *  overview fan-out may call server to server. */
export function parseAllowRemote(value: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const item of (value ?? '').split(',')) {
    const o = normalizeOrigin(item);
    if (o) out.add(o);
  }
  return out;
}

function normalizeStored(v: unknown): CacoPeer | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.url !== 'string' || !r.url) return null;
  const name = typeof r.name === 'string' && r.name ? r.name : typeof r.hostname === 'string' ? r.hostname : '';
  const p: CacoPeer = { url: r.url, hostname: name, name, addedBy: 'portal', rev: typeof r.rev === 'number' ? r.rev : 0 };
  const origin = normalizeOrigin(typeof r.origin === 'string' ? r.origin : r.url);
  if (origin) p.origin = origin;
  if (typeof r.id === 'string' && r.id) p.id = r.id;
  return p;
}

function readStored(): CacoPeer[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(peersFile(), 'utf-8')); } catch { return []; }
  return Array.isArray(raw) ? raw.map(normalizeStored).filter((p): p is CacoPeer => !!p) : [];
}

function writeStored(peers: CacoPeer[]): void {
  ensureDir(STORAGE_ROOT);
  const file = peersFile();
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(peers, null, 2), 'utf-8');
  try { renameSync(tmp, file); } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

const sameEntry = (p: CacoPeer, origin: string | null, url: string) =>
  (origin !== null && p.origin === origin) || p.url === url;

/** Stored peers plus `CACO_PEERS` config peers (config wins on the same origin). */
export function getPeers(env: Record<string, string | undefined> = process.env): CacoPeer[] {
  const config = parsePeersEnv(env.CACO_PEERS);
  const configOrigins = new Set(config.map(p => p.origin));
  const stored = readStored();
  // A learned id stored for a config peer carries over.
  for (const c of config) {
    const s = stored.find(p => p.origin === c.origin);
    if (s?.id) c.id = s.id;
  }
  return [...config, ...stored.filter(p => !p.origin || !configOrigins.has(p.origin))];
}

/** @deprecated Whole-list replace. The API uses add/remove/merge. */
export function setPeers(peers: CacoPeer[]): void {
  writeStored(peers.map(normalizeStored).filter((p): p is CacoPeer => !!p));
}

/** Legacy whole-list POST: add new entries and update names, never delete. */
export function mergePeers(incoming: Array<{ url: string; hostname?: string; name?: string }>): { added: number; updated: number } {
  const stored = readStored();
  let added = 0, updated = 0;
  for (const inc of incoming) {
    if (!inc || typeof inc.url !== 'string' || !inc.url) continue;
    const origin = normalizeOrigin(inc.url);
    const name = inc.name || inc.hostname || '';
    const cur = stored.find(p => sameEntry(p, origin, inc.url));
    if (!cur) {
      const p: CacoPeer = { url: inc.url, hostname: name, name, addedBy: 'portal', rev: 1 };
      if (origin) p.origin = origin;
      stored.push(p);
      added++;
    } else if (name && cur.name !== name) {
      cur.name = name; cur.hostname = name; cur.rev = (cur.rev ?? 0) + 1;
      updated++;
    }
  }
  if (added || updated) writeStored(stored);
  return { added, updated };
}

export type AddPeerResult = { ok: true; peer: CacoPeer; added: boolean } | { ok: false; error: string };

/** Add (or rename) one peer by origin. */
export function addPeer(url: string, name?: string): AddPeerResult {
  const origin = normalizeOrigin(url);
  if (!origin) return { ok: false, error: 'url must be an http(s) origin with no credentials, path, query or fragment' };
  const display = (name ?? '').trim() || new URL(origin).hostname;
  const stored = readStored();
  const cur = stored.find(p => sameEntry(p, origin, url));
  if (cur) {
    if (cur.name !== display) {
      cur.name = display; cur.hostname = display; cur.rev = (cur.rev ?? 0) + 1;
      writeStored(stored);
    }
    return { ok: true, peer: cur, added: false };
  }
  const peer: CacoPeer = { url: origin, hostname: display, name: display, origin, addedBy: 'portal', rev: 1 };
  stored.push(peer);
  writeStored(stored);
  return { ok: true, peer, added: true };
}

export type RemovePeerResult = { ok: true } | { ok: false; error: string; status: 403 | 404 };

/** Remove one portal peer. Config peers (`CACO_PEERS`) cannot be removed. */
export function removePeer(url: string, env: Record<string, string | undefined> = process.env): RemovePeerResult {
  const origin = normalizeOrigin(url);
  if (origin && parsePeersEnv(env.CACO_PEERS).some(p => p.origin === origin)) {
    return { ok: false, status: 403, error: 'config peer (CACO_PEERS) cannot be removed' };
  }
  const stored = readStored();
  const keep = stored.filter(p => !sameEntry(p, origin, url));
  if (keep.length === stored.length) return { ok: false, status: 404, error: 'peer not found' };
  writeStored(keep);
  return { ok: true };
}

/** Record the instance id a peer reported (first successful fetch, or a change).
 *  The only write the overview fan-out makes, and only to peers.json. */
export function recordPeerIdentity(origin: string, id: string, env: Record<string, string | undefined> = process.env): void {
  const stored = readStored();
  const cur = stored.find(p => p.origin === origin);
  if (cur) {
    if (cur.id === id) return;
    cur.id = id; cur.rev = (cur.rev ?? 0) + 1;
  } else {
    const config = parsePeersEnv(env.CACO_PEERS).find(p => p.origin === origin);
    if (!config) return;
    stored.push({ ...config, addedBy: 'portal', id, rev: 1 });
  }
  writeStored(stored);
}
