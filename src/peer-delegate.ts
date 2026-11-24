/**
 * `caco_session_delegate` to a session on another Caco instance
 * (spec-peer-session-tools): preflight, send, and wait for the reply of the turn
 * the send started (its token), polling the peer's /state.
 */

import { getInstanceIdentity } from './instance-identity.js';
import { peerFetch, type PeerRef } from './peer-target.js';

export const PEER_POLL_MS = 5000;
export const PEER_MAX_FAILED_POLLS = 3;
/** Polls in a row on which the token is neither running nor the last finished turn. */
export const PEER_LOST_TURN_POLLS = 2;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const statePath = (sessionId: string, reply = false) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/state${reply ? '?reply=1' : ''}`;

/** Why a peer target cannot take a delegate right now, or null when it can. Sends nothing. */
export async function peerPreflight(peer: PeerRef, sessionId: string): Promise<string | null> {
  const id8 = sessionId.slice(0, 8);
  let r: { status: number; json: unknown };
  try { r = await peerFetch(peer.origin, statePath(sessionId)); } catch { return `Could not reach ${peer.name}.`; }
  if (r.status === 404) return `Session ${id8} not found on ${peer.name}.`;
  if (r.status !== 200 || !isObj(r.json)) return `Failed to get session state from ${peer.name}: HTTP ${r.status}`;
  if (!isObj(r.json.turn)) return `${peer.name} runs an older Caco; update it first.`;
  if (r.json.status === 'busy') return `Session ${id8} is busy processing another message on ${peer.name}. Wait and retry, or choose another session.`;
  return null;
}

/** Send the message as a peer message; returns the peer's turn id (the token). */
export async function peerSend(peer: PeerRef, sessionId: string, message: string, callerSessionId: string): Promise<{ token: string } | { error: string }> {
  const self = getInstanceIdentity();
  let r: { status: number; json: unknown };
  try {
    r = await peerFetch(peer.origin, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: { prompt: message, source: 'peer', fromPeer: { instanceId: self.id, instanceName: self.name, sessionId: callerSessionId } },
    });
  } catch {
    return { error: `(send failed: could not reach ${peer.name})` };
  }
  if (r.status !== 200) {
    const detail = isObj(r.json) && typeof r.json.error === 'string' ? ` - ${r.json.error}` : '';
    return { error: `(send failed: HTTP ${r.status}${detail})` };
  }
  const token = isObj(r.json) ? r.json.correlationId : undefined;
  return typeof token === 'string' && token ? { token } : { error: `(send failed: ${peer.name} returned no turn id)` };
}

export interface PeerWaitOptions {
  pollMs?: number;
  maxTotalMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Wait for the turn `token` to finish on the peer and return its reply, or a
 *  fixed text saying why there is none. Never returns another turn's reply. */
export async function peerWaitReply(peer: PeerRef, sessionId: string, token: string, o: PeerWaitOptions): Promise<string> {
  const pollMs = o.pollMs ?? PEER_POLL_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const start = now();
  let failed = 0;
  let lost = 0;
  for (;;) {
    if (now() - start >= o.maxTotalMs) {
      return `(still running on ${peer.name} after ${Math.round(o.maxTotalMs / 60_000)}m; check later with get_session_state)`;
    }
    await sleep(pollMs);
    let r: { status: number; json: unknown } | null;
    try { r = await peerFetch(peer.origin, statePath(sessionId, true)); } catch { r = null; }
    if (r?.status === 404) return '(session disappeared during processing)';
    const state = r && r.status === 200 && isObj(r.json) ? r.json : null;
    const turn = state && isObj(state.turn) ? state.turn : null;
    if (!state || !turn) {
      if (++failed >= PEER_MAX_FAILED_POLLS) return `(lost contact with ${peer.name}; check later with get_session_state)`;
      continue;
    }
    failed = 0;
    if (turn.active === token) { lost = 0; continue; }
    if (turn.lastCompleted === token) {
      // Another turn already started: the last reply is no longer ours.
      if (turn.active !== null) return '(reply not available; read it with get_session_state)';
      // No reply in this snapshot means a turn moved while it was read; poll again.
      if (typeof state.lastResponse !== 'string') continue;
      return state.lastResponse || '(no response)';
    }
    if (++lost >= PEER_LOST_TURN_POLLS) return '(reply not available; read it with get_session_state)';
  }
}
