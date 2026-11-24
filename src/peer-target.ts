/**
 * Peer session targets (spec-peer-session-tools).
 *
 * `get_session_state` and `caco_session_delegate` accept the overview's
 * `<instanceId>:<sessionId>` keys (or `<instanceName>:<sessionId>`). This module
 * resolves such a key to a peer origin under the overview fan-out's origin rule
 * (loopback, or CACO_PEERS_ALLOW_REMOTE) and makes the bounded HTTP calls to it.
 */

import { getPeers, normalizeOrigin, isLoopbackOrigin, parseAllowRemote, rememberPeerId, type CacoPeer } from './peer-store.js';
import { getInstanceIdentity } from './instance-identity.js';
import { readCapped, fetchPeerOverviews } from './overview-fanout.js';

export const PEER_HOP_HEADER = 'X-Caco-Peer-Hop';
export const PEER_FETCH_TIMEOUT_MS = 10_000;
export const PEER_FETCH_MAX_BYTES = 1024 * 1024;
/** Loop guard (spec-peer-session-tools): a turn rooted on another machine. */
export const PEER_LOOP_ERROR = 'This turn started from another machine, so it cannot reach other machines.';

export interface PeerRef { origin: string; name: string; id?: string }

export type PeerTarget =
  | { kind: 'local'; sessionId: string }
  | { kind: 'peer'; peer: PeerRef; sessionId: string }
  | { kind: 'error'; error: string };

export interface ResolveDeps {
  peers?: CacoPeer[];
  self?: { id: string; name: string };
  allowRemote?: Set<string>;
}

const peerName = (p: CacoPeer): string => p.name || p.hostname || '';

/** Resolve a session reference: a bare id (with or without `caco-session:`) is
 *  local; `<instance>:<sessionId>` names a peer by id, then by name. The key is
 *  split at the last colon, since session ids never contain one. */
export function resolvePeerTarget(raw: string | undefined, deps: ResolveDeps = {}): PeerTarget {
  const ref = (raw ?? '').trim().replace(/^caco-session:/, '').trim();
  const cut = ref.lastIndexOf(':');
  if (cut < 0) return { kind: 'local', sessionId: ref };
  const instance = ref.slice(0, cut).trim();
  const sessionId = ref.slice(cut + 1).trim();
  if (!instance) return { kind: 'local', sessionId };

  const self = deps.self ?? getInstanceIdentity();
  const lower = instance.toLowerCase();
  if (instance === self.id || lower === self.name.toLowerCase()) return { kind: 'local', sessionId };

  const peers = deps.peers ?? getPeers();
  let matches = peers.filter(p => p.id === instance);
  if (matches.length === 0) matches = peers.filter(p => peerName(p).toLowerCase() === lower);
  if (matches.length === 0) return { kind: 'error', error: `Unknown instance "${instance}". Run caco_sessions_overview to list instances.` };
  if (matches.length > 1) return { kind: 'error', error: `Instance name "${instance}" matches more than one peer; use the instance id.` };

  const p = matches[0];
  const origin = normalizeOrigin(p.origin ?? p.url);
  const allowRemote = deps.allowRemote ?? parseAllowRemote(process.env.CACO_PEERS_ALLOW_REMOTE);
  if (!origin || (!isLoopbackOrigin(origin) && !allowRemote.has(origin))) {
    return { kind: 'error', error: `Instance "${instance}" is not reachable from this server (not loopback and not in CACO_PEERS_ALLOW_REMOTE).` };
  }
  return { kind: 'peer', peer: { origin, name: peerName(p) || origin, ...(p.id && { id: p.id }) }, sessionId };
}

/**
 * Resolve as above; when an instance id is unknown, learn the ids of reachable
 * peers that have none yet (one cheap overview fetch each, `context=none`) and
 * try once more. Ids are only remembered in memory.
 */
export async function resolvePeerTargetFresh(raw: string | undefined): Promise<PeerTarget> {
  const first = resolvePeerTarget(raw);
  if (first.kind !== 'error' || !first.error.startsWith('Unknown instance')) return first;
  const allowRemote = parseAllowRemote(process.env.CACO_PEERS_ALLOW_REMOTE);
  const unknown = getPeers().filter(p => !p.id);
  if (unknown.length === 0) return first;
  await fetchPeerOverviews({
    peers: unknown, selfId: getInstanceIdentity().id, allowRemote, context: 'none', onIdentity: rememberPeerId,
  }).catch(() => []);
  return resolvePeerTarget(raw);
}

/** The display key for a peer session, as the overview prints it. */
export function peerKey(peer: PeerRef, sessionId: string): string {
  return `${peer.id ?? peer.name}:${sessionId}`;
}

/** One bounded JSON call to a peer: no redirects, a timeout, the hop header, and a
 *  capped body. Network and size failures throw; an HTTP error status does not. */
export async function peerFetch(
  origin: string,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
  const hasBody = init.body !== undefined;
  const res = await fetch(`${origin}${path}`, {
    method: init.method ?? 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(PEER_FETCH_TIMEOUT_MS),
    headers: { [PEER_HOP_HEADER]: '1', Accept: 'application/json', ...(hasBody && { 'Content-Type': 'application/json' }) },
    ...(hasBody && { body: JSON.stringify(init.body) }),
  });
  const text = await readCapped(res, PEER_FETCH_MAX_BYTES);
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
}
