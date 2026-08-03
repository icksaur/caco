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

vi.mock('@github/copilot-sdk', () => sdk);
const store = vi.hoisted(() => ({ model: null as string | null }));
vi.mock('../../src/storage.js', () => ({
  ensureSessionMeta: vi.fn(),
  getSessionMeta: vi.fn(() => undefined),
  setSessionMeta: vi.fn(),
  updateSessionMeta: vi.fn(() => true),
  readSessionMeta: vi.fn(() => ({ ok: true, value: { name: '' } })),
  getSessionIconPath: vi.fn(() => null),
  setSessionOrder: vi.fn(),
}));
vi.mock('../../src/session-runtime.js', () => ({ disposeSessionRuntime: vi.fn() }));
vi.mock('../../src/event-bus.js', () => ({ broadcastEvent: vi.fn(), broadcastGlobalEvent: vi.fn() }));
vi.mock('../../src/sdk-session-store.js', () => ({
  readSessionWorkspace: vi.fn(() => null),
  readSessionEvents: vi.fn(() => []),
  readSessionEventsResult: vi.fn(() => ({ ok: true, value: [] })),
  readSessionHeadResult: vi.fn(() => ({ ok: true, value: { start: null, hasMore: false } })),
  parseSessionModel: vi.fn(() => store.model),
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

function modelWithTiers(id: string, def: { input: number }, lc: { input: number } | null) {
  const tp: Record<string, unknown> = {
    inputPrice: def.input, outputPrice: 10, cachePrice: 1, contextMax: 200_000,
  };
  if (lc) {
    tp.longContext = { inputPrice: lc.input, outputPrice: 10, cachePrice: 1, contextMax: 1_000_000 };
  }
  return {
    id,
    capabilities: { limits: { max_prompt_tokens: 1_000_000, max_context_window_tokens: 1_000_000 } },
    billing: { tokenPrices: tp },
  };
}

describe('SessionManager.contextTierFor', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins long_context when that tier is price-equal to default (free upgrade)', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager();
    (manager as unknown as { cachedModels: unknown[] }).cachedModels = [
      modelWithTiers('equal-model', { input: 5 }, { input: 5 }),
    ];
    expect(manager.contextTierFor('equal-model')).toBe('long_context');
  });

  it('stays default when long_context is price-higher (avoids silent 2x cost)', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager();
    (manager as unknown as { cachedModels: unknown[] }).cachedModels = [
      modelWithTiers('pricey-model', { input: 5 }, { input: 10 }),
    ];
    expect(manager.contextTierFor('pricey-model')).toBe('default');
  });

  it('stays default for a non-tiered model', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager();
    (manager as unknown as { cachedModels: unknown[] }).cachedModels = [
      modelWithTiers('flat-model', { input: 5 }, null),
    ];
    expect(manager.contextTierFor('flat-model')).toBe('default');
  });

  it('returns undefined for an unknown model so the option is omitted', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager();
    (manager as unknown as { cachedModels: unknown[] }).cachedModels = [];
    expect(manager.contextTierFor('missing')).toBeUndefined();
    expect(manager.contextTierFor(undefined)).toBeUndefined();
  });

  it('recovers the model from the SDK event log when meta lacks it (legacy/external sessions)', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager();
    // getSessionMeta mock returns undefined (no meta.model); parseSessionModel
    // supplies the model the SDK session actually runs on, so resume/getSessionModel
    // can pin the correct tier on the first resume instead of silently defaulting.
    store.model = 'claude-opus-4.8';
    expect(manager.getSessionModel('legacy-session')).toBe('claude-opus-4.8');
    store.model = null;
    expect(manager.getSessionModel('truly-empty')).toBeNull();
  });
});
