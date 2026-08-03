import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cacoKey, mcpKey } from '../../src/tool-key.js';

const sdk = vi.hoisted(() => {
  const fakeClient = {
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), forceStop: vi.fn(async () => {}),
    ping: vi.fn(async () => ({ message: 'ok', timestamp: new Date(0).toISOString() })),
    createSession: vi.fn(async () => ({ sessionId: 'created', disconnect: vi.fn(async () => {}) })),
    resumeSession: vi.fn(async () => ({ sessionId: 'resumed', disconnect: vi.fn(async () => {}) })),
    deleteSession: vi.fn(async () => {}), listModels: vi.fn(async () => []),
    rpc: {
      account: { getQuota: vi.fn(async () => ({ quotaSnapshots: {} })) },
      models: { list: vi.fn(async () => ({ models: [] })) },
      tools: { list: vi.fn(async () => ({ tools: [] })) },
      sessions: { fork: vi.fn(async () => ({ sessionId: 'forked' })) },
    },
  };
  return { fakeClient, CopilotClient: vi.fn(function () { return fakeClient; }), approveAll: vi.fn() };
});
const storage = vi.hoisted(() => ({
  ensureSessionMeta: vi.fn(), getSessionMeta: vi.fn(() => undefined), readSessionMeta: vi.fn(() => undefined),
  setSessionMeta: vi.fn(), updateSessionMeta: vi.fn(() => true), getSessionIconPath: vi.fn(() => null), setSessionOrder: vi.fn(),
}));
const sizeStore = vi.hoisted(() => ({ sizes: new Map<string, number>() }));

vi.mock('@github/copilot-sdk', () => sdk);
vi.mock('../../src/storage.js', () => storage);
vi.mock('../../src/session-runtime.js', () => ({ disposeSessionRuntime: vi.fn() }));
vi.mock('../../src/event-bus.js', () => ({ broadcastEvent: vi.fn(), broadcastGlobalEvent: vi.fn() }));
vi.mock('../../src/sdk-session-store.js', () => ({
  readSessionWorkspace: vi.fn(() => null), readSessionEvents: vi.fn(() => []),
  readSessionEventsResult: vi.fn(() => ({ events: [] })), parseSessionModel: vi.fn(() => null),
  readSessionHeadResult: vi.fn(() => ({ ok: true, value: { start: null, hasMore: false } })),
  listSessionIds: vi.fn(() => []), STATE_DIR: '/tmp/nonexistent-state',
}));
vi.mock('../../src/mcp-config-loader.js', () => ({ loadMcpServers: vi.fn(async () => ({})) }));
vi.mock('../../src/provider-registry.js', () => ({
  hasProviders: vi.fn(() => false), listByokModels: vi.fn(() => []), resolveModel: vi.fn((m: string) => ({ sdkModel: m, cacoId: m })),
}));
vi.mock('../../src/quota-poller.js', () => ({ pollQuota: vi.fn() }));
vi.mock('../../src/memory-tool.js', () => ({ formatMemoryForPrompt: vi.fn(() => '') }));
vi.mock('../../src/tool-key-registry.js', () => ({
  lookupMcpKey: vi.fn(), learnFromMetadata: vi.fn(), keysForServer: vi.fn(() => []), allLearnedKeys: vi.fn(() => []),
}));
vi.mock('../../src/manual-defer-store.js', () => ({
  getDeferredServers: vi.fn(() => []), setServerDeferred: vi.fn(), isServerDeferred: vi.fn(() => false),
}));
vi.mock('../../src/tool-size-store.js', () => ({
  recordObservedSizes: vi.fn(),
  getToolSize: (k: string) => sizeStore.sizes.get(k),
}));
// Only the shell family is policy-excluded here.
vi.mock('../../src/tool-registry.js', () => ({
  excludedBuiltinNames: () => ['builtin:bash', 'builtin:powershell'],
  DEFER_ELIGIBLE_CACO_TOOLS: ['caco_browser_navigate'],
}));

interface FakeActive {
  cwd: string; session: unknown; toolFactory: () => unknown[]; excludedTools?: string[]; lastUsedAt: number;
}
const SID = 'sess-dd';
const MCP_KNOWN = mcpKey('github-list_issues');
const MCP_UNKNOWN = mcpKey('github-get_pr');
const CACO_TOOL = cacoKey('caco_browser_navigate');

async function makeManager(excluded: string[]) {
  const { SessionManager } = await import('../../src/session-manager.js');
  const manager = new SessionManager();
  (manager as { getCacoToolCatalog: () => unknown[] }).getCacoToolCatalog = () => [
    { name: 'caco_browser_navigate', description: 'nav', hardDisabled: false, parameters: { properties: { url: { type: 'string' } } } },
  ];
  const active = (manager as unknown as { activeSessions: Map<string, FakeActive> }).activeSessions;
  active.set(SID, { cwd: '/x', session: {}, toolFactory: () => [], excludedTools: [...excluded], lastUsedAt: Date.now() });
  return manager as unknown as { deferredDefsSavings: (id: string) => { deferredDefsTokens: number; deferredDefsCount: number; deferredDefsUnknown: number } };
}

beforeEach(() => { vi.clearAllMocks(); sizeStore.sizes.clear(); });

describe('SessionManager.deferredDefsSavings — gross omitted-definition figure (S6)', () => {
  it('sums known MCP sizes + local Caco size; counts unknown MCP; excludes policy builtins', async () => {
    sizeStore.sizes.set(MCP_KNOWN as string, 250);
    // excludedTools: a policy builtin (bash), a known MCP tool, an unknown MCP tool, a Caco-allowlist tool
    const mgr = await makeManager(['builtin:bash', MCP_KNOWN as string, MCP_UNKNOWN as string, CACO_TOOL as string]);
    const r = mgr.deferredDefsSavings(SID);
    // dynamic set = the 3 non-policy keys; bash excluded from count
    expect(r.deferredDefsCount).toBe(3);
    // known tokens = MCP 250 + local Caco estimate (>0); unknown MCP contributes 0
    const cacoEst = Math.round(JSON.stringify({ name: 'caco_browser_navigate', description: 'nav', parameters: { properties: { url: { type: 'string' } } } }).length / 4);
    expect(r.deferredDefsTokens).toBe(250 + cacoEst);
    expect(r.deferredDefsUnknown).toBe(1); // github-get_pr never observed
  });

  it('returns zeros when nothing is dynamically deferred (only policy builtins excluded)', async () => {
    const mgr = await makeManager(['builtin:bash', 'builtin:powershell']);
    expect(mgr.deferredDefsSavings(SID)).toEqual({ deferredDefsTokens: 0, deferredDefsCount: 0, deferredDefsUnknown: 0 });
  });

  it('a policy builtin never contributes even if somehow also in the set', async () => {
    const mgr = await makeManager(['builtin:powershell']);
    const r = mgr.deferredDefsSavings(SID);
    expect(r.deferredDefsCount).toBe(0);
    expect(r.deferredDefsTokens).toBe(0);
  });
});
