import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolKey } from '../../src/tool-key.js';

/**
 * spec-enable-tools-catalog-divergence.
 *
 * The deferred-tools reminder advertises the session's `excludedTools`, seeded from the
 * SYSTEM-WIDE learned-key registry and auto-defer latch, while `caco_enable_tools`
 * resolves against the session-scoped MCP catalog. A key for a server not loaded in this
 * session ("phantom") was advertised but unresolvable — and the failure message told the
 * agent to re-list, from a listing built off the same catalog, so it looped.
 *
 * The harness models exactly that: a session whose exclusion set holds a phantom key
 * (`ado-get_file`) whose server is absent from the stubbed catalog, alongside a real
 * deferred key (`github-list_issues`) whose server IS loaded.
 */

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
// The `ado` server is NOT in the catalog stub below, so `ado-get_file` is a key learned in
// some OTHER session/repo — exactly the cross-repo case that produces a phantom.
vi.mock('../../src/tool-key-registry.js', () => ({
  lookupMcpKey: vi.fn((server: string, raw: string) =>
    server === 'github' && raw === 'list_issues' ? 'github-list_issues' : undefined),
  learnMcpKey: vi.fn(),
  learnFromMetadata: vi.fn(),
  keysForServer: vi.fn(() => []),
  allLearnedKeys: vi.fn(() => []),
}));

const SID = 'sess-div';
const PHANTOM = 'ado-get_file';
const REAL = 'github-list_issues';

interface Stubs {
  mcpServersThrows?: boolean;
  mcpToolsThrows?: boolean;
}

function stubCatalog(manager: unknown, stubs: Stubs = {}): void {
  (manager as { getCacoToolCatalog: () => unknown[] }).getCacoToolCatalog = () => [];
  (manager as { listMcpServers: (s?: string, f?: () => void) => Promise<unknown[]> }).listMcpServers =
    async (_s, onFailure) => {
      if (stubs.mcpServersThrows) { onFailure?.(); return []; }
      return [{ name: 'github', status: 'connected' }];
    };
  (manager as { listMcpTools: (n: string, s?: string, f?: () => void) => Promise<unknown[]> }).listMcpTools =
    async (_n, _s, onFailure) => {
      if (stubs.mcpToolsThrows) { onFailure?.(); return []; }
      return [{ name: 'list_issues', description: 'List issues.' }];
    };
  (manager as { listBuiltinTools: () => Promise<unknown[]> }).listBuiltinTools =
    async () => [{ name: 'view', description: 'Read.' }];
  (manager as { getCurrentToolMetadata: () => Promise<unknown[]> }).getCurrentToolMetadata = async () => [];
}

async function makeManager(excluded: string[], stubs: Stubs = {}) {
  const { SessionManager } = await import('../../src/session-manager.js');
  const manager = new SessionManager();
  stubCatalog(manager, stubs);
  const update = vi.fn(async () => ({ success: true }));
  (manager as unknown as { activeSessions: Map<string, unknown> }).activeSessions.set(SID, {
    cwd: '/x',
    session: { rpc: { options: { update } } },
    toolFactory: () => [],
    excludedTools: [...excluded],
    lastUsedAt: Date.now(),
  });
  return { manager, update };
}

function reminderKeys(text: string | null): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  return lines[2].split(', ').filter(Boolean);
}

