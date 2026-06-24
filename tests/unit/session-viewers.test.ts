/**
 * session-viewers: which live clients have a session on-screen. Liveness-aware —
 * a non-OPEN socket must never pin a session as "viewed".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { addViewer, removeViewer, getViewers, isSessionViewed } from '../../src/session-viewers.js';

// Minimal stand-in for a ws WebSocket: only readyState is read by the module.
function fakeWs(readyState: number = WebSocket.OPEN): WebSocket {
  return { readyState } as unknown as WebSocket;
}

const SID = 'sess-view';

beforeEach(() => {
  // Drain any viewers left by a prior test (module singleton).
  for (const id of [SID, 'a', 'b']) {
    const set = getViewers(id);
    if (set) for (const ws of [...set]) removeViewer(id, ws);
  }
});

describe('session-viewers', () => {
  it('reports not-viewed when nobody is subscribed', () => {
    expect(isSessionViewed(SID)).toBe(false);
    expect(getViewers(SID)).toBeUndefined();
  });

  it('reports viewed once a live client subscribes', () => {
    const ws = fakeWs();
    addViewer(SID, ws);
    expect(isSessionViewed(SID)).toBe(true);
    expect(getViewers(SID)?.size).toBe(1);
  });

  it('preserves other viewers when one is removed', () => {
    const a = fakeWs();
    const b = fakeWs();
    addViewer(SID, a);
    addViewer(SID, b);
    removeViewer(SID, a);
    expect(isSessionViewed(SID)).toBe(true);
    expect(getViewers(SID)?.size).toBe(1);
  });

  it('drops the session entry when the last viewer leaves', () => {
    const ws = fakeWs();
    addViewer(SID, ws);
    removeViewer(SID, ws);
    expect(isSessionViewed(SID)).toBe(false);
    expect(getViewers(SID)).toBeUndefined();
  });

  it('purges a non-OPEN (stale) socket so it cannot pin a session forever', () => {
    const dead = fakeWs(WebSocket.CLOSED);
    addViewer(SID, dead);
    // A leaked socket must not keep the session "viewed".
    expect(isSessionViewed(SID)).toBe(false);
    expect(getViewers(SID)).toBeUndefined();
  });

  it('keeps live viewers while purging only the dead ones', () => {
    const live = fakeWs(WebSocket.OPEN);
    const dead = fakeWs(WebSocket.CLOSING);
    addViewer(SID, live);
    addViewer(SID, dead);
    const set = getViewers(SID);
    expect(set?.size).toBe(1);
    expect(set?.has(live)).toBe(true);
  });
});
