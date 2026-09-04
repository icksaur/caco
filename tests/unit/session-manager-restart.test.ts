import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => {
  const fakeClient = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    forceStop: vi.fn(async () => {}),
    ping: vi.fn(async () => ({ message: 'ok', timestamp: new Date(0).toISOString() })),
    getState: vi.fn(() => 'connected'),
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
    // Each start yields a DISTINCT instance that shares fakeClient's spies via the
    // prototype. Session-manager guards remediation on client identity, so a
    // singleton fake would make that guard untestable (every client would compare
    // equal) while still letting the assertions read from one set of spies.
    CopilotClient: vi.fn(function CopilotClient() { return Object.create(fakeClient); }),
    approveAll: vi.fn(),
  };
});

const storage = vi.hoisted(() => {
  const meta = new Map<string, Record<string, unknown>>();
  return {
    meta,
    ensureSessionMeta: vi.fn((sessionId: string) => { if (!meta.has(sessionId)) meta.set(sessionId, { name: '' }); }),
    getSessionMeta: vi.fn((sessionId: string) => meta.get(sessionId)),
    setSessionMeta: vi.fn((sessionId: string, value: Record<string, unknown>) => meta.set(sessionId, value)),
    updateSessionMeta: vi.fn((sessionId: string, mutate: (m: Record<string, unknown>) => void, opts?: { createIfMissing?: boolean }) => {
      const existing = meta.get(sessionId);
      if (!existing && opts?.createIfMissing === false) return false;
      const value = existing ?? { name: '' };
      mutate(value);
      meta.set(sessionId, value);
      return true;
    }),
    getSessionIconPath: vi.fn(() => null),
    setSessionOrder: vi.fn(),
  };
});

const runtime = vi.hoisted(() => ({ disposeSessionRuntime: vi.fn() }));
const eventBus = vi.hoisted(() => ({ broadcastEvent: vi.fn(), broadcastGlobalEvent: vi.fn() }));

vi.mock('@github/copilot-sdk', () => sdk);
vi.mock('../../src/storage.js', () => storage);
vi.mock('../../src/session-runtime.js', () => runtime);
vi.mock('../../src/event-bus.js', () => eventBus);
vi.mock('../../src/sdk-session-store.js', () => ({
  readSessionWorkspace: vi.fn(() => null),
  readSessionEvents: vi.fn(() => []),
  readSessionHeadResult: vi.fn(() => ({ ok: true, value: { start: null, hasMore: false } })),
  parseSessionModel: vi.fn(() => null),
  listSessionIds: vi.fn(() => []),
  STATE_DIR: '/tmp/nonexistent-state',
}));
vi.mock('../../src/mcp-config-loader.js', () => ({ loadMcpServers: vi.fn(async () => ({})) }));
vi.mock('../../src/provider-registry.js', () => ({
  hasProviders: vi.fn(() => false),
  listByokModels: vi.fn(() => []),
  resolveModel: vi.fn((model: string) => ({ sdkModel: model, cacoId: model })),
}));
vi.mock('../../src/quota-poller.js', () => ({ pollQuota: vi.fn() }));
vi.mock('../../src/memory-tool.js', () => ({ formatMemoryForPrompt: vi.fn(() => '') }));

type Manager = { create: (cwd: string, opts: { model: string; toolFactory: () => unknown[] }) => Promise<string>; ensureClientHealthy: () => Promise<void> };

/** Ids the boundary `session.error` was broadcast to, in call order. */
function notifiedIds(): string[] {
  return eventBus.broadcastEvent.mock.calls
    .filter(c => (c[1] as { type?: string })?.type === 'session.error')
    .map(c => c[0] as string);
}

