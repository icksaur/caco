/**
 * Tests for per-client session-transition serialization in src/session-state.ts.
 *
 * Verifies that concurrent ensure/switch transitions for one client are
 * serialized (no interleaving), so the latest action wins and there is no
 * double-create. sessionManager/preferences/prompts are module-mocked with
 * controllable deferred resume/create so overlap is observable.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionStateConfig } from '../../src/types.js';

const h = vi.hoisted(() => {
  const liveSessions = new Set<string>();
  return {
    liveSessions,
    createMock: vi.fn(),
    resumeMock: vi.fn(),
    savePreferencesMock: vi.fn(async () => {}),
  };
});

vi.mock('../../src/session-manager.js', () => ({
  sessionManager: {
    init: vi.fn(async () => {}),
    create: (...args: unknown[]) => h.createMock(...args),
    resume: (...args: unknown[]) => h.resumeMock(...args),
    isActive: (id: string) => h.liveSessions.has(id),
    getSessionCwd: () => '/cwd',
    getMostRecentForCwd: () => null,
    hasMessages: () => false,
    delete: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/preferences.js', () => ({
  loadPreferences: vi.fn(async () => ({ lastCwd: '/cwd', lastModel: 'm', lastSessionId: null })),
  savePreferences: (...args: unknown[]) => h.savePreferencesMock(...(args as [])),
  DEFAULT_MODEL: 'default-model',
  resolveModelAlias: (m: string) => m,
}));

vi.mock('../../src/prompts.js', () => ({
  resolveSystemMessage: () => ({ mode: 'append', content: '' }),
}));

import { SessionState } from '../../src/session-state.js';

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void; }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const config: SessionStateConfig = {
  systemMessage: { mode: 'append', content: '' },
  toolFactory: () => [],
  excludedTools: [],
};

function newState(): SessionState {
  return new SessionState(config, { lastCwd: '/cwd', lastModel: 'm', lastSessionId: null }, null);
}

beforeEach(() => {
  h.liveSessions.clear();
  h.createMock.mockReset();
  h.resumeMock.mockReset();
  h.savePreferencesMock.mockClear();
});

describe('SessionState transition serialization', () => {
  it('serializes concurrent ensureSession so create runs once and both reuse it', async () => {
    const created = deferred<string>();
    h.createMock.mockReturnValue(created.promise);

    const state = newState();
    const p1 = state.ensureSession(undefined, false, '/cwd', 'c1');
    const p2 = state.ensureSession(undefined, false, '/cwd', 'c1');

    await Promise.resolve();
    created.resolve('S1');
    h.liveSessions.add('S1');

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe('S1');
    expect(r2).toBe('S1');
    expect(h.createMock).toHaveBeenCalledTimes(1);
    expect(state.getActiveSessionId('c1')).toBe('S1');
    expect(state.preferences.lastSessionId).toBe('S1');
  });

  it('lets the latest switch win and never overlaps resumes', async () => {
    const resumeA = deferred<{ sessionId: string }>();
    const events: string[] = [];
    h.resumeMock.mockImplementation((id: string) => {
      events.push(`start:${id}`);
      if (id === 'A') return resumeA.promise.then((r) => { events.push('settle:A'); return r; });
      events.push('settle:B');
      return Promise.resolve({ sessionId: 'B' });
    });
    h.liveSessions.add('A');
    h.liveSessions.add('B');

    const state = newState();
    const pA = state.switchSession('A', 'c1');
    const pB = state.switchSession('B', 'c1');

    await Promise.resolve();
    expect(events).toEqual(['start:A']);

    resumeA.resolve({ sessionId: 'A' });
    await Promise.all([pA, pB]);

    expect(state.getActiveSessionId('c1')).toBe('B');
    expect(state.preferences.lastSessionId).toBe('B');
    expect(events.indexOf('start:B')).toBeGreaterThan(events.indexOf('settle:A'));
  });

  it('does not wedge the chain when a transition rejects', async () => {
    h.resumeMock.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const state = newState();

    await expect(state.switchSession('X', 'c1')).rejects.toThrow('boom');

    h.resumeMock.mockImplementationOnce(() => Promise.resolve({ sessionId: 'Y' }));
    h.liveSessions.add('Y');
    await state.switchSession('Y', 'c1');

    expect(state.getActiveSessionId('c1')).toBe('Y');
    expect(state.preferences.lastSessionId).toBe('Y');
  });

  it('does not serialize across different clients', async () => {
    const resumeA = deferred<{ sessionId: string }>();
    const started: string[] = [];
    h.resumeMock.mockImplementation((id: string) => {
      started.push(id);
      if (id === 'A') return resumeA.promise;
      return Promise.resolve({ sessionId: id });
    });
    h.liveSessions.add('A');
    h.liveSessions.add('B');

    const state = newState();
    const pA = state.switchSession('A', 'clientA');
    const pB = state.switchSession('B', 'clientB');

    await Promise.resolve();
    expect(started).toEqual(['A', 'B']);

    resumeA.resolve({ sessionId: 'A' });
    await Promise.all([pA, pB]);

    expect(state.getActiveSessionId('clientA')).toBe('A');
    expect(state.getActiveSessionId('clientB')).toBe('B');
  });
});
