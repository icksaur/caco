import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => {
  const fakeClient = {
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), forceStop: vi.fn(async () => {}),
    ping: vi.fn(async () => ({ message: 'ok', timestamp: new Date(0).toISOString() })),
    createSession: vi.fn(), resumeSession: vi.fn(), deleteSession: vi.fn(async () => {}),
    listModels: vi.fn(async () => []),
    rpc: { account: { getQuota: vi.fn(async () => ({ quotaSnapshots: {} })) }, models: { list: vi.fn(async () => ({ models: [] })) }, tools: { list: vi.fn(async () => ({ tools: [] })) }, sessions: { fork: vi.fn() } },
  };
  return { fakeClient, CopilotClient: vi.fn(function CopilotClient() { return fakeClient; }), approveAll: vi.fn() };
});
// fs mocked so the real tool-key-registry's persistence is inert (no ~/.caco writes).
vi.mock('fs', () => ({ readFileSync: vi.fn(() => { throw new Error('none'); }), writeFileSync: vi.fn(), mkdirSync: vi.fn() }));
vi.mock('@github/copilot-sdk', () => sdk);
vi.mock('../../src/storage.js', () => ({
  ensureSessionMeta: vi.fn(), getSessionMeta: vi.fn(() => undefined), setSessionMeta: vi.fn(),
  updateSessionMeta: vi.fn(() => true), getSessionIconPath: vi.fn(() => null), setSessionOrder: vi.fn(),
}));
vi.mock('../../src/session-runtime.js', () => ({ disposeSessionRuntime: vi.fn() }));
vi.mock('../../src/event-bus.js', () => ({ broadcastEvent: vi.fn(), broadcastGlobalEvent: vi.fn() }));
vi.mock('../../src/sdk-session-store.js', () => ({ readSessionWorkspace: vi.fn(() => null), readSessionEvents: vi.fn(() => []), parseSessionModel: vi.fn(() => null), listSessionIds: vi.fn(() => []), STATE_DIR: '/tmp/none' }));
vi.mock('../../src/mcp-config-loader.js', () => ({ loadMcpServers: vi.fn(async () => ({})) }));
vi.mock('../../src/provider-registry.js', () => ({ hasProviders: vi.fn(() => false), listByokModels: vi.fn(() => []), resolveModel: vi.fn((m: string) => ({ sdkModel: m, cacoId: m })) }));
vi.mock('../../src/quota-poller.js', () => ({ pollQuota: vi.fn() }));
vi.mock('../../src/memory-tool.js', () => ({ formatMemoryForPrompt: vi.fn(() => '') }));

import { _resetRegistryForTest } from '../../src/tool-key-registry.js';

/** A fake active session whose getCurrentMetadata returns the given loaded MCP tools. */
function fakeSession(loadedMcp: Array<{ name: string; mcpServerName: string; mcpToolName: string }>) {
  return {
    rpc: {
      mcp: {
        list: vi.fn(async () => ({ servers: [{ name: 'github', status: 'connected' }] })),
        listTools: vi.fn(async () => ({ tools: [{ name: 'list_issues', description: 'List issues.' }] })),
      },
      tools: { getCurrentMetadata: vi.fn(async () => ({ tools: loadedMcp })) },
    },
  };
}

describe('getToolCatalog — learns keys from the TARGET session, not the most-recent one', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetRegistryForTest(); });

  it('includes an MCP tool loaded only in the target (older) session', async () => {
    const { SessionManager } = await import('../../src/session-manager.js');
    const manager = new SessionManager();
    (manager as unknown as { listBuiltinTools: () => Promise<unknown[]> }).listBuiltinTools = async () => [];
    (manager as unknown as { getCacoToolCatalog: () => unknown[] }).getCacoToolCatalog = () => [];
    const active = (manager as unknown as { activeSessions: Map<string, unknown> }).activeSessions;
    // Target session A (older) HAS the loaded MCP tool with its model-facing name.
    active.set('A', { cwd: '/x', session: fakeSession([{ name: 'github-list_issues', mcpServerName: 'github', mcpToolName: 'list_issues' }]), toolFactory: () => [], excludedTools: [], lastUsedAt: 1000 });
    // Session B (most-recent) has NO loaded tools — if the learn step read B, A's tool key
    // would be unlearned and the tool omitted.
    active.set('B', { cwd: '/y', session: fakeSession([]), toolFactory: () => [], excludedTools: [], lastUsedAt: 9999 });

    const { catalog } = await manager.getToolCatalog('A');
    const mcpTools = [...catalog.values()].filter(t => t.origin === 'mcp');
    expect(mcpTools).toHaveLength(1);
    expect(mcpTools[0].key).toBe('github-list_issues');
    expect(mcpTools[0].server).toBe('github');
  });
});
