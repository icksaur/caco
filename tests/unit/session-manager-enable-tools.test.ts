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
// Registry: resolve the github raw identities to their model-facing keys.
vi.mock('../../src/tool-key-registry.js', () => ({
  lookupMcpKey: vi.fn((server: string, raw: string) =>
    server === 'github' && raw === 'list_issues' ? 'github-list_issues'
      : server === 'github' && raw === 'get_pr' ? 'github-get_pr'
      : undefined),
  learnMcpKey: vi.fn(),
  learnFromMetadata: vi.fn(),
  keysForServer: vi.fn(() => []),
  allLearnedKeys: vi.fn(() => []),
}));

interface FakeActive {
  cwd: string;
  session: { rpc: { options: { update: ReturnType<typeof vi.fn> } } };
  toolFactory: () => unknown[];
  excludedTools?: string[];
  lastUsedAt: number;
}

const SID = 'sess-1';

// Two github MCP tools (the DYNAMIC-defer examples the reveal path targets) plus the
// builtins. Builtins in DEFAULT_EXCLUDED_BUILTINS are POLICY-disabled, never dynamically
// deferred, so the re-enable happy-path is tested with MCP tools; bash is used only to
// assert policy-disabled tools are NOT re-enableable.
function stubCatalog(manager: unknown) {
  (manager as { getCacoToolCatalog: () => unknown[] }).getCacoToolCatalog = () => [];
  (manager as { listMcpServers: () => Promise<unknown[]> }).listMcpServers =
    async () => [{ name: 'github', status: 'connected' }];
  (manager as { listMcpTools: (s: string) => Promise<unknown[]> }).listMcpTools =
    async () => [{ name: 'list_issues', description: 'List issues.' }, { name: 'get_pr', description: 'Get a PR.' }];
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

  it('enables a deferred MCP tool: shrinks excludedTools, only on rpc success', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager, active } = await makeManager(update, ['github-list_issues', 'github-get_pr']);
    const r = await manager.enableTools(SID, ['github-list_issues']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.enabled).toEqual(['github-list_issues']);
    // rpc called with the shrunk set; stored truth updated to match.
    expect(update).toHaveBeenCalledWith({ excludedTools: ['github-get_pr'] });
    expect(active.get(SID)!.excludedTools).toEqual(['github-get_pr']);
  });

  it('rejects re-enabling a policy-disabled builtin (bash family), no rpc call, no mutation', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager, active } = await makeManager(update, ['builtin:bash', 'github-list_issues']);
    const r = await manager.enableTools(SID, ['bash']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/disabled and not re-enableable/);
    expect(update).not.toHaveBeenCalled();
    expect(active.get(SID)!.excludedTools).toEqual(['builtin:bash', 'github-list_issues']);
  });

  it('does NOT mutate stored state when rpc reports failure (success-gated)', async () => {
    const update = vi.fn(async () => ({ success: false }));
    const { manager, active } = await makeManager(update, ['github-list_issues']);
    const r = await manager.enableTools(SID, ['github-list_issues']);
    expect(r.ok).toBe(false);
    // truth unchanged — the model's tool set never changed, no cache bust "counted".
    expect(active.get(SID)!.excludedTools).toEqual(['github-list_issues']);
  });

  it('does NOT mutate stored state when rpc throws', async () => {
    const update = vi.fn(async () => { throw new Error('rpc down'); });
    const { manager, active } = await makeManager(update, ['github-list_issues']);
    const r = await manager.enableTools(SID, ['github-list_issues']);
    expect(r.ok).toBe(false);
    expect(active.get(SID)!.excludedTools).toEqual(['github-list_issues']);
  });

  it('rejects an unknown name atomically (no rpc call, no mutation)', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager, active } = await makeManager(update, ['github-list_issues']);
    const r = await manager.enableTools(SID, ['github-list_issues', 'nonesuch']);
    expect(r.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(active.get(SID)!.excludedTools).toEqual(['github-list_issues']);
  });

  it('treats an already-enabled tool as an idempotent no-op (never blocks), no rpc call', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager, active } = await makeManager(update, ['github-list_issues']);
    const r = await manager.enableTools(SID, ['view']); // view is not excluded → already enabled
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.enabled).toEqual([]);
      expect(r.alreadyEnabled).toEqual(['builtin:view']);
    }
    expect(update).not.toHaveBeenCalled();
    expect(active.get(SID)!.excludedTools).toEqual(['github-list_issues']); // unchanged
  });

  it('a mixed batch (deferred + already-enabled) enables the deferred one, no-ops the rest', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager, active } = await makeManager(update, ['github-list_issues']);
    const r = await manager.enableTools(SID, ['github-list_issues', 'view']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.enabled).toEqual(['github-list_issues']);
      expect(r.alreadyEnabled).toEqual(['builtin:view']);
    }
    expect(update).toHaveBeenCalledWith({ excludedTools: [] });
    expect(active.get(SID)!.excludedTools).toEqual([]);
  });

  it('two concurrent enables in one turn COMPOSE (mutex) — neither clobbers the other', async () => {
    // Both target different deferred MCP tools; without the per-session lock the second
    // read-modify-write would clobber the first, re-excluding one tool.
    const update = vi.fn(async (p: { excludedTools: string[] }) => {
      // simulate async RPC latency so the two calls genuinely interleave
      await new Promise(r => setTimeout(r, 5));
      return { success: true, _p: p.excludedTools };
    });
    const { manager, active } = await makeManager(update, ['github-list_issues', 'github-get_pr', 'builtin:powershell']);
    const [r1, r2] = await Promise.all([
      manager.enableTools(SID, ['github-list_issues']),
      manager.enableTools(SID, ['github-get_pr']),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    // Final state: BOTH MCP tools removed, the policy-disabled builtin still excluded.
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

describe('SessionManager — auto-continuation state (spec-enable-tools-autocontinue P1)', () => {
  beforeEach(() => { vi.clearAllMocks(); storage.meta.clear(); });

  it('records revealed tools in pendingTools on a successful enable (union)', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager } = await makeManager(update, ['github-list_issues', 'github-get_pr']);
    await manager.enableTools(SID, ['github-list_issues']);
    expect(manager.getPendingTools(SID)).toEqual(['github-list_issues']);
    // A second reveal in the same dispatch UNIONS (does not overwrite).
    await manager.enableTools(SID, ['github-get_pr']);
    expect(new Set(manager.getPendingTools(SID))).toEqual(new Set(['github-list_issues', 'github-get_pr']));
  });

  it('records nothing on a no-op (already-enabled) enable', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager } = await makeManager(update, ['github-list_issues']);
    await manager.enableTools(SID, ['view']); // already enabled ⇒ enabled:[]
    expect(manager.getPendingTools(SID)).toEqual([]);
  });

  it('records nothing on a failed (rpc false) enable', async () => {
    const update = vi.fn(async () => ({ success: false }));
    const { manager } = await makeManager(update, ['github-list_issues']);
    await manager.enableTools(SID, ['github-list_issues']);
    expect(manager.getPendingTools(SID)).toEqual([]);
  });

  it('clearPendingTools leaves the attempt counter intact (independent state)', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager } = await makeManager(update, ['github-list_issues']);
    await manager.enableTools(SID, ['github-list_issues']);
    manager.bumpAutoContinueAttempts(SID);
    manager.bumpAutoContinueAttempts(SID);
    manager.clearPendingTools(SID);
    expect(manager.getPendingTools(SID)).toEqual([]);
    expect(manager.getAutoContinueAttempts(SID)).toBe(2); // counter survives the clear
  });

  it('resetAutoContinue clears BOTH pending tools and the counter', async () => {
    const update = vi.fn(async () => ({ success: true }));
    const { manager } = await makeManager(update, ['github-list_issues']);
    await manager.enableTools(SID, ['github-list_issues']);
    manager.bumpAutoContinueAttempts(SID);
    manager.resetAutoContinue(SID);
    expect(manager.getPendingTools(SID)).toEqual([]);
    expect(manager.getAutoContinueAttempts(SID)).toBe(0);
  });
});

