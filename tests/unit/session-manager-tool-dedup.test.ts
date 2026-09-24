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

type ToolLike = { name: string; handler?: (a: unknown, i: unknown) => unknown };
type Manager = { create: (cwd: string, opts: { model: string; toolFactory: () => unknown[] }) => Promise<string> };

/**
 * The dedup wrapper only protects a session if the tools reaching the SDK are
 * the wrapped ones. create() and resume() each build a fresh set from the
 * factory, so both seams are checked: a handler the SDK is handed must run once
 * for a request delivered twice.
 */
function countingFactory() {
  const handler = vi.fn(async () => 'ran');
  return { handler, factory: () => [{ name: 'probe', handler }] as ToolLike[] };
}

async function invokeTwice(tools: ToolLike[]): Promise<void> {
  const tool = tools.find(t => t.name === 'probe');
  expect(tool?.handler, 'the SDK received no probe handler').toBeDefined();
  const inv = { sessionId: 'sess-x', toolCallId: 'call-dup', toolName: 'probe', arguments: {} };
  await Promise.all([tool!.handler!({}, inv), tool!.handler!({}, inv)]);
}

describe('SessionManager hands the SDK idempotent tool handlers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    storage.meta.clear();
    sdk.fakeClient.ping.mockResolvedValue({ message: 'ok', timestamp: new Date(0).toISOString() });
    const { _resetToolCallMemoForTests } = await import('../../src/tool-call-dedup.js');
    _resetToolCallMemoForTests();
  });

  it('wraps the tools passed to createSession', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager() as unknown as Manager;
    const { handler, factory } = countingFactory();
    await manager.create(process.cwd(), { model: 'claude-sonnet-4.6', toolFactory: factory });

    const cfg = (sdk.fakeClient.createSession.mock.calls[0] as unknown[])[0] as { tools: ToolLike[] };
    await invokeTwice(cfg.tools);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('wraps the tools passed to resumeSession', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager();
    (manager as unknown as { sessionCache: Map<string, unknown> })
      .sessionCache.set('sess-1', { cwd: process.cwd(), summary: null });
    const store = await import('../../src/sdk-session-store.js');
    vi.mocked(store.readSessionHeadResult).mockReturnValue(
      { ok: true, value: { start: { type: 'session.start' }, hasMore: true } } as never,
    );
    const { handler, factory } = countingFactory();

    await (manager as unknown as { resume: (id: string, o: unknown) => Promise<unknown> })
      .resume('sess-1', { toolFactory: factory });

    const cfg = (sdk.fakeClient.resumeSession.mock.calls[0] as unknown[]).find(
      (a): a is { tools: ToolLike[] } => typeof a === 'object' && a !== null && 'tools' in (a as object),
    );
    expect(cfg, 'resumeSession received no config with tools').toBeDefined();
    await invokeTwice(cfg!.tools);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
