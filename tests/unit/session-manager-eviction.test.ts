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

const storage = vi.hoisted(() => {
  const meta = new Map<string, Record<string, unknown>>();
  return {
    meta,
    ensureSessionMeta: vi.fn((sessionId: string) => { if (!meta.has(sessionId)) meta.set(sessionId, { name: '' }); }),
    getSessionMeta: vi.fn((sessionId: string) => meta.get(sessionId)),
    setSessionMeta: vi.fn((sessionId: string, value: Record<string, unknown>) => meta.set(sessionId, value)),
    updateSessionMeta: vi.fn(() => true),
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

interface FakeActive {
  cwd: string;
  session: { disconnect: ReturnType<typeof vi.fn> };
  toolFactory: () => unknown[];
  lastUsedAt: number;
}

describe('SessionManager LRU eviction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.meta.clear();
  });

  it('evicts least-recently-used inactive sessions, sparing recently-touched older ones', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager();
    const active = (manager as unknown as { activeSessions: Map<string, FakeActive> }).activeSessions;

    // Insert 7 sessions. Insertion order is oldest-first, but lastUsedAt is what
    // must drive eviction: s0 is the oldest-created yet most-recently-used.
    const ids = ['s0', 's1', 's2', 's3', 's4', 's5', 's6'];
    const usedAt: Record<string, number> = {
      s0: 1000, // oldest created, but touched most recently
      s1: 100,
      s2: 200,
      s3: 300,
      s4: 400,
      s5: 500,
      s6: 600,
    };
    for (const id of ids) {
      active.set(id, { cwd: '/x', session: { disconnect: vi.fn(async () => {}) }, toolFactory: () => [], lastUsedAt: usedAt[id] });
    }

    await (manager as unknown as { evictInactiveSessions: () => Promise<void> }).evictInactiveSessions();

    // MAX is 5, so 2 least-recently-used (s1=100, s2=200) must be evicted.
    expect(active.size).toBe(5);
    expect(active.has('s1')).toBe(false);
    expect(active.has('s2')).toBe(false);
    // s0 is the oldest by insertion but most-recently-used → survives.
    expect(active.has('s0')).toBe(true);
    expect(runtime.disposeSessionRuntime).toHaveBeenCalledWith('s1');
    expect(runtime.disposeSessionRuntime).toHaveBeenCalledWith('s2');
  });
});
