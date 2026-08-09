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
    CopilotClient: vi.fn(function CopilotClient() { return fakeClient; }),
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

type Manager = { create: (cwd: string, opts: { model: string; toolFactory: () => unknown[] }) => Promise<string> };

describe('SessionManager Copilot config-discovery parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.meta.clear();
    sdk.fakeClient.ping.mockResolvedValue({ message: 'ok', timestamp: new Date(0).toISOString() });
  });

  it('creates sessions with enableConfigDiscovery + correct configDirectory option name', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager() as unknown as Manager;
    await manager.create(process.cwd(), { model: 'claude-sonnet-4.6', toolFactory: () => [] });

    expect(sdk.fakeClient.createSession).toHaveBeenCalledTimes(1);
    const cfg = (sdk.fakeClient.createSession.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    // RA: file-based agent/skill/MCP discovery enabled (CLI parity).
    expect(cfg.enableConfigDiscovery).toBe(true);
    // R0: the SDK's public option is configDirectory, NOT configDir (the old key
    // was silently dropped).
    expect(cfg.configDirectory).toMatch(/\.copilot$/);
    expect(cfg.configDir).toBeUndefined();
  });

  it('creates sessions with on-demand instruction discovery enabled', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager() as unknown as Manager;
    await manager.create(process.cwd(), { model: 'claude-sonnet-4.6', toolFactory: () => [] });

    const cfg = (sdk.fakeClient.createSession.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    // The SDK defaults this off; the CLI opts in. Without it a session editing
    // files in a subdirectory never sees the AGENTS.md written for that subtree,
    // because eager loading stops at the cwd.
    expect(cfg.enableOnDemandInstructionDiscovery).toBe(true);
  });

  it('re-supplies both discovery options on resume, which the SDK does not persist', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager();
    // Reach the resume path directly: it needs a cached cwd, no active session,
    // and existing events (an eventless session is recreated instead of resumed).
    (manager as unknown as { sessionCache: Map<string, unknown> })
      .sessionCache.set('sess-1', { cwd: process.cwd(), summary: null });
    const store = await import('../../src/sdk-session-store.js');
    vi.mocked(store.readSessionHeadResult).mockReturnValue(
      { ok: true, value: { start: { type: 'session.start' }, hasMore: true } } as never,
    );

    await (manager as unknown as { resume: (id: string, o: unknown) => Promise<unknown> })
      .resume('sess-1', { toolFactory: () => [] });

    expect(sdk.fakeClient.resumeSession).toHaveBeenCalled();
    const cfg = (sdk.fakeClient.resumeSession.mock.calls[0] as unknown[]).find(
      (a): a is Record<string, unknown> =>
        typeof a === 'object' && a !== null && 'enableConfigDiscovery' in (a as object),
    );
    // A resumed session that quietly loses these would behave differently from a
    // fresh one in the same directory -- the hardest kind of drift to notice.
    expect(cfg, 'resumeSession received no config object').toBeDefined();
    expect(cfg!.enableConfigDiscovery).toBe(true);
    expect(cfg!.enableOnDemandInstructionDiscovery).toBe(true);
  });
});
