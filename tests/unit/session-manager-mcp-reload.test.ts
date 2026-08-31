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
  return { fakeClient, CopilotClient: vi.fn(function CopilotClient() { return fakeClient; }), approveAll: vi.fn() };
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

const loader = vi.hoisted(() => ({
  loadMcpServers: vi.fn(async () => ({})),
  loadMcpServersStrict: vi.fn(
    async (): Promise<{ ok: true; servers: Record<string, unknown> | undefined } | { ok: false; error: string }> =>
      ({ ok: true, servers: { github: {} } }),
  ),
}));

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
vi.mock('../../src/mcp-config-loader.js', () => loader);
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
  excludedTools: string[];
  lastUsedAt: number;
}

type Manager = {
  activeSessions: Map<string, FakeActive>;
  sharedClient: { rpc: { mcp: { config: { reload: ReturnType<typeof vi.fn> } } } } | null;
  reloadMcpConfig: () => Promise<{ ok: boolean; error?: string; recreated: string[]; failed: { sessionId: string; error: string }[]; skippedBusy: string[]; skippedReplaced: string[] }>;
  resume: (id: string, cfg: unknown) => Promise<unknown>;
  isBusy: (id: string) => boolean;
};

function fakeActive(): FakeActive {
  return {
    cwd: '/x',
    session: { disconnect: vi.fn(async () => {}) },
    toolFactory: () => [],
    excludedTools: ['ADO-x'],
    lastUsedAt: Date.now(),
  };
}

async function makeManager(reload = vi.fn(async () => {})): Promise<{ manager: Manager; resume: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn> }> {
  const { SessionManager } = await import('../../src/session-manager.js');
  const manager = new SessionManager() as unknown as Manager;
  // The client-level MCP config reload (spec: process-wide cache drop).
  manager.sharedClient = { rpc: { mcp: { config: { reload } } } };
  // Stub resume so a recreate re-inserts a fresh active session (as the real resume does).
  const resume = vi.fn(async (id: string) => {
    manager.activeSessions.set(id, fakeActive());
    return { sessionId: id };
  });
  manager.resume = resume as unknown as Manager['resume'];
  return { manager, resume, reload };
}

beforeEach(() => { vi.clearAllMocks(); storage.meta.clear(); loader.loadMcpServersStrict.mockResolvedValue({ ok: true, servers: { github: {} } }); });

describe('SessionManager.reloadMcpConfig — transactional warm reload (cf-reload)', () => {
  it('parse failure is a total no-op (ok:false, nothing recreated, no cache drop)', async () => {
    const { manager, reload } = await makeManager();
    const a = fakeActive();
    manager.activeSessions.set('s1', a);
    loader.loadMcpServersStrict.mockResolvedValue({ ok: false, error: 'mcp-config.json is malformed: x' });

    const r = await manager.reloadMcpConfig();
    expect(r.ok).toBe(false);
    expect(r.recreated).toEqual([]);
    expect(reload).not.toHaveBeenCalled(); // no cache drop
    expect(manager.activeSessions.get('s1')).toBe(a); // untouched
  });

  it('happy path recreates each active session; client config.reload called once BEFORE recreates', async () => {
    const { manager, resume, reload } = await makeManager();
    manager.activeSessions.set('s1', fakeActive());
    manager.activeSessions.set('s2', fakeActive());

    const r = await manager.reloadMcpConfig();
    expect(r.ok).toBe(true);
    expect(r.recreated.sort()).toEqual(['s1', 's2']);
    expect(reload).toHaveBeenCalledTimes(1); // process-wide client cache drop, once
    // Each recreate threads the validated snapshot (github map), never a re-read.
    for (const call of resume.mock.calls) {
      expect((call[1] as { mcpServersOverride?: unknown }).mcpServersOverride).toEqual({ github: {} });
      expect((call[1] as { warmRecreate?: boolean }).warmRecreate).toBe(true);
    }
  });

  it('a validated-empty config threads the null sentinel (not a disk re-read)', async () => {
    const { manager, resume } = await makeManager();
    manager.activeSessions.set('s1', fakeActive());
    loader.loadMcpServersStrict.mockResolvedValue({ ok: true, servers: undefined });

    await manager.reloadMcpConfig();
    expect((resume.mock.calls[0][1] as { mcpServersOverride?: unknown }).mcpServersOverride).toBeNull();
  });

  it('a busy session is skipped and reported, not recreated', async () => {
    const { manager, resume } = await makeManager();
    manager.activeSessions.set('busy', fakeActive());
    manager.activeSessions.set('idle', fakeActive());
    manager.isBusy = ((id: string) => id === 'busy') as Manager['isBusy'];

    const r = await manager.reloadMcpConfig();
    expect(r.skippedBusy).toEqual(['busy']);
    expect(r.recreated).toEqual(['idle']);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('client config.reload() throw is a transactional failure — nothing recreated', async () => {
    const { manager, resume } = await makeManager(vi.fn(async () => { throw new Error('rpc down'); }));
    manager.activeSessions.set('s1', fakeActive());

    const r = await manager.reloadMcpConfig();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mcp.config.reload failed/);
    expect(resume).not.toHaveBeenCalled();
  });

  it('one session recreate failure lands in failed; others still recreated', async () => {
    const { manager, resume } = await makeManager();
    manager.activeSessions.set('good', fakeActive());
    manager.activeSessions.set('bad', fakeActive());
    resume.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('resume boom');
      manager.activeSessions.set(id, fakeActive());
      return { sessionId: id };
    });

    const r = await manager.reloadMcpConfig();
    expect(r.ok).toBe(true);
    expect(r.recreated).toEqual(['good']);
    expect(r.failed).toEqual([{ sessionId: 'bad', error: 'resume boom' }]);
  });

  it('a session replaced under the same id mid-loop is NOT disconnected (identity guard)', async () => {
    const { manager, resume } = await makeManager();
    const s1 = fakeActive();
    const s2orig = fakeActive();
    manager.activeSessions.set('s1', s1);
    manager.activeSessions.set('s2', s2orig);
    // Iteration order is insertion order [s1, s2]. The per-session isBusy check runs first;
    // use it to simulate a concurrent replacement of the not-yet-processed s2 while s1 is
    // being handled. When the loop reaches s2, its snapshot target (s2orig) no longer
    // matches activeSessions.get('s2') → it must be skipped, and s2orig never disconnected.
    const s2replacement = fakeActive();
    manager.isBusy = ((id: string) => {
      if (id === 's1') manager.activeSessions.set('s2', s2replacement);
      return false;
    }) as Manager['isBusy'];

    const r = await manager.reloadMcpConfig();
    expect(r.recreated).toEqual(['s1']); // only s1; s2 was replaced → skipped
    expect(r.skippedReplaced).toEqual(['s2']);
    expect(s2orig.session.disconnect).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('no active session ⇒ ok:true, client cache dropped, nothing recreated', async () => {
    const { manager, resume, reload } = await makeManager();
    const r = await manager.reloadMcpConfig();
    expect(r.ok).toBe(true);
    expect(r.recreated).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1); // cache still dropped, even with no session
    expect(resume).not.toHaveBeenCalled();
  });
});
