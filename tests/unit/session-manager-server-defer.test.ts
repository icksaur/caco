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
    ensureSessionMeta: vi.fn(),
    getSessionMeta: vi.fn((id: string) => meta.get(id)),
    setSessionMeta: vi.fn(),
    updateSessionMeta: vi.fn(() => true),
    getSessionIconPath: vi.fn(() => null),
    setSessionOrder: vi.fn(),
  };
});

// System-wide deferred-server set, driven by the test.
const deferStore = vi.hoisted(() => ({ servers: new Set<string>() }));

vi.mock('@github/copilot-sdk', () => sdk);
vi.mock('../../src/storage.js', () => storage);
vi.mock('../../src/session-runtime.js', () => ({ disposeSessionRuntime: vi.fn() }));
vi.mock('../../src/event-bus.js', () => ({ broadcastEvent: vi.fn(), broadcastGlobalEvent: vi.fn() }));
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

// The github server owns two model-facing keys; linear owns one.
vi.mock('../../src/tool-key-registry.js', () => ({
  lookupMcpKey: vi.fn(),
  learnMcpKey: vi.fn(),
  learnFromMetadata: vi.fn(),
  keysForServer: vi.fn((server: string) =>
    server === 'github' ? ['github-list_issues', 'github-get_pr'] : server === 'linear' ? ['linear-x'] : []),
}));

vi.mock('../../src/manual-defer-store.js', () => ({
  getDeferredServers: vi.fn(() => [...deferStore.servers]),
  setServerDeferred: vi.fn((server: string, deferred: boolean) => {
    if (deferred) deferStore.servers.add(server); else deferStore.servers.delete(server);
  }),
  isServerDeferred: vi.fn((server: string) => deferStore.servers.has(server)),
}));

interface FakeActive {
  cwd: string;
  session: { rpc: { options: { update: ReturnType<typeof vi.fn> } } };
  toolFactory: () => unknown[];
  excludedTools?: string[];
  lastUsedAt: number;
}

async function makeManager(update: ReturnType<typeof vi.fn>, excluded: string[]) {
  const { SessionManager } = await import('../../src/session-manager.js');
  const manager = new SessionManager();
  const active = (manager as unknown as { activeSessions: Map<string, FakeActive> }).activeSessions;
  active.set('sess-1', {
    cwd: '/x',
    session: { rpc: { options: { update } } },
    toolFactory: () => [],
    excludedTools: [...excluded],
    lastUsedAt: Date.now(),
  });
  return { manager, active };
}

describe('SessionManager.setServerDeferred — manual per-server defer (D1)', () => {
  beforeEach(() => { vi.clearAllMocks(); storage.meta.clear(); deferStore.servers.clear(); });

  it('defer adds exactly that server\'s keys to a live session, only on rpc success', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager, active } = await makeManager(update, ['builtin:powershell']);
    const result = await manager.setServerDeferred('github', true);
    expect(result.affectedSessions).toBe(1);
    expect(active.get('sess-1')!.excludedTools!.sort()).toEqual(
      ['builtin:powershell', 'github-get_pr', 'github-list_issues'].sort());
  });

  it('undefer removes exactly that server\'s keys, leaving others intact', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager, active } = await makeManager(
      update, ['builtin:powershell', 'github-list_issues', 'github-get_pr', 'linear-x']);
    deferStore.servers.add('github');
    await manager.setServerDeferred('github', false);
    expect(active.get('sess-1')!.excludedTools!.sort()).toEqual(
      ['builtin:powershell', 'linear-x'].sort());
  });

  it('does not mutate excludedTools when rpc fails', async () => {
    const update = vi.fn(async () => ({ success: false }));
    const { manager, active } = await makeManager(update, ['builtin:powershell']);
    const result = await manager.setServerDeferred('github', true);
    expect(result.affectedSessions).toBe(0);
    expect(result.failedSessions).toEqual(['sess-1']);
    expect(active.get('sess-1')!.excludedTools).toEqual(['builtin:powershell']);
  });

  it('manualDeferredKeys reflects the persisted deferred servers', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager } = await makeManager(update, []);
    deferStore.servers.add('github');
    deferStore.servers.add('linear');
    expect(manager.manualDeferredKeys().sort()).toEqual(
      ['github-get_pr', 'github-list_issues', 'linear-x'].sort());
  });
});