describe('deferred-tools reminder ⊆ enable-able catalog (spec-enable-tools-catalog-divergence)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    storage.meta.clear();
    const { clearDeferredReminder } = await import('../../src/deferred-reminder-store.js');
    clearDeferredReminder(SID);
  });

  it('reproduces the divergence: a phantom key is unresolvable by enableTools', async () => {
    // Row 0. Without the catalog stub omitting `ado`, this reproduces nothing — the point
    // of the harness is that the phantom IS advertised and IS rejected.
    const { manager } = await makeManager([PHANTOM, REAL]);
    const { catalog } = await manager.getToolCatalog(SID);
    expect(catalog.has(PHANTOM as unknown as ToolKey)).toBe(false);
    expect(catalog.has(REAL as unknown as ToolKey)).toBe(true);
  });

  it('does not advertise a key whose MCP server is not loaded in this session', async () => {
    const { manager } = await makeManager([PHANTOM, REAL]);
    await manager.getToolCatalog(SID); // warms the enable-able cache
    const keys = reminderKeys(manager.nextDeferredToolsReminder(SID).text);
    expect(keys).not.toContain(PHANTOM);
  });

  it('INVARIANT: every advertised key resolves against the session catalog', async () => {
    const { manager } = await makeManager([PHANTOM, REAL]);
    const { catalog } = await manager.getToolCatalog(SID);
    const { resolveEnableTargets } = await import('../../src/session-tool-state.js');
    const keys = reminderKeys(manager.nextDeferredToolsReminder(SID).text);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(resolveEnableTargets([key], catalog).ok, `advertised but unresolvable: ${key}`).toBe(true);
    }
  });

  it('keeps advertising a DEFERRED tool of a loaded server (the filter must not over-hide)', async () => {
    // Guards the assumption the cache rests on: listMcpTools enumerates server-side and so
    // still lists a tool that is currently excluded. If that ever ceased to hold, the
    // filter would silently strip legitimately re-enableable tools and this goes red.
    const { manager } = await makeManager([PHANTOM, REAL]);
    await manager.getToolCatalog(SID);
    expect(reminderKeys(manager.nextDeferredToolsReminder(SID).text)).toContain(REAL);
  });

  it('advertises everything when the enable-able set is not known yet (cold cache)', async () => {
    const { manager } = await makeManager([PHANTOM, REAL]);
    // No getToolCatalog call → no cache entry → unfiltered, the pre-existing behaviour.
    expect(reminderKeys(manager.nextDeferredToolsReminder(SID).text)).toEqual([PHANTOM, REAL]);
  });

  it('does NOT cache an MCP enumeration that failed (never converts over-advertise into over-hide)', async () => {
    const { manager } = await makeManager([PHANTOM, REAL], { mcpServersThrows: true });
    await manager.getToolCatalog(SID);
    // A failed enumeration yields an MCP-free catalog; caching it would hide REAL too.
    expect(reminderKeys(manager.nextDeferredToolsReminder(SID).text)).toContain(REAL);
  });

  it('does NOT cache a PARTIAL enumeration (servers listed, one server\'s tools failed)', async () => {
    const { manager } = await makeManager([PHANTOM, REAL], { mcpToolsThrows: true });
    await manager.getToolCatalog(SID);
    expect(reminderKeys(manager.nextDeferredToolsReminder(SID).text)).toContain(REAL);
  });

  it('a failed enumeration leaves a previously-good cache entry untouched', async () => {
    const { manager } = await makeManager([PHANTOM, REAL]);
    await manager.getToolCatalog(SID);
    stubCatalog(manager, { mcpServersThrows: true });
    await manager.getToolCatalog(SID);
    const keys = reminderKeys(manager.nextDeferredToolsReminder(SID).text);
    expect(keys).toContain(REAL);
    expect(keys).not.toContain(PHANTOM);
  });

  it('a catalog fetched WITHOUT a session id does not write any session cache', async () => {
    const { manager } = await makeManager([PHANTOM, REAL]);
    await manager.getToolCatalog();
    expect(reminderKeys(manager.nextDeferredToolsReminder(SID).text)).toEqual([PHANTOM, REAL]);
  });
});