describe('SessionManager shared-client restart transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.meta.clear();
    sdk.fakeClient.ping.mockResolvedValue({ message: 'ok', timestamp: new Date(0).toISOString() });
    sdk.fakeClient.getState.mockReturnValue('connected');
  });

  it('drops active sessions, disposes runtimes, and emits one boundary event per session when the probe fails outright', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager() as unknown as Manager;
    const created = await manager.create(process.cwd(), { model: 'claude-sonnet-4.6', toolFactory: () => [] });
    const active = (manager as unknown as { activeSessions: Map<string, unknown> }).activeSessions;
    expect(active.size).toBe(1);

    // Sustained: the probe retries, so death means every attempt fails.
    sdk.fakeClient.ping.mockRejectedValue(new Error('ping timeout'));
    await manager.ensureClientHealthy();

    expect(active.size).toBe(0);
    expect(runtime.disposeSessionRuntime).toHaveBeenCalledWith(created);
    expect(eventBus.broadcastEvent).toHaveBeenCalledWith(
      created,
      expect.objectContaining({ type: 'session.error', data: expect.objectContaining({ restorePrompt: true }) })
    );
    expect(eventBus.broadcastEvent).toHaveBeenCalledTimes(1);
    expect(sdk.fakeClient.forceStop).toHaveBeenCalled();
  });

  // I1: a health verdict may end a busy session's turn, but never by clearing its
  // runtime out from under it. Disposing the runtime of a session whose dispatch
  // is still live is the silent-truncation failure this spec exists to remove.
  it('does not dispose the runtime of a session holding an in-flight dispatch', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const { dispatchState } = await import('../../src/dispatch-state.js');
    const manager = new SessionManager() as unknown as Manager;

    const idle = await manager.create(process.cwd(), { model: 'claude-sonnet-4.6', toolFactory: () => [] });
    const active = (manager as unknown as { activeSessions: Map<string, unknown> }).activeSessions;
    // Second entry stands in for a session mid-turn; create() returns one id per
    // call from the fake SDK, so the busy entry is installed directly.
    const busy = 'busy-session';
    active.set(busy, { cwd: '/x', session: { disconnect: vi.fn(async () => {}) }, toolFactory: () => [], lastUsedAt: Date.now() });
    dispatchState.start(busy, 'corr-busy');

    try {
      sdk.fakeClient.ping.mockRejectedValue(new Error('ping timeout'));
      await manager.ensureClientHealthy();

      expect(runtime.disposeSessionRuntime).toHaveBeenCalledWith(idle);
      expect(runtime.disposeSessionRuntime).not.toHaveBeenCalledWith(busy);
      // The turn is still ended and reported — sparing is about *how*, not whether.
      expect(notifiedIds()).toContain(busy);
      expect(notifiedIds()).toContain(idle);
    } finally {
      if (dispatchState.isBusy(busy)) dispatchState.end(busy);
    }
  });

  // I2: a single slow ping is not proof of death. The runtime legitimately
  // stalls for seconds under load, so one timeout must not restart the client.
  it('tolerates a transient probe failure and tears nothing down when a later attempt succeeds', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager() as unknown as Manager;
    const created = await manager.create(process.cwd(), { model: 'claude-sonnet-4.6', toolFactory: () => [] });
    const active = (manager as unknown as { activeSessions: Map<string, unknown> }).activeSessions;

    sdk.fakeClient.forceStop.mockClear();
    sdk.fakeClient.ping
      .mockRejectedValueOnce(new Error('ping timeout'))
      .mockResolvedValue({ message: 'ok', timestamp: new Date(0).toISOString() });

    await manager.ensureClientHealthy();

    expect(active.has(created)).toBe(true);
    expect(sdk.fakeClient.forceStop).not.toHaveBeenCalled();
    expect(notifiedIds()).toEqual([]);
    expect(runtime.disposeSessionRuntime).not.toHaveBeenCalledWith(created);
  });

  // I3/I4: ensureClientHealthy is on the dispatch path, so simultaneous sends
  // probe concurrently. Single-flight keeps that from becoming N ping storms;
  // the identity guard keeps the second caller from force-stopping the fresh
  // client the first caller just established.
  it('collapses concurrent probes into one restart and one boundary event per session', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');

    // Reference cost: what ONE failing probe spends in pings. Derived rather than
    // hard-coded so the attempt count stays a code constant.
    const solo = new SessionManager() as unknown as Manager;
    await solo.create(process.cwd(), { model: 'claude-sonnet-4.6', toolFactory: () => [] });
    sdk.fakeClient.ping.mockRejectedValue(new Error('ping timeout'));
    sdk.fakeClient.ping.mockClear();
    await solo.ensureClientHealthy();
    const pingsForOneProbe = sdk.fakeClient.ping.mock.calls.length;
    expect(pingsForOneProbe).toBeGreaterThan(1);

    const manager = new SessionManager() as unknown as Manager;
    const created = await manager.create(process.cwd(), { model: 'claude-sonnet-4.6', toolFactory: () => [] });
    sdk.fakeClient.forceStop.mockClear();
    sdk.fakeClient.ping.mockClear();
    eventBus.broadcastEvent.mockClear();

    await Promise.all([manager.ensureClientHealthy(), manager.ensureClientHealthy()]);

    expect(sdk.fakeClient.ping.mock.calls.length).toBe(pingsForOneProbe);
    expect(sdk.fakeClient.forceStop).toHaveBeenCalledTimes(1);
    expect(notifiedIds()).toEqual([created]);
  });

  // I3: a probe's verdict is about the instance it examined. If the client is
  // replaced while the probe is still retrying, acting on that stale verdict
  // force-stops a healthy client someone else just established.
  it('does not remediate a client that was replaced while the probe was running', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager() as unknown as Manager;
    await manager.create(process.cwd(), { model: 'claude-sonnet-4.6', toolFactory: () => [] });
    const internals = manager as unknown as { sharedClient: unknown };

    sdk.fakeClient.forceStop.mockClear();
    let attempts = 0;
    sdk.fakeClient.ping.mockImplementation(async () => {
      attempts++;
      // Mid-probe, a peer restarts the client: the instance under examination is
      // no longer the live one by the time this probe returns its verdict.
      if (attempts === 2) internals.sharedClient = Object.create(sdk.fakeClient);
      throw new Error('ping timeout');
    });

    await manager.ensureClientHealthy();

    expect(sdk.fakeClient.forceStop).not.toHaveBeenCalled();
    expect(notifiedIds()).toEqual([]);
  });
});
