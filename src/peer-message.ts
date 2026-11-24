/**
 * Receiving a message from another Caco instance (spec-peer-session-tools).
 *
 * `fromPeer` is an unauthenticated claim used only to label the message. It never
 * authorizes anything: anything that can reach this loopback port can already
 * post messages.
 */

const ID_RE = /^[A-Za-z0-9._-]{1,100}$/;
const NAME_MAX = 40;

export type PeerSender = { ok: true; label: string } | { ok: false; error: string };

/** The display name a receiver shows: safe characters only, at most 40, falling
 *  back to the first 8 characters of the instance id. */
export function sanitizePeerName(name: unknown, instanceId: string): string {
  const clean = typeof name === 'string' ? name.replace(/[^A-Za-z0-9 ._-]/g, '_').trim().slice(0, NAME_MAX).trim() : '';
  return clean || instanceId.slice(0, 8);
}

/** Validate a peer message's sender and hop header; returns the prefix label
 *  `<instanceName>/<session8>`. */
export function parsePeerSender(fromPeer: unknown, hop: string | undefined): PeerSender {
  if (hop !== '1') return { ok: false, error: 'peer messages need X-Caco-Peer-Hop: 1' };
  if (!fromPeer || typeof fromPeer !== 'object') return { ok: false, error: 'fromPeer is required' };
  const f = fromPeer as Record<string, unknown>;
  if (typeof f.instanceId !== 'string' || !ID_RE.test(f.instanceId)) return { ok: false, error: 'fromPeer.instanceId is invalid' };
  if (typeof f.sessionId !== 'string' || !ID_RE.test(f.sessionId)) return { ok: false, error: 'fromPeer.sessionId is invalid' };
  return { ok: true, label: `${sanitizePeerName(f.instanceName, f.instanceId)}/${f.sessionId.slice(0, 8)}` };
}
