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
    CopilotClient: vi.fn(function CopilotClient() {
      return fakeClient;
    }),
    approveAll: vi.fn(),
  };
});

const storage = vi.hoisted(() => {
  const meta = new Map<string, Record<string, unknown>>();
  return {
    meta,
    registerSession: vi.fn(),
    unregisterSession: vi.fn(),
    ensureSessionMeta: vi.fn((sessionId: string) => {
      if (!meta.has(sessionId)) meta.set(sessionId, { name: '' });
    }),
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

vi.mock('@github/copilot-sdk', () => sdk);
vi.mock('../../src/storage.js', () => storage);
vi.mock('../../src/sdk-session-store.js', () => ({
  readSessionWorkspace: vi.fn(() => null),
  readSessionEvents: vi.fn(() => []),
  parseSessionModel: vi.fn(() => null),
  listSessionIds: vi.fn(() => []),
}));
vi.mock('../../src/mcp-config-loader.js', () => ({ loadMcpServers: vi.fn(async () => ({})) }));
vi.mock('../../src/provider-registry.js', () => ({
  hasProviders: vi.fn(() => false),
  listByokModels: vi.fn(() => []),
  resolveModel: vi.fn((model: string) => ({ sdkModel: model, cacoId: model })),
}));
vi.mock('../../src/quota-poller.js', () => ({ pollQuota: vi.fn() }));
vi.mock('../../src/memory-tool.js', () => ({ formatMemoryForPrompt: vi.fn(() => '') }));
vi.mock('../../src/session-throughput.js', () => ({ clearSession: vi.fn() }));

describe('SessionManager large-output config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.meta.clear();
  });

  it('uses the Caco large-output cap', async () => {
    const { SDK_LARGE_OUTPUT_MAX_SIZE_BYTES, sdkLargeOutputConfig } = await import('../../src/session-manager.js');

    expect(SDK_LARGE_OUTPUT_MAX_SIZE_BYTES).toBe(20 * 1024);
    expect(sdkLargeOutputConfig()).toEqual({ enabled: true, maxSizeBytes: 20 * 1024 });
  });

  it('passes largeOutput when creating SDK sessions', async () => {
    const { SessionManager, sdkLargeOutputConfig } = await import('../../src/session-manager.js');
    const manager = new SessionManager();

    await manager.create(process.cwd(), {
      model: 'claude-sonnet-4.6',
      toolFactory: () => [],
    });

    expect(sdk.fakeClient.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ largeOutput: sdkLargeOutputConfig() })
    );
  });

  it('passes largeOutput when resuming SDK sessions', async () => {
    const { SessionManager, sdkLargeOutputConfig } = await import('../../src/session-manager.js');
    const manager = new SessionManager();
    (manager as unknown as { sessionCache: Map<string, { cwd: string; summary: null }> })
      .sessionCache.set('resumed', { cwd: process.cwd(), summary: null });

    await manager.resume('resumed', { toolFactory: () => [] });

    expect(sdk.fakeClient.resumeSession).toHaveBeenCalledWith(
      'resumed',
      expect.objectContaining({ largeOutput: sdkLargeOutputConfig() })
    );
  });
});
