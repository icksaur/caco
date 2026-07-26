import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

const sdk = vi.hoisted(() => {
  const fakeClient = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    forceStop: vi.fn(async () => {}),
    ping: vi.fn(async () => ({ message: 'ok', timestamp: new Date(0).toISOString() })),
    getState: vi.fn(() => 'connected'),
    createSession: vi.fn(),
    resumeSession: vi.fn(),
    deleteSession: vi.fn(async () => {}),
    listModels: vi.fn(),
    rpc: {
      account: { getQuota: vi.fn(async () => ({ quotaSnapshots: {} })) },
      models: { list: vi.fn(async () => ({ models: [] })) },
      tools: { list: vi.fn(async () => ({ tools: [] })) },
      sessions: { fork: vi.fn(async () => ({ sessionId: 'forked-session' })) },
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
  const corruptMeta = new Set<string>();
  return {
    meta,
    corruptMeta,
    ensureSessionMeta: vi.fn((sessionId: string) => {
      if (!meta.has(sessionId)) meta.set(sessionId, { name: '' });
    }),
    getSessionMeta: vi.fn((sessionId: string) => corruptMeta.has(sessionId) ? undefined : meta.get(sessionId)),
    setSessionMeta: vi.fn((sessionId: string, value: Record<string, unknown>) => meta.set(sessionId, value)),
    readSessionMeta: vi.fn((sessionId: string) => {
      if (corruptMeta.has(sessionId)) return { ok: false, kind: 'corrupt', error: new Error('bad meta') };
      return { ok: true, value: meta.get(sessionId) ?? { name: '' } };
    }),
    updateSessionMeta: vi.fn((sessionId: string, mutate: (m: Record<string, unknown>) => void, opts?: { createIfMissing?: boolean }) => {
      if (corruptMeta.has(sessionId)) return false;
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

const sdkStore = vi.hoisted(() => {
  const listedSessionIds: string[] = [];
  const eventsResult = new Map<string, unknown>();
  const events = new Map<string, unknown[]>();
  const workspace = new Map<string, unknown>();
  const parsedModels = new Map<string, string>();
  return {
    listedSessionIds,
    eventsResult,
    events,
    workspace,
    parsedModels,
    readSessionWorkspace: vi.fn((sessionId: string) => workspace.get(sessionId) ?? null),
    readSessionEvents: vi.fn((sessionId: string) => events.get(sessionId) ?? []),
    readSessionEventsResult: vi.fn((sessionId: string) => eventsResult.get(sessionId) ?? { ok: true, value: events.get(sessionId) ?? [] }),
    parseSessionModel: vi.fn((sessionId: string) => parsedModels.get(sessionId) ?? null),
    listSessionIds: vi.fn(() => [...listedSessionIds]),
    STATE_DIR: 'tests/unit/nonexistent-state',
  };
});

const dispatch = vi.hoisted(() => {
  const busy = new Set<string>();
  const correlations = new Map<string, string>();
  const depths = new Map<string, number>();
  return {
    busy,
    correlations,
    depths,
    waitForIdleResult: 'idle',
    dispatchState: {
      start: vi.fn((sessionId: string, correlationId: string, depth = 1) => {
        busy.add(sessionId);
        correlations.set(sessionId, correlationId);
        depths.set(sessionId, depth);
      }),
      end: vi.fn((sessionId: string) => {
        busy.delete(sessionId);
        correlations.delete(sessionId);
        depths.delete(sessionId);
      }),
      isBusy: vi.fn((sessionId: string) => busy.has(sessionId)),
      getAllActive: vi.fn(() => new Set(busy)),
      waitForIdle: vi.fn(async () => dispatch.waitForIdleResult),
      getCorrelationId: vi.fn((sessionId: string) => correlations.get(sessionId)),
      getDepth: vi.fn((sessionId: string) => depths.get(sessionId)),
      setIdleSuppressor: vi.fn(),
    },
  };
});

const providerRegistry = vi.hoisted(() => ({
  hasProviders: vi.fn(() => false),
  listByokModels: vi.fn(() => []),
  resolveModel: vi.fn((model: string) => model.startsWith('byok:')
    ? { sdkModel: model.slice('byok:'.length), cacoId: model, provider: { id: 'byok-provider' }, providerId: 'byok-provider' }
    : { sdkModel: model, cacoId: model }),
}));

const runtime = vi.hoisted(() => ({ disposeSessionRuntime: vi.fn() }));
const eventBus = vi.hoisted(() => ({ broadcastEvent: vi.fn(), broadcastGlobalEvent: vi.fn() }));
const fileEdits = vi.hoisted(() => ({ cancelCardPersist: vi.fn() }));
const rotation = vi.hoisted(() => ({
  reconcileRotation: vi.fn(() => 'clean'),
  autoRotateIfEligible: vi.fn(async () => {}),
}));
const repair = vi.hoisted(() => ({
  shouldAutoRepairSessionError: vi.fn((message: string) => message.includes('repairable')),
  repairSessionEvents: vi.fn(() => 'removed malformed event'),
}));
const manualDefer = vi.hoisted(() => ({
  getDeferredServers: vi.fn(() => []),
  setServerDeferred: vi.fn(),
}));
const autoDefer = vi.hoisted(() => ({
  getAutoDeferred: vi.fn(() => new Set<string>()),
  addAutoDeferred: vi.fn(),
  removeAutoDeferred: vi.fn(),
}));
const toolRegistry = vi.hoisted(() => ({
  lookupMcpKey: vi.fn((server: string, raw: string) => server === 'github' && raw === 'list_issues' ? 'github-list_issues' : undefined),
  learnFromMetadata: vi.fn(),
  keysForServer: vi.fn((server: string) => server === 'github' ? ['github-list_issues'] : []),
  allLearnedKeys: vi.fn(() => []),
}));
const throughput = vi.hoisted(() => ({
  getToolsUsed: vi.fn(() => new Set<string>()),
  setDeferredDefsProvider: vi.fn(),
  recordCompaction: vi.fn(),
}));
const restart = vi.hoisted(() => ({ setAnyPendingProvider: vi.fn() }));

vi.mock('@github/copilot-sdk', () => sdk);
vi.mock('../../src/storage.js', () => storage);
vi.mock('../../src/storage-paths.js', () => ({ getSessionDir: (sessionId: string) => join(process.cwd(), '.coverage-session-data', sessionId) }));
vi.mock('../../src/file-edits-store.js', () => fileEdits);
vi.mock('../../src/session-runtime.js', () => runtime);
vi.mock('../../src/event-bus.js', () => eventBus);
vi.mock('../../src/sdk-session-store.js', () => sdkStore);
vi.mock('../../src/mcp-config-loader.js', () => ({ loadMcpServers: vi.fn(async () => ({ github: { type: 'stdio' } })) }));
vi.mock('../../src/provider-registry.js', () => providerRegistry);
vi.mock('../../src/quota-poller.js', () => ({ pollQuota: vi.fn() }));
vi.mock('../../src/memory-tool.js', () => ({ formatMemoryForPrompt: vi.fn(() => 'remember this') }));
vi.mock('../../src/dispatch-state.js', () => ({ dispatchState: dispatch.dispatchState }));
vi.mock('../../src/session-history-rotation.js', () => rotation);
vi.mock('../../src/session-auto-repair.js', () => repair);
vi.mock('../../src/manual-defer-store.js', () => manualDefer);
vi.mock('../../src/auto-defer-store.js', () => autoDefer);
vi.mock('../../src/tool-key-registry.js', () => toolRegistry);
vi.mock('../../src/tool-usage-store.js', () => ({
  getNowActiveSeconds: vi.fn(() => 1_000),
  getLastUsedActiveSeconds: vi.fn(() => new Map()),
  stampToolUsage: vi.fn(),
  DEFER_STALE_THRESHOLD_ACTIVE_SECONDS: 7_200,
}));
vi.mock('../../src/session-throughput.js', () => throughput);
vi.mock('../../src/restart-manager.js', () => restart);
vi.mock('../../src/unobserved-tracker.js', () => ({ unobservedTracker: { hydrate: vi.fn(), isUnobserved: vi.fn(() => false) } }));
vi.mock('../../src/herd.js', () => ({ isHerdParent: vi.fn(() => false) }));
vi.mock('../../src/observe/hook.js', () => ({ createObservationHook: vi.fn(() => vi.fn()) }));

interface FakeSession {
  sessionId: string;
  disconnect: ReturnType<typeof vi.fn>;
  sendAndWait: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  getEvents: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  rpc: {
    agent: { list: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn> };
    commands: { list: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn> };
    history: { compact: ReturnType<typeof vi.fn> };
    model: { setReasoningEffort: ReturnType<typeof vi.fn> };
    options: { update: ReturnType<typeof vi.fn> };
    mcp: { list: ReturnType<typeof vi.fn>; listTools: ReturnType<typeof vi.fn> };
    tools: { getCurrentMetadata: ReturnType<typeof vi.fn> };
    metadata: { contextInfo: ReturnType<typeof vi.fn> };
  };
}

const fakeSessions = new Map<string, FakeSession>();
const managers: Array<{ shutdown: () => Promise<void> }> = [];

function model(id: string, supportsReasoningEffort = false) {
  return {
    id,
    name: id,
    capabilities: {
      supports: { reasoningEffort: supportsReasoningEffort },
      limits: { max_prompt_tokens: 128_000, max_context_window_tokens: 200_000 },
    },
    supportedReasoningEfforts: supportsReasoningEffort ? ['low', 'high'] : undefined,
    defaultReasoningEffort: supportsReasoningEffort ? 'low' : undefined,
    billing: {
      tokenPrices: {
        inputPrice: 1,
        outputPrice: 2,
        cachePrice: 0.1,
        contextMax: 128_000,
        batchSize: 1_000_000,
        longContext: { inputPrice: 1, outputPrice: 2, cachePrice: 0.1, contextMax: 256_000 },
      },
    },
  };
}

function makeSession(sessionId: string): FakeSession {
  const session: FakeSession = {
    sessionId,
    disconnect: vi.fn(async () => {}),
    sendAndWait: vi.fn(async () => ({ text: 'answer' })),
    send: vi.fn(async () => 'queued'),
    getEvents: vi.fn(async () => [{ type: 'session.start' }, { type: 'message' }]),
    abort: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    rpc: {
      agent: {
        list: vi.fn(async () => ({ agents: [{ name: 'reviewer' }] })),
        select: vi.fn(async ({ name }: { name: string }) => ({ agent: { name } })),
      },
      commands: {
        list: vi.fn(async () => ({ commands: [{ name: 'build' }] })),
        invoke: vi.fn(async ({ name, input }: { name: string; input?: string }) => ({ name, input, output: 'ok' })),
      },
      history: {
        compact: vi.fn(async () => ({ success: true, tokensRemoved: 10, messagesRemoved: 2 })),
      },
      model: {
        setReasoningEffort: vi.fn(async () => ({})),
      },
      options: {
        update: vi.fn(async () => ({ success: true })),
      },
      mcp: {
        list: vi.fn(async () => ({ servers: [{ name: 'github', status: 'connected', source: 'project' }] })),
        listTools: vi.fn(async () => ({ tools: [{ name: 'list_issues', description: 'List issues.' }] })),
      },
      tools: {
        getCurrentMetadata: vi.fn(async () => ({ tools: [{ name: 'github-list_issues', mcpServerName: 'github', mcpToolName: 'list_issues' }] })),
      },
      metadata: {
        contextInfo: vi.fn(async () => ({ contextInfo: { promptTokens: 10, toolDefinitionsTokens: 3, mcpToolsTokens: 2 } })),
      },
    },
  };
  fakeSessions.set(sessionId, session);
  return session;
}

async function newManager() {
  const { SessionManager } = await import('../../src/session-manager.js');
  const manager = new SessionManager();
  managers.push(manager);
  return manager;
}

async function initializedManager() {
  const manager = await newManager();
  await manager.init();
  return manager;
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.meta.clear();
  storage.corruptMeta.clear();
  sdkStore.listedSessionIds.length = 0;
  sdkStore.eventsResult.clear();
  sdkStore.events.clear();
  sdkStore.workspace.clear();
  sdkStore.parsedModels.clear();
  dispatch.busy.clear();
  dispatch.correlations.clear();
  dispatch.waitForIdleResult = 'idle';
  fakeSessions.clear();
  sdk.fakeClient.listModels.mockResolvedValue([model('github-model'), model('github-model-2'), model('effort-model', true), model('byok:wire')]);
  sdk.fakeClient.createSession.mockImplementation(async () => makeSession('created-session'));
  sdk.fakeClient.resumeSession.mockImplementation(async (sessionId: string) => makeSession(sessionId));
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.shutdown()));
});

describe('SessionManager coverage seams', () => {
  it('discovers cached sessions and exposes list/model/message helpers from disk state', async () => {
    sdkStore.listedSessionIds.push('disk-session', 'empty-session', 'missing-session', 'corrupt-session');
    sdkStore.events.set('disk-session', [{ type: 'session.start', data: { context: { cwd: process.cwd() } } }, { type: 'message' }]);
    sdkStore.events.set('empty-session', []);
    sdkStore.eventsResult.set('missing-session', { ok: false, kind: 'missing', error: new Error('gone') });
    sdkStore.eventsResult.set('corrupt-session', { ok: false, kind: 'corrupt', error: new Error('bad json') });
    sdkStore.workspace.set('disk-session', { summary: 'Disk summary', updatedAt: '2026-01-02T03:04:05.000Z' });
    sdkStore.workspace.set('corrupt-session', { cwd: process.cwd(), summary: 'Recovered', updatedAt: '2026-01-03T03:04:05.000Z' });
    storage.meta.set('disk-session', { name: 'Disk', model: 'github-model', context: { files: ['a', 'b', 'c', 'd'] }, lastUsedAt: '2026-01-02T03:05:05.000Z' });

    const manager = await initializedManager();

    expect(manager.knownSessionIds().sort()).toEqual(['corrupt-session', 'disk-session']);
    expect(manager.getSessionCwd('disk-session')).toBe(process.cwd());
    expect(manager.listByCwd(process.cwd()).map(s => s.sessionId).sort()).toEqual(['corrupt-session', 'disk-session']);
    expect(manager.getMostRecentForCwd(process.cwd())).toBe('corrupt-session');
    expect(manager.hasMessages('disk-session')).toBe(true);
    expect(manager.hasMessages('empty-session')).toBe(false);
    expect(manager.hasMessages('corrupt-session')).toBe(true);
    expect(manager.modelTokenLimits('github-model')).toEqual({ maxPromptTokens: 256_000, maxContextWindowTokens: 200_000 });
    expect(manager.contextTierFor('github-model')).toBe('long_context');
    manager.snapshotSessionOrder();
    expect(storage.setSessionOrder).toHaveBeenCalledWith(['corrupt-session', 'disk-session']);
  });

  it('creates a provider-backed session with SDK config, cache, and model metadata', async () => {
    const manager = await initializedManager();
    const tools = [{ name: 'tool' }];
    const toolFactory = vi.fn(() => tools);

    const sessionId = await manager.create(process.cwd(), { model: 'byok:wire', toolFactory });

    expect(sessionId).toBe('created-session');
    expect(toolFactory).toHaveBeenCalledWith(process.cwd(), { id: 'created-session' });
    expect(sdk.fakeClient.createSession).toHaveBeenCalledWith(expect.objectContaining({
      model: 'wire',
      provider: { id: 'byok-provider' },
      workingDirectory: process.cwd(),
      tools,
      streaming: true,
      enableConfigDiscovery: true,
      contextTier: 'long_context',
    }));
    expect(storage.meta.get('created-session')?.model).toBe('byok:wire');
    expect(manager.isActive('created-session')).toBe(true);
    expect(manager.isClientRunning()).toBe(true);
    expect(manager.getSession('created-session')).toBe(fakeSessions.get('created-session'));
  });

  it('drives active session RPC, history, send, stream, compaction, MCP, and context APIs', async () => {
    const manager = await initializedManager();
    const sessionId = await manager.create(process.cwd(), { model: 'github-model', toolFactory: () => [] });
    const session = fakeSessions.get(sessionId)!;

    await expect(manager.listAgents(sessionId)).resolves.toEqual([{ name: 'reviewer' }]);
    await expect(manager.selectAgent(sessionId, 'reviewer')).resolves.toEqual({ name: 'reviewer' });
    await expect(manager.listCommands(sessionId)).resolves.toEqual([{ name: 'build' }]);
    await expect(manager.invokeCommand(sessionId, 'build', 'now')).resolves.toEqual({ name: 'build', input: 'now', output: 'ok' });
    await expect(manager.getHistory(sessionId)).resolves.toEqual([{ type: 'session.start' }, { type: 'message' }]);
    await expect(manager.send(sessionId, 'hello', { prompt: 'ignored', mode: 'force' })).resolves.toEqual({ text: 'answer' });
    await expect(manager.sendStream(sessionId, 'stream', { mode: 'force' })).resolves.toBe('queued');
    await expect(manager.compactSession(sessionId, ' keep facts ')).resolves.toEqual({ tokensRemoved: 10, messagesRemoved: 2 });
    // Manual compaction seam: resets the workflow "lean" compound base (spec-workflow-savings-model item 4).
    expect(throughput.recordCompaction).toHaveBeenCalledWith(sessionId);
    await expect(manager.listMcpServers(sessionId)).resolves.toEqual([{ name: 'github', status: 'connected', source: 'project' }]);
    await expect(manager.listMcpTools('github', sessionId)).resolves.toEqual([{ name: 'list_issues', description: 'List issues.' }]);
    await expect(manager.getCurrentToolMetadata(sessionId)).resolves.toEqual([{ name: 'github-list_issues', mcpServerName: 'github', mcpToolName: 'list_issues' }]);
    await expect(manager.getContextInfo()).resolves.toEqual({ sessionId, contextInfo: { promptTokens: 10, toolDefinitionsTokens: 3, mcpToolsTokens: 2 } });
    expect(manager.mostRecentActiveSessionId()).toBe(sessionId);
    expect(session.sendAndWait).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hello', mode: 'force' }), 120000);
    expect(session.send).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'stream', mode: 'force' }));
  });

  it('handles SDK creation errors by resetting the client and preserving the thrown error', async () => {
    const manager = await initializedManager();
    sdk.fakeClient.createSession.mockRejectedValueOnce(new Error('connection killed'));

    await expect(manager.create(process.cwd(), { model: 'github-model', toolFactory: () => [] })).rejects.toThrow('connection killed');

    expect(sdk.fakeClient.forceStop).toHaveBeenCalled();
    expect(manager.isClientRunning()).toBe(false);
  });

  it('resumes cached sessions with provider model, effort, budget, fallback cwd, and repair retry options', async () => {
    const manager = await initializedManager();
    const missingCwd = join(process.cwd(), 'does-not-exist-session-manager-coverage');
    sdkStore.listedSessionIds.push('resume-session');
    sdkStore.events.set('resume-session', [{ type: 'session.start', data: { context: { cwd: missingCwd } } }, { type: 'message' }]);
    storage.meta.set('resume-session', { name: '', model: 'byok:wire', contextBudgetTokens: 64_000, reasoningEffort: 'high' });
    manager.refreshCache();

    const result = await manager.resume('resume-session', { toolFactory: () => ['resume-tool'], excludedTools: ['builtin:view'] });

    expect(result).toEqual({ sessionId: 'resume-session', usedFallbackCwd: process.cwd(), repairMessage: undefined });
    expect(sdk.fakeClient.resumeSession).toHaveBeenCalledWith('resume-session', expect.objectContaining({
      model: 'wire',
      provider: { id: 'byok-provider' },
      workingDirectory: process.cwd(),
      excludedTools: ['builtin:view'],
      reasoningEffort: 'high',
      infiniteSessions: { backgroundCompactionThreshold: 0.25 },
      contextTier: 'long_context',
    }));
    expect(storage.meta.get('resume-session')?.model).toBe('byok:wire');
  });

  // ── M4: never-messaged session resume (docs/spec-session-orchestration.md, Slice D) ──
  // A session created but never given a first turn has no events.jsonl (the SDK writes
  // events only on the first turn), so a cold resumeSession throws "Session not found".
  // _doResume detects the clean file-absent `missing` read and recreates the session
  // under its own id (createSession accepts an explicit sessionId) → opens as an empty chat.

  async function createThenEvict(manager: Awaited<ReturnType<typeof initializedManager>>, model = 'github-model') {
    sdk.fakeClient.createSession.mockImplementation(async (cfg: { sessionId?: string }) => makeSession(cfg.sessionId ?? 'created-session'));
    const sessionId = await manager.create(process.cwd(), { model, toolFactory: () => ['tool'] });
    await manager.stop(sessionId); // removes from activeSessions, keeps sessionCache (simulates LRU eviction)
    expect(manager.isActive(sessionId)).toBe(false);
    sdk.fakeClient.resumeSession.mockClear();
    sdk.fakeClient.createSession.mockClear();
    return sessionId;
  }

  it('recreates a never-messaged (missing events.jsonl) evicted session under its id instead of failing resume (M4)', async () => {
    const manager = await initializedManager();
    const sessionId = await createThenEvict(manager);
    sdkStore.eventsResult.set(sessionId, { ok: false, kind: 'missing', error: new Error('gone') });

    const result = await manager.resume(sessionId, { toolFactory: () => ['tool'] });

    expect(result).toEqual({ sessionId, usedFallbackCwd: undefined });
    expect(sdk.fakeClient.resumeSession).not.toHaveBeenCalled();
    expect(sdk.fakeClient.createSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId, model: 'github-model' }));
    expect(manager.isActive(sessionId)).toBe(true);
  });

  it('recreate is idempotent — re-evicting a still-never-messaged session recreates it again (M4)', async () => {
    const manager = await initializedManager();
    const sessionId = await createThenEvict(manager);
    sdkStore.eventsResult.set(sessionId, { ok: false, kind: 'missing', error: new Error('gone') });

    await manager.resume(sessionId, { toolFactory: () => ['tool'] });
    await manager.stop(sessionId);
    sdk.fakeClient.createSession.mockClear();
    // Still never messaged (no events written)
    await manager.resume(sessionId, { toolFactory: () => ['tool'] });

    expect(sdk.fakeClient.createSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId }));
    expect(manager.isActive(sessionId)).toBe(true);
  });

  it('recreating a never-messaged session over the active cap evicts to preserve MAX_ACTIVE_SESSIONS (M4 bound)', async () => {
    const manager = await initializedManager();
    let n = 0;
    sdk.fakeClient.createSession.mockImplementation(async (cfg: { sessionId?: string }) => makeSession(cfg.sessionId ?? `gen-${++n}`));
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await manager.create(process.cwd(), { model: 'github-model', toolFactory: () => ['tool'] }));
    const target = await manager.create(process.cwd(), { model: 'github-model', toolFactory: () => ['tool'] });
    await manager.stop(target);
    sdkStore.eventsResult.set(target, { ok: false, kind: 'missing', error: new Error('gone') });

    await manager.resume(target, { toolFactory: () => ['tool'] });

    expect(manager.isActive(target)).toBe(true);
    const activeCount = ids.filter(id => manager.isActive(id)).length + 1; // + target
    expect(activeCount).toBeLessThanOrEqual(5);
  });

  it('falls back to DEFAULT_MODEL when a never-messaged session has no model meta (M4)', async () => {
    const manager = await initializedManager();
    const sessionId = await createThenEvict(manager);
    storage.meta.set(sessionId, { name: '' }); // wipe model meta
    sdkStore.parsedModels.delete(sessionId);
    sdkStore.eventsResult.set(sessionId, { ok: false, kind: 'missing', error: new Error('gone') });

    await expect(manager.resume(sessionId, { toolFactory: () => ['tool'] })).resolves.toEqual({ sessionId, usedFallbackCwd: undefined });
    expect(sdk.fakeClient.createSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId }));
    expect(manager.isActive(sessionId)).toBe(true);
  });

  it('does NOT recreate a corrupt-events session — it stays on the resume/auto-repair path (M4)', async () => {
    const manager = await initializedManager();
    const sessionId = await createThenEvict(manager);
    sdkStore.eventsResult.set(sessionId, { ok: false, kind: 'corrupt', error: new Error('bad json') });

    await manager.resume(sessionId, { toolFactory: () => ['tool'] });

    expect(sdk.fakeClient.resumeSession).toHaveBeenCalledWith(sessionId, expect.anything());
    expect(sdk.fakeClient.createSession).not.toHaveBeenCalled();
  });

  it('does NOT recreate a present-but-empty (ok) events session — file-absent vs empty boundary (M4)', async () => {
    const manager = await initializedManager();
    const sessionId = await createThenEvict(manager);
    sdkStore.eventsResult.set(sessionId, { ok: true, value: [] });

    await manager.resume(sessionId, { toolFactory: () => ['tool'] });

    expect(sdk.fakeClient.resumeSession).toHaveBeenCalledWith(sessionId, expect.anything());
    expect(sdk.fakeClient.createSession).not.toHaveBeenCalled();
  });

  it('reconciles rotation and re-reads before deciding: a rotation-transient missing that reconciles to ok takes the resume path (M4)', async () => {
    const manager = await initializedManager();
    const sessionId = await createThenEvict(manager);
    // Events look missing, but reconcileRotation restores them (rotation mid-swap) — must NOT recreate.
    sdkStore.eventsResult.set(sessionId, { ok: false, kind: 'missing', error: new Error('mid-rotation') });
    rotation.reconcileRotation.mockImplementationOnce(() => {
      sdkStore.eventsResult.set(sessionId, { ok: true, value: [{ type: 'session.start' }] });
      return 'recovered';
    });

    await manager.resume(sessionId, { toolFactory: () => ['tool'] });

    expect(sdk.fakeClient.resumeSession).toHaveBeenCalledWith(sessionId, expect.anything());
    expect(sdk.fakeClient.createSession).not.toHaveBeenCalled();
  });

  it('an already-active never-messaged session short-circuits at the early return (no recreate) (M4)', async () => {
    const manager = await initializedManager();
    sdk.fakeClient.createSession.mockImplementation(async (cfg: { sessionId?: string }) => makeSession(cfg.sessionId ?? 'created-session'));
    const sessionId = await manager.create(process.cwd(), { model: 'github-model', toolFactory: () => ['tool'] });
    sdkStore.eventsResult.set(sessionId, { ok: false, kind: 'missing', error: new Error('gone') });
    sdk.fakeClient.createSession.mockClear();
    sdk.fakeClient.resumeSession.mockClear();

    const result = await manager.resume(sessionId, { toolFactory: () => ['tool'] });

    expect(result).toEqual({ sessionId, usedFallbackCwd: undefined });
    expect(sdk.fakeClient.createSession).not.toHaveBeenCalled();
    expect(sdk.fakeClient.resumeSession).not.toHaveBeenCalled();
  });

  // ── Per-session plugin directories (docs/spec-plugin-directories.md) ──

  it('passes create-time plugin directories to the SDK and omits the key when absent (M-plugins)', async () => {
    const manager = await initializedManager();

    await manager.create(process.cwd(), { model: 'github-model', toolFactory: () => [], pluginDirectories: ['/abs/p1', '/abs/p2'] });
    expect(sdk.fakeClient.createSession).toHaveBeenCalledWith(expect.objectContaining({ pluginDirectories: ['/abs/p1', '/abs/p2'] }));

    sdk.fakeClient.createSession.mockClear();
    await manager.create(process.cwd(), { model: 'github-model', toolFactory: () => [] });
    expect(sdk.fakeClient.createSession.mock.calls[0][0]).not.toHaveProperty('pluginDirectories');
  });

  it('re-supplies stored plugin directories on every resume, and omits them when unset (M-plugins)', async () => {
    const manager = await initializedManager();
    sdkStore.listedSessionIds.push('pd-session', 'plain-session');
    for (const id of ['pd-session', 'plain-session']) {
      sdkStore.events.set(id, [{ type: 'session.start', data: { context: { cwd: process.cwd() } } }, { type: 'message' }]);
    }
    storage.meta.set('pd-session', { name: '', model: 'github-model', pluginDirectories: ['/abs/p1'] });
    storage.meta.set('plain-session', { name: '', model: 'github-model' });
    manager.refreshCache();

    await manager.resume('pd-session', { toolFactory: () => [] });
    expect(sdk.fakeClient.resumeSession).toHaveBeenCalledWith('pd-session', expect.objectContaining({ pluginDirectories: ['/abs/p1'] }));

    await manager.resume('plain-session', { toolFactory: () => [] });
    const plainArgs = sdk.fakeClient.resumeSession.mock.calls.find(c => c[0] === 'plain-session')![1];
    expect(plainArgs).not.toHaveProperty('pluginDirectories');
  });

  it('setSessionPluginDirectories persists without a recreate when the session is inactive (M-plugins)', async () => {
    const manager = await initializedManager();
    storage.meta.set('cold-session', { name: '' });

    const r = await manager.setSessionPluginDirectories('cold-session', ['/abs/p1']);

    expect(r).toEqual({ changed: true, recreated: false });
    expect(storage.meta.get('cold-session')?.pluginDirectories).toEqual(['/abs/p1']);
    expect(sdk.fakeClient.resumeSession).not.toHaveBeenCalled();
  });

  it('setSessionPluginDirectories recreates an ACTIVE session with the new dirs (M-plugins)', async () => {
    const manager = await initializedManager();
    sdk.fakeClient.createSession.mockImplementation(async () => makeSession('live-session'));
    const sessionId = await manager.create(process.cwd(), { model: 'github-model', toolFactory: () => [] });
    sdkStore.events.set(sessionId, [{ type: 'session.start', data: { context: { cwd: process.cwd() } } }, { type: 'message' }]);
    sdk.fakeClient.resumeSession.mockClear();

    const r = await manager.setSessionPluginDirectories(sessionId, ['/abs/p1']);

    expect(r).toEqual({ changed: true, recreated: true });
    expect(storage.meta.get(sessionId)?.pluginDirectories).toEqual(['/abs/p1']);
    expect(sdk.fakeClient.resumeSession).toHaveBeenCalledWith(sessionId, expect.objectContaining({ pluginDirectories: ['/abs/p1'] }));
  });

  it('setSessionPluginDirectories is a no-op for unchanged input (M-plugins)', async () => {
    const manager = await initializedManager();
    storage.meta.set('same-session', { name: '', pluginDirectories: ['/abs/p1'] });

    const r = await manager.setSessionPluginDirectories('same-session', ['/abs/p1']);

    expect(r).toEqual({ changed: false, recreated: false });
    expect(sdk.fakeClient.resumeSession).not.toHaveBeenCalled();
  });

  it('setSessionPluginDirectories clears with an empty list (M-plugins)', async () => {
    const manager = await initializedManager();
    storage.meta.set('clear-session', { name: '', pluginDirectories: ['/abs/p1'] });

    const r = await manager.setSessionPluginDirectories('clear-session', []);

    expect(r).toEqual({ changed: true, recreated: false });
    expect(storage.meta.get('clear-session')?.pluginDirectories).toBeUndefined();
  });

  it('setSessionPluginDirectories restores the previous dirs when the recreate fails (M-plugins)', async () => {
    const manager = await initializedManager();
    sdk.fakeClient.createSession.mockImplementation(async () => makeSession('revert-session'));
    const sessionId = await manager.create(process.cwd(), { model: 'github-model', toolFactory: () => [] });
    sdkStore.events.set(sessionId, [{ type: 'session.start', data: { context: { cwd: process.cwd() } } }, { type: 'message' }]);
    storage.meta.set(sessionId, { name: '', model: 'github-model', pluginDirectories: ['/abs/old'] });
    // First resume (the apply) fails; the rollback resume succeeds.
    sdk.fakeClient.resumeSession.mockRejectedValueOnce(new Error('boom'));

    await expect(manager.setSessionPluginDirectories(sessionId, ['/abs/new'])).rejects.toThrow(/reverted/i);
    expect(storage.meta.get(sessionId)?.pluginDirectories).toEqual(['/abs/old']);
  });

  it('changes model, reasoning effort, and context budget through live SDK mutations or warm recreate', async () => {    const manager = await initializedManager();
    const sessionId = await manager.create(process.cwd(), { model: 'effort-model', toolFactory: () => [] });
    const session = fakeSessions.get(sessionId)!;

    await manager.setSessionModel(sessionId, 'github-model-2');
    expect(session.setModel).toHaveBeenCalledWith('github-model-2', { contextTier: 'long_context' });
    expect(storage.meta.get(sessionId)?.model).toBe('github-model-2');

    storage.meta.set(sessionId, { name: '', model: 'effort-model' });
    await manager.setSessionReasoningEffort(sessionId, 'high');
    expect(session.rpc.model.setReasoningEffort).toHaveBeenCalledWith({ reasoningEffort: 'high' });
    expect(storage.meta.get(sessionId)?.reasoningEffort).toBe('high');

    await manager.setSessionReasoningEffort(sessionId, null);
    expect(session.rpc.model.setReasoningEffort).toHaveBeenCalledWith({ reasoningEffort: 'low' });
    expect(storage.meta.get(sessionId)?.reasoningEffort).toBeUndefined();

    await manager.setSessionContextBudget(sessionId, 64_000);
    expect(session.disconnect).toHaveBeenCalled();
    expect(sdk.fakeClient.resumeSession).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      infiniteSessions: { backgroundCompactionThreshold: 0.25 },
    }));
  });

  it('cancels absent, active-idle, and stuck active dispatches with observable dispatch cleanup', async () => {
    const manager = await initializedManager();

    manager.startDispatch('ghost-session', 'corr-1');
    await expect(manager.cancelSession('ghost-session')).resolves.toEqual({ forced: true });
    expect(manager.isBusy('ghost-session')).toBe(false);

    const sessionId = await manager.create(process.cwd(), { model: 'github-model', toolFactory: () => [] });
    const session = fakeSessions.get(sessionId)!;
    await expect(manager.cancelSession(sessionId)).resolves.toEqual({ forced: false });
    expect(session.abort).toHaveBeenCalled();

    manager.startDispatch(sessionId, 'corr-2');
    dispatch.waitForIdleResult = 'timeout';
    await expect(manager.cancelSession(sessionId)).resolves.toEqual({ forced: true });
    expect(dispatch.dispatchState.waitForIdle).toHaveBeenCalledWith(sessionId, 5000);
    expect(manager.getDispatchCorrelationId(sessionId)).toBeUndefined();
  });

  it('captures the revealing dispatch depth so an auto-continuation is not a root (spec-herd-depth-breadth)', async () => {
    const manager = await initializedManager();

    // A session dispatching at depth 3 reveals a tool: addPendingTools captures the
    // live depth so the continuation preserves it (not reset to root 1).
    manager.startDispatch('deep-session', 'corr-1', 3);
    expect(manager.getDispatchDepth('deep-session')).toBe(3);
    manager.addPendingTools('deep-session', ['some_tool']);
    expect(manager.getRevealDepth('deep-session')).toBe(3);

    // The captured depth survives the dispatch ending (idle) — the continuation
    // fires after idle and still carries depth 3.
    manager.endDispatch('deep-session');
    expect(manager.getDispatchDepth('deep-session')).toBeUndefined();
    expect(manager.getRevealDepth('deep-session')).toBe(3);

    // A fresh non-autocontinue dispatch re-arms: resetAutoContinue clears the capture.
    manager.resetAutoContinue('deep-session');
    expect(manager.getRevealDepth('deep-session')).toBe(1);
  });

  it('stops, changes cwd, forks, deletes, and shuts down sessions through public lifecycle APIs', async () => {
    const manager = await initializedManager();
    const sessionId = await manager.create(process.cwd(), { model: 'github-model', toolFactory: () => [] });
    const session = fakeSessions.get(sessionId)!;
    const nextCwd = join(process.cwd(), 'coverage-next-cwd');

    await manager.changeCwd(sessionId, nextCwd);
    expect(session.disconnect).toHaveBeenCalled();
    expect(manager.getSessionCwd(sessionId)).toBe(nextCwd);
    expect(storage.meta.get(sessionId)?.cwd).toBe(nextCwd);
    expect(runtime.disposeSessionRuntime).toHaveBeenCalledWith(sessionId);

    const forked = await manager.forkSession(sessionId, 'event-1');
    expect(forked).toEqual({ sessionId: 'forked-session', cwd: nextCwd });
    expect(sdk.fakeClient.rpc.sessions.fork).toHaveBeenCalledWith({ sessionId, toEventId: 'event-1' });

    await manager.delete(sessionId);
    expect(sdk.fakeClient.deleteSession).toHaveBeenCalledWith(sessionId);
    expect(fileEdits.cancelCardPersist).toHaveBeenCalledWith(sessionId);
    expect(manager.getSessionCwd(sessionId)).toBeNull();

    await manager.shutdown();
    expect(sdk.fakeClient.stop).toHaveBeenCalled();
    expect(manager.isClientRunning()).toBe(false);
  });
});
