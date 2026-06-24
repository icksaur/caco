/**
 * SessionManager.runExclusiveRotation guards — in particular the resume-in-flight
 * guard that closes a data-loss race: a session being rehydrated by the SDK is
 * invisible to activeSessions until AFTER the multi-second read of events.jsonl,
 * but resumeInProgress is set synchronously at resume() entry, so rotation must
 * refuse while it is present.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => {
  const fakeClient = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    forceStop: vi.fn(async () => {}),
    ping: vi.fn(async () => ({ message: 'ok', timestamp: new Date(0).toISOString() })),
    createSession: vi.fn(async () => ({ sessionId: 'created', disconnect: vi.fn(async () => {}) })),
    resumeSession: vi.fn(async () => ({ sessionId: 'resumed', disconnect: vi.fn(async () => {}) })),
    deleteSession: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    rpc: {
      account: { getQuota: vi.fn(async () => ({ quotaSnapshots: {} })) },
      models: { list: vi.fn(async () => ({ models: [] })) },
      tools: { list: vi.fn(async () => ({ tools: [] })) },
      sessions: { fork: vi.fn(async () => ({ sessionId: 'forked' })) },
    },
  };
  return {
    fakeClient,
    CopilotClient: vi.fn(function CopilotClient() { return fakeClient; }),
    approveAll: vi.fn(),
  };
});

const storage = vi.hoisted(() => ({
  meta: new Map<string, Record<string, unknown>>(),
  ensureSessionMeta: vi.fn(),
  getSessionMeta: vi.fn(() => undefined),
  setSessionMeta: vi.fn(),
  updateSessionMeta: vi.fn(() => true),
  getSessionIconPath: vi.fn(() => null),
  setSessionOrder: vi.fn(),
}));

vi.mock('@github/copilot-sdk', () => sdk);
vi.mock('../../src/storage.js', () => storage);
vi.mock('../../src/session-runtime.js', () => ({ disposeSessionRuntime: vi.fn() }));
vi.mock('../../src/event-bus.js', () => ({ broadcastEvent: vi.fn(), broadcastGlobalEvent: vi.fn() }));
vi.mock('../../src/sdk-session-store.js', () => ({
  readSessionWorkspace: vi.fn(() => null),
  readSessionEvents: vi.fn(() => []),
  parseSessionModel: vi.fn(() => null),
  listSessionIds: vi.fn(() => []),
  STATE_DIR: '/tmp/nonexistent-state',
}));
vi.mock('../../src/session-history-rotation.js', () => ({ reconcileRotation: vi.fn(() => 'clean') }));
vi.mock('../../src/mcp-config-loader.js', () => ({ loadMcpServers: vi.fn(async () => ({})) }));
vi.mock('../../src/provider-registry.js', () => ({
  hasProviders: vi.fn(() => false),
  listByokModels: vi.fn(() => []),
  resolveModel: vi.fn((model: string) => ({ sdkModel: model, cacoId: model })),
}));
vi.mock('../../src/quota-poller.js', () => ({ pollQuota: vi.fn() }));
vi.mock('../../src/memory-tool.js', () => ({ formatMemoryForPrompt: vi.fn(() => '') }));

import { sessionManager } from '../../src/session-manager.js';

type Internals = {
  activeSessions: Map<string, unknown>;
  resumeInProgress: Map<string, unknown>;
  rotatingSessions: Map<string, unknown>;
};
const internals = sessionManager as unknown as Internals;

describe('runExclusiveRotation guards', () => {
  const SID = 'sess-rot';

  beforeEach(() => {
    internals.activeSessions.clear();
    internals.resumeInProgress.clear();
    internals.rotatingSessions.clear();
  });

  it('runs the op and clears the lock when the session is idle', async () => {
    const op = vi.fn(async () => 'done');
    await expect(sessionManager.runExclusiveRotation(SID, op)).resolves.toBe('done');
    expect(op).toHaveBeenCalledOnce();
    expect(sessionManager.isRotating(SID)).toBe(false);
  });

  it('refuses an active session', async () => {
    internals.activeSessions.set(SID, {});
    await expect(sessionManager.runExclusiveRotation(SID, vi.fn())).rejects.toThrow(/active/);
  });

  it('refuses a session with a resume in flight', async () => {
    internals.resumeInProgress.set(SID, Promise.resolve());
    const op = vi.fn();
    await expect(sessionManager.runExclusiveRotation(SID, op)).rejects.toThrow(/resume is in flight/);
    expect(op).not.toHaveBeenCalled();
  });

  it('refuses a second concurrent rotation', async () => {
    let release!: () => void;
    const first = sessionManager.runExclusiveRotation(SID, () => new Promise<void>(r => { release = r; }));
    expect(sessionManager.isRotating(SID)).toBe(true);
    await expect(sessionManager.runExclusiveRotation(SID, vi.fn())).rejects.toThrow(/already in progress/);
    release();
    await first;
  });

  it('marks the session rotating while the op runs', async () => {
    let release!: () => void;
    const running = sessionManager.runExclusiveRotation(SID, () => new Promise<void>(r => { release = r; }));
    expect(sessionManager.isRotating(SID)).toBe(true);
    release();
    await running;
    expect(sessionManager.isRotating(SID)).toBe(false);
  });
});