describe('caco_enable_tools phantom vs unknown (spec-enable-tools-catalog-divergence R2)', () => {
  beforeEach(() => { vi.clearAllMocks(); storage.meta.clear(); });

  it('a phantom-only batch mutates nothing and is not fatal', async () => {
    const { manager, update } = await makeManager([PHANTOM, REAL]);
    const r = await manager.enableTools(SID, [PHANTOM]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.phantom).toEqual([PHANTOM]);
      expect(r.enabled).toEqual([]);
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('a mixed [valid, phantom] batch enables the valid one and reports the phantom', async () => {
    const { manager, update } = await makeManager([PHANTOM, REAL]);
    const r = await manager.enableTools(SID, [REAL, PHANTOM]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.enabled).toEqual([REAL]);
      expect(r.phantom).toEqual([PHANTOM]);
    }
    expect(update).toHaveBeenCalledWith({ excludedTools: [PHANTOM] });
  });

  it('[valid, typo] still rejects atomically with nothing mutated', async () => {
    const { manager, update } = await makeManager([PHANTOM, REAL]);
    const r = await manager.enableTools(SID, [REAL, 'nonesuch']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown tool: nonesuch/);
    expect(update).not.toHaveBeenCalled();
  });

  it('unknown DOMINATES phantom: [phantom, typo] rejects atomically', async () => {
    const { manager, update } = await makeManager([PHANTOM, REAL]);
    const r = await manager.enableTools(SID, [PHANTOM, 'nonesuch']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown tool: nonesuch/);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('enable-able cache warming (spec-enable-tools-catalog-divergence R1)', () => {
  const rejections: unknown[] = [];
  const onRejection = (e: unknown): void => { rejections.push(e); };

  beforeEach(() => { rejections.length = 0; process.on('unhandledRejection', onRejection); });
  afterEach(() => { process.off('unhandledRejection', onRejection); });

  it('a throwing catalog warm produces no unhandled rejection and leaves the cache absent', async () => {
    const { manager } = await makeManager([PHANTOM, REAL]);
    (manager as unknown as { getToolCatalog: () => Promise<unknown> }).getToolCatalog =
      async () => { throw new Error('mcp down'); };
    (manager as unknown as { warmEnableableKeys: (id: string) => void }).warmEnableableKeys(SID);
    await new Promise(r => setTimeout(r, 10));
    expect(rejections).toEqual([]);
    // Cache absent ⇒ unfiltered advertising, the safe direction.
    expect(reminderKeys(manager.nextDeferredToolsReminder(SID).text)).toEqual([PHANTOM, REAL]);
  });

  it('a successful warm filters subsequent reminders', async () => {
    const { manager } = await makeManager([PHANTOM, REAL]);
    (manager as unknown as { warmEnableableKeys: (id: string) => void }).warmEnableableKeys(SID);
    await new Promise(r => setTimeout(r, 10));
    expect(reminderKeys(manager.nextDeferredToolsReminder(SID).text)).toEqual([REAL]);
  });

  it('a warm that outlives its session does not resurrect the cache after teardown', async () => {
    // The warm awaits several RPCs. A teardown landing inside that window must win: an
    // unconditional seed would write a dead session's catalog back, and a session
    // re-created under the same caller-supplied id would silently inherit it.
    const { manager } = await makeManager([PHANTOM, REAL]);
    const sessions = (manager as unknown as { activeSessions: Map<string, unknown> }).activeSessions;
    let release: () => void = () => {};
    const held = new Promise<void>(r => { release = r; });
    (manager as unknown as { listMcpServers: () => Promise<unknown[]> }).listMcpServers =
      async () => { await held; return [{ name: 'github', status: 'connected' }]; };

    const torn = sessions.get(SID);
    (manager as unknown as { warmEnableableKeys: (id: string) => void }).warmEnableableKeys(SID);
    (manager as unknown as { clearEnableableKeys: (id: string) => void }).clearEnableableKeys(SID);
    sessions.delete(SID);
    release();
    await new Promise(r => setTimeout(r, 10));

    // A DIFFERENT session object under the same id — the reopen case.
    sessions.set(SID, { ...(torn as object), excludedTools: [PHANTOM, REAL] });
    expect(reminderKeys(manager.nextDeferredToolsReminder(SID).text)).toEqual([PHANTOM, REAL]);
  });
});