describe('SessionManager.hasPendingAutoContinue (spec-idle-authority)', () => {
  beforeEach(() => { vi.clearAllMocks(); storage.meta.clear(); });

  it('true when pending tools exist, pref on, under cap', async () => {
    const { setAutoContinuePrefProvider } = await import('../../src/session-manager.js');
    setAutoContinuePrefProvider(() => true);
    const { manager } = await makeManager(vi.fn(async () => ({ success: true })), ['github-list_issues']);
    await manager.enableTools(SID, ['github-list_issues']);
    expect(manager.hasPendingAutoContinue(SID)).toBe(true);
  });

  it('false when nothing is pending', async () => {
    const { setAutoContinuePrefProvider } = await import('../../src/session-manager.js');
    setAutoContinuePrefProvider(() => true);
    const { manager } = await makeManager(vi.fn(async () => ({ success: true })), ['github-list_issues']);
    expect(manager.hasPendingAutoContinue(SID)).toBe(false);
  });

  it('false at/over the cap (real idle — cap message fires separately)', async () => {
    const { setAutoContinuePrefProvider } = await import('../../src/session-manager.js');
    setAutoContinuePrefProvider(() => true);
    const { manager } = await makeManager(vi.fn(async () => ({ success: true })), ['github-list_issues']);
    await manager.enableTools(SID, ['github-list_issues']);
    manager.bumpAutoContinueAttempts(SID);
    manager.bumpAutoContinueAttempts(SID);
    manager.bumpAutoContinueAttempts(SID); // attempts = 3 = cap
    expect(manager.hasPendingAutoContinue(SID)).toBe(false);
  });

  it('false when the operator preference is off (via injected provider)', async () => {
    const { setAutoContinuePrefProvider } = await import('../../src/session-manager.js');
    setAutoContinuePrefProvider(() => false);
    const { manager } = await makeManager(vi.fn(async () => ({ success: true })), ['github-list_issues']);
    await manager.enableTools(SID, ['github-list_issues']);
    expect(manager.hasPendingAutoContinue(SID)).toBe(false);
    setAutoContinuePrefProvider(() => true); // restore for other tests
  });

  it('hasAnyPendingAutoContinue mirrors the per-session predicate across sessions', async () => {
    const { setAutoContinuePrefProvider } = await import('../../src/session-manager.js');
    setAutoContinuePrefProvider(() => true);
    const { manager } = await makeManager(vi.fn(async () => ({ success: true })), ['github-list_issues']);
    expect(manager.hasAnyPendingAutoContinue()).toBe(false);
    await manager.enableTools(SID, ['github-list_issues']);
    expect(manager.hasAnyPendingAutoContinue()).toBe(true);
    manager.resetAutoContinue(SID);
    expect(manager.hasAnyPendingAutoContinue()).toBe(false);
  });

  it('hasAnyPendingAutoContinue stays true while a continuation is in flight (no pending tools)', async () => {
    // The set-up sub-window: pending already cleared, startDispatch not yet run.
    const { manager } = await makeManager(vi.fn(async () => ({ success: true })), ['github-list_issues']);
    expect(manager.hasAnyPendingAutoContinue()).toBe(false);
    manager.markContinuationInFlight(SID);
    expect(manager.hasAnyPendingAutoContinue()).toBe(true);
    // ...but the per-session suppressor stays pending-driven so the continuation's
    // own end() still emits a real idle.
    expect(manager.hasPendingAutoContinue(SID)).toBe(false);
    manager.clearContinuationInFlight(SID);
    expect(manager.hasAnyPendingAutoContinue()).toBe(false);
  });
});
