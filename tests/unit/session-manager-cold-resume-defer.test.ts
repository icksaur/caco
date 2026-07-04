import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolKey } from '../../src/tool-key.js';

// Real tool-usage-store, but fs-mocked so the seam (stamp → cold-resume read) runs
// against real clock/age math without touching ~/.caco.
const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn((): string => { throw new Error('no file'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock('fs', () => fsMock);

// SessionManager construction deps (mirrors session-manager-enable-tools.test).
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

const storage = vi.hoisted(() => {
  const meta = new Map<string, Record<string, unknown>>();
  return {
    meta,
    ensureSessionMeta: vi.fn(), getSessionMeta: vi.fn((id: string) => meta.get(id)),
    readSessionMeta: vi.fn((id: string) => meta.get(id)),
    setSessionMeta: vi.fn(), updateSessionMeta: vi.fn(() => true),
    getSessionIconPath: vi.fn(() => null), setSessionOrder: vi.fn(),
  };
});

// Controlled leaf deps for the auto-defer decision.
const registry = vi.hoisted(() => ({ learned: [] as string[] }));
const usedHere = vi.hoisted(() => ({ set: new Set<string>() }));

vi.mock('@github/copilot-sdk', () => sdk);
vi.mock('../../src/storage.js', () => storage);
vi.mock('../../src/session-runtime.js', () => ({ disposeSessionRuntime: vi.fn() }));
vi.mock('../../src/event-bus.js', () => ({ broadcastEvent: vi.fn(), broadcastGlobalEvent: vi.fn() }));
vi.mock('../../src/sdk-session-store.js', () => ({
  readSessionWorkspace: vi.fn(() => null), readSessionEvents: vi.fn(() => []),
  readSessionEventsResult: vi.fn(() => ({ events: [] })), parseSessionModel: vi.fn(() => null),
  listSessionIds: vi.fn(() => []), STATE_DIR: '/tmp/nonexistent-state',
}));
vi.mock('../../src/mcp-config-loader.js', () => ({ loadMcpServers: vi.fn(async () => ({})) }));
vi.mock('../../src/provider-registry.js', () => ({
  hasProviders: vi.fn(() => false), listByokModels: vi.fn(() => []),
  resolveModel: vi.fn((m: string) => ({ sdkModel: m, cacoId: m })),
}));
vi.mock('../../src/quota-poller.js', () => ({ pollQuota: vi.fn() }));
vi.mock('../../src/memory-tool.js', () => ({ formatMemoryForPrompt: vi.fn(() => '') }));
vi.mock('../../src/tool-key-registry.js', () => ({
  lookupMcpKey: vi.fn(), learnFromMetadata: vi.fn(), keysForServer: vi.fn(() => []),
  allLearnedKeys: vi.fn(() => registry.learned),
}));
vi.mock('../../src/manual-defer-store.js', () => ({
  getDeferredServers: vi.fn(() => []), setServerDeferred: vi.fn(), isServerDeferred: vi.fn(() => false),
}));
// Real session-throughput would need many exports; mock just what C2 reads.
vi.mock('../../src/session-throughput.js', () => ({
  getToolsUsed: vi.fn(() => usedHere.set),
}));

import { stampToolUsage, _resetUsageStoreForTest, _setClockForTest, COLD_RESUME_STALE_MS } from '../../src/tool-usage-store.js';

const nowMs = 2_000_000_000_000; // fixed active-clock anchor

function metaLastUsedAgoMs(agoMs: number): string {
  // isColdResume uses the real wall clock (Date.now) for the cache-TTL gate — distinct
  // from the store's active-seconds clock (nowMs). So anchor meta.lastUsedAt to Date.now.
  return new Date(Date.now() - agoMs).toISOString();
}

const MCP_A = 'github-mcp-server-list_issues' as ToolKey;
const MCP_B = 'github-mcp-server-get_pr' as ToolKey;

async function makeManager() {
  const { SessionManager } = await import('../../src/session-manager.js');
  return new SessionManager() as unknown as {
    computeColdResumeAutoDefer: (sessionId: string, config: { modelOverride?: string; warmRecreate?: boolean }) => ToolKey[];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.meta.clear();
  registry.learned = [];
  usedHere.set = new Set<string>();
  fsMock.readFileSync.mockImplementation(() => { throw new Error('no file'); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  _setClockForTest(() => nowMs);
  _resetUsageStoreForTest();
  _setClockForTest(() => nowMs);
});

const SID = 'sess-c2';
const COLD = COLD_RESUME_STALE_MS + 60_000;

describe('SessionManager cold-resume auto-defer (C2 seam)', () => {
  it('warm resume (recent lastUsedAt) auto-defers nothing', () => {
    registry.learned = [MCP_A, MCP_B];
    storage.meta.set(SID, { lastUsedAt: metaLastUsedAgoMs(60_000) }); // 1 min ago = warm
    return makeManager().then(mgr => {
      expect(mgr.computeColdResumeAutoDefer(SID, {})).toEqual([]);
    });
  });

  it('a model switch is never cold, even if lastUsedAt is stale', async () => {
    registry.learned = [MCP_A];
    storage.meta.set(SID, { lastUsedAt: metaLastUsedAgoMs(COLD) });
    const mgr = await makeManager();
    expect(mgr.computeColdResumeAutoDefer(SID, { modelOverride: 'gpt-5.5' })).toEqual([]);
  });

  it('a warm recreate (context-budget change) is never cold, even if lastUsedAt is stale', async () => {
    registry.learned = [MCP_A];
    storage.meta.set(SID, { lastUsedAt: metaLastUsedAgoMs(COLD) });
    const mgr = await makeManager();
    expect(mgr.computeColdResumeAutoDefer(SID, { warmRecreate: true })).toEqual([]);
  });

  it('absent lastUsedAt is treated as NOT cold (conservative)', async () => {
    registry.learned = [MCP_A];
    const mgr = await makeManager();
    expect(mgr.computeColdResumeAutoDefer(SID, {})).toEqual([]);
  });

  it('cold resume defers never-used eligible MCP tools (maximally stale)', async () => {
    registry.learned = [MCP_A, MCP_B];
    storage.meta.set(SID, { lastUsedAt: metaLastUsedAgoMs(COLD) });
    const mgr = await makeManager();
    const deferred = mgr.computeColdResumeAutoDefer(SID, {});
    expect(deferred).toContain(MCP_A);
    expect(deferred).toContain(MCP_B);
  });

  it('store half of the seam: a tool stamped in the usage store is fresh and KEPT on cold resume (dispatch→stamp key-equality is covered in dispatch-events.test.ts)', async () => {
    registry.learned = [MCP_A, MCP_B];
    storage.meta.set(SID, { lastUsedAt: metaLastUsedAgoMs(COLD) });
    stampToolUsage(MCP_A); // dispatch-events would call this; recently used → fresh
    const mgr = await makeManager();
    const deferred = mgr.computeColdResumeAutoDefer(SID, {});
    expect(deferred).not.toContain(MCP_A); // fresh → kept
    expect(deferred).toContain(MCP_B);     // never used → deferred
  });

  it('used-here protection keeps a tool this session invoked even if system-wide stale', async () => {
    registry.learned = [MCP_A, MCP_B];
    storage.meta.set(SID, { lastUsedAt: metaLastUsedAgoMs(COLD) });
    usedHere.set = new Set<string>([MCP_A]); // invoked in this session's history
    const mgr = await makeManager();
    const deferred = mgr.computeColdResumeAutoDefer(SID, {});
    expect(deferred).not.toContain(MCP_A);
    expect(deferred).toContain(MCP_B);
  });

  it('an MCP tool with no learned key is never a candidate (can only defer keyed tools)', async () => {
    registry.learned = []; // nothing learned
    storage.meta.set(SID, { lastUsedAt: metaLastUsedAgoMs(COLD) });
    const mgr = await makeManager();
    const deferred = mgr.computeColdResumeAutoDefer(SID, {});
    // Only the fixed Caco allowlist remains as candidates; no MCP keys present.
    expect(deferred).not.toContain(MCP_A);
  });
});
