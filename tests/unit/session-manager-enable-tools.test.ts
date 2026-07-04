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
vi.mock('../../src/mcp-config-loader.js', () => ({ loadMcpServers: vi.fn(async () => ({})) }));
vi.mock('../../src/provider-registry.js', () => ({
  hasProviders: vi.fn(() => false),
  listByokModels: vi.fn(() => []),
  resolveModel: vi.fn((model: string) => ({ sdkModel: model, cacoId: model })),
}));
vi.mock('../../src/quota-poller.js', () => ({ pollQuota: vi.fn() }));
vi.mock('../../src/memory-tool.js', () => ({ formatMemoryForPrompt: vi.fn(() => '') }));
// Registry: resolve the github list_issues raw identity to its model-facing key.
vi.mock('../../src/tool-key-registry.js', () => ({
  lookupMcpKey: vi.fn((server: string, raw: string) => (server === 'github' && raw === 'list_issues' ? 'github-list_issues' : undefined)),
  learnMcpKey: vi.fn(),
  learnFromMetadata: vi.fn(),
}));

interface FakeActive {
  cwd: string;
  session: { rpc: { options: { update: ReturnType<typeof vi.fn> } } };
  toolFactory: () => unknown[];
  excludedTools?: string[];
  lastUsedAt: number;
}

const SID = 'sess-1';

// A github MCP tool the catalog will contain, so resolveEnableTargets can map it.
function stubCatalog(manager: unknown) {
  (manager as { getCacoToolCatalog: () => unknown[] }).getCacoToolCatalog = () => [];
  (manager as { listMcpServers: () => Promise<unknown[]> }).listMcpServers =
    async () => [{ name: 'github', status: 'connected' }];
  (manager as { listMcpTools: (s: string) => Promise<unknown[]> }).listMcpTools =
    async () => [{ name: 'list_issues', description: 'List issues.' }];
  (manager as { listBuiltinTools: () => Promise<unknown[]> }).listBuiltinTools =
    async () => [{ name: 'bash', description: 'Run a shell command.' }, { name: 'view', description: 'Read.' }];
  (manager as { getCurrentToolMetadata: () => Promise<unknown[]> }).getCurrentToolMetadata = async () => [];
}

async function makeManager(update: ReturnType<typeof vi.fn>, excluded: string[]) {
  const { SessionManager } = await import('../../src/session-manager.js');
  const manager = new SessionManager();
  stubCatalog(manager);
  const active = (manager as unknown as { activeSessions: Map<string, FakeActive> }).activeSessions;
  active.set(SID, {
    cwd: '/x',
    session: { rpc: { options: { update } } },
    toolFactory: () => [],
    excludedTools: [...excluded],
    lastUsedAt: Date.now(),
  });
  return { manager, active };
}

describe('SessionManager.enableTools — reveal path (B2)', () => {
  beforeEach(() => { vi.clearAllMocks(); storage.meta.clear(); });

  it('enables a deferred builtin: shrinks excludedTools, only on rpc success', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager, active } = await makeManager(update, ['builtin:bash', 'builtin:powershell']);
    const r = await manager.enableTools(SID, ['bash']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.enabled).toEqual(['builtin:bash']);
    // rpc called with the shrunk set; stored truth updated to match.
    expect(update).toHaveBeenCalledWith({ excludedTools: ['builtin:powershell'] });
    expect(active.get(SID)!.excludedTools).toEqual(['builtin:powershell']);
  });

  it('does NOT mutate stored state when rpc reports failure (success-gated)', async () => {
    const update = vi.fn(async () => ({ success: false }));
    const { manager, active } = await makeManager(update, ['builtin:bash']);
    const r = await manager.enableTools(SID, ['bash']);
    expect(r.ok).toBe(false);
    // truth unchanged — the model's tool set never changed, no cache bust "counted".
    expect(active.get(SID)!.excludedTools).toEqual(['builtin:bash']);
  });

  it('does NOT mutate stored state when rpc throws', async () => {
    const update = vi.fn(async () => { throw new Error('rpc down'); });
    const { manager, active } = await makeManager(update, ['builtin:bash']);
    const r = await manager.enableTools(SID, ['bash']);
    expect(r.ok).toBe(false);
    expect(active.get(SID)!.excludedTools).toEqual(['builtin:bash']);
  });

  it('rejects an unknown name atomically (no rpc call, no mutation)', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager, active } = await makeManager(update, ['builtin:bash']);
    const r = await manager.enableTools(SID, ['bash', 'nonesuch']);
    expect(r.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(active.get(SID)!.excludedTools).toEqual(['builtin:bash']);
  });

  it('treats an already-enabled tool as an idempotent no-op (never blocks), no rpc call', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager, active } = await makeManager(update, ['builtin:bash']);
    const r = await manager.enableTools(SID, ['view']); // view is not excluded → already enabled
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.enabled).toEqual([]);
      expect(r.alreadyEnabled).toEqual(['builtin:view']);
    }
    expect(update).not.toHaveBeenCalled();
    expect(active.get(SID)!.excludedTools).toEqual(['builtin:bash']); // unchanged
  });

  it('a mixed batch (deferred + already-enabled) enables the deferred one, no-ops the rest', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager, active } = await makeManager(update, ['builtin:bash']);
    const r = await manager.enableTools(SID, ['bash', 'view']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.enabled).toEqual(['builtin:bash']);
      expect(r.alreadyEnabled).toEqual(['builtin:view']);
    }
    expect(update).toHaveBeenCalledWith({ excludedTools: [] });
    expect(active.get(SID)!.excludedTools).toEqual([]);
  });

  it('two concurrent enables in one turn COMPOSE (mutex) — neither clobbers the other', async () => {
    // Both target different deferred builtins; without the per-session lock the second
    // read-modify-write would clobber the first, re-excluding one tool.
    const update = vi.fn(async (p: { excludedTools: string[] }) => {
      // simulate async RPC latency so the two calls genuinely interleave
      await new Promise(r => setTimeout(r, 5));
      return { success: true, _p: p.excludedTools };
    });
    const { manager, active } = await makeManager(update, ['builtin:bash', 'builtin:read_bash', 'builtin:powershell']);
    // extend the catalog stub to know read_bash
    (manager as unknown as { listBuiltinTools: () => Promise<unknown[]> }).listBuiltinTools =
      async () => [
        { name: 'bash', description: 'Run a shell command.' },
        { name: 'read_bash', description: 'Read output.' },
        { name: 'view', description: 'Read.' },
      ];
    const [r1, r2] = await Promise.all([
      manager.enableTools(SID, ['bash']),
      manager.enableTools(SID, ['read_bash']),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    // Final state: BOTH removed, powershell still excluded (nothing clobbered).
    expect(active.get(SID)!.excludedTools).toEqual(['builtin:powershell']);
  });

  it('enables an MCP tool by its model-facing key', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager } = await makeManager(update, ['github-list_issues']);
    const r = await manager.enableTools(SID, ['github-list_issues']);
    expect(r.ok).toBe(true);
    expect(update).toHaveBeenCalledWith({ excludedTools: [] });
  });

  it('is a no-op-safe for an unknown session', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager } = await makeManager(update, ['builtin:bash']);
    const r = await manager.enableTools('ghost', ['bash']);
    expect(r.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
