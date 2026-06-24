/**
 * Session viewers: which connected WebSocket clients currently have a session
 * subscribed (on-screen). Extracted from the WS route into a leaf module so
 * non-route code (history rotation) can read "is this session being viewed?"
 * without importing the route layer (which would form an import cycle).
 *
 * Liveness-aware: a half-open/closed socket must never pin a session as viewed
 * forever (which would permanently block rotation), so reads purge non-OPEN
 * sockets and drop sets once empty.
 */

import { WebSocket } from 'ws';

const sessionViewers = new Map<string, Set<WebSocket>>();

export function addViewer(sessionId: string, ws: WebSocket): void {
  let set = sessionViewers.get(sessionId);
  if (!set) {
    set = new Set();
    sessionViewers.set(sessionId, set);
  }
  set.add(ws);
}

export function removeViewer(sessionId: string, ws: WebSocket): void {
  const set = sessionViewers.get(sessionId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) sessionViewers.delete(sessionId);
}

/** Live viewers of a session: drops any socket that is no longer OPEN and
 *  removes the set when it empties. Returns undefined when nobody is viewing. */
export function getViewers(sessionId: string): Set<WebSocket> | undefined {
  const set = sessionViewers.get(sessionId);
  if (!set) return undefined;
  for (const ws of set) {
    if (ws.readyState !== WebSocket.OPEN) set.delete(ws);
  }
  if (set.size === 0) {
    sessionViewers.delete(sessionId);
    return undefined;
  }
  return set;
}

/** True iff at least one live (OPEN) client currently has this session subscribed. */
export function isSessionViewed(sessionId: string): boolean {
  return getViewers(sessionId) !== undefined;
}
