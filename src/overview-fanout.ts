/**
 * Hub fan-out for `GET /api/overview?scope=all` (spec-session-overview,
 * Cross-machine fetch policy). Asks each registered peer for
 * `/api/overview?scope=local` only (never `/api/sessions`), one hop, with the
 * hop header, and reports a status per instance. A failing, slow, oversized,
 * malformed or impostor peer never fails the call.
 */

import type { CacoPeer } from './peer-store.js';
import { normalizeOrigin, isLoopbackOrigin } from './peer-store.js';
import { OVERVIEW_SCHEMA_VERSION, type SessionOverview } from './session-overview.js';

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
const isStr = (v: unknown, max = 10_000): v is string => typeof v === 'string' && v.length <= max;
const CONFIDENCE = new Set(['high', 'low', 'info']);

/** Shape check of a peer's overview. Every entry must belong to the reporting
 *  instance (`key` and `instance.id`), so a peer cannot speak for another. */
export function validateOverviewPayload(v: unknown): { ok: true; value: SessionOverview } | { ok: false; reason: string } {
  if (!isObj(v)) return { ok: false, reason: 'not an object' };
  if (v.schemaVersion !== OVERVIEW_SCHEMA_VERSION) return { ok: false, reason: 'schemaVersion mismatch' };
  const inst = v.instance;
  if (!isObj(inst) || !isStr(inst.id, 100) || !inst.id || !isStr(inst.name, 200)) return { ok: false, reason: 'bad instance' };
  if (!isStr(v.generatedAt, 40) || !isObj(v.counts) || !Array.isArray(v.entries)) return { ok: false, reason: 'bad envelope' };
  for (const k of ['total', 'shown', 'omitted', 'omittedFlagged', 'full', 'compact', 'archivedExcluded']) {
    if (typeof v.counts[k] !== 'number') return { ok: false, reason: 'bad counts' };
  }
  for (const e of v.entries as unknown[]) {
    if (!isObj(e) || !isStr(e.sessionId, 200) || !isStr(e.title) || !isObj(e.instance) || !isObj(e.context)) return { ok: false, reason: 'bad entry' };
    if (e.instance.id !== inst.id || e.key !== `${inst.id}:${e.sessionId}`) return { ok: false, reason: 'entry from another instance' };
    if (e.tier !== 'full' && e.tier !== 'compact') return { ok: false, reason: 'bad entry' };
    if (e.activity !== 'busy' && e.activity !== 'idle') return { ok: false, reason: 'bad entry' };
    if (!Array.isArray(e.waits) || !Array.isArray(e.flags)) return { ok: false, reason: 'bad entry' };
    for (const f of e.flags as unknown[]) {
      if (!isObj(f) || !isStr(f.code, 100) || !isStr(f.detail, 2000) || !CONFIDENCE.has(f.confidence as string)) return { ok: false, reason: 'bad flag' };
    }
    if (!isStr(e.context.status, 40)) return { ok: false, reason: 'bad entry' };
  }
  return { ok: true, value: v as unknown as SessionOverview };
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
