/**
 * /api/wakes route (spec-session-wake, A16): lists wakes with the session's
 * display name, soonest first, and DELETE clears one or 404s.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { WakeState } from '../../src/session-meta-store.js';

const state = vi.hoisted(() => ({
  wakes: new Map<string, unknown>(),
  sessions: [] as Array<{ sessionId: string; name: string; summary: string | null; autoName: string | null }>,
}));

vi.mock('../../src/wake-runtime.js', () => ({
  wakeManager: {
    list: () => [...state.wakes].map(([sessionId, wake]) => ({ sessionId, wake })),
    clear: (id: string) => state.wakes.delete(id),
  },
}));
vi.mock('../../src/session-manager.js', () => ({ sessionManager: { list: () => state.sessions } }));

let server: Server;
let base: string;

beforeAll(async () => {
  const { router } = await import('../../src/routes/wakes.js');
  const app = express();
  app.use('/api', router);
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => { server?.close(); });

const wake = (over: Partial<WakeState>): WakeState => ({
  everyMinutes: 240, registeredAt: '2026-11-09T08:00:00.000Z', nextWakeAt: '2026-11-09T12:00:00.000Z', consecutiveFailures: 0, ...over,
});

beforeEach(() => {
  state.wakes.clear();
  state.sessions = [
    { sessionId: 'a', name: 'PR track', summary: null, autoName: null },
    { sessionId: 'b', name: '', summary: 'Deploy watch', autoName: null },
  ];
});

describe('/api/wakes', () => {
  it('lists wakes soonest first with name, cadence, result, and paused reason', async () => {
    state.wakes.set('a', wake({ note: 'waiting on PR 1', nextWakeAt: '2026-11-09T14:00:00.000Z', lastResult: 'error', lastError: 'session.error' }));
    state.wakes.set('b', wake({ everyMinutes: 60, pausedReason: 'expired' }));
    state.wakes.set('c', wake({ nextWakeAt: '2026-11-09T20:00:00.000Z' }));
    const body = await (await fetch(`${base}/wakes`)).json();
    expect(body.wakes.map((w: { sessionId: string }) => w.sessionId)).toEqual(['b', 'a', 'c']);
    expect(body.wakes[0]).toEqual({ sessionId: 'b', sessionName: 'Deploy watch', everyHours: 1, nextWakeAt: '2026-11-09T12:00:00.000Z', pausedReason: 'expired' });
    expect(body.wakes[1]).toMatchObject({ sessionName: 'PR track', everyHours: 4, note: 'waiting on PR 1', lastResult: 'error', lastError: 'session.error' });
    expect(body.wakes[2].sessionName).toBeNull();
  });

  it('DELETE clears a wake and 404s when there is none', async () => {
    state.wakes.set('a', wake({}));
    const res = await fetch(`${base}/wakes/a`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(state.wakes.has('a')).toBe(false);
    expect((await fetch(`${base}/wakes/a`, { method: 'DELETE' })).status).toBe(404);
  });
});
