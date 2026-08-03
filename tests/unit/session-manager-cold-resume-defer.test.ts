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
const registry = vi.hoisted(() => ({ learned: [] as string[], serverKeys: [] as string[] }));
const usedHere = vi.hoisted(() => ({ set: new Set<string>() }));

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
  hasProviders: vi.fn(() => false), listByokModels: vi.fn(() => []),
  resolveModel: vi.fn((m: string) => ({ sdkModel: m, cacoId: m })),
}));
vi.mock('../../src/quota-poller.js', () => ({ pollQuota: vi.fn() }));
vi.mock('../../src/memory-tool.js', () => ({ formatMemoryForPrompt: vi.fn(() => '') }));
vi.mock('../../src/tool-key-registry.js', () => ({
  lookupMcpKey: vi.fn(), learnFromMetadata: vi.fn(), keysForServer: vi.fn(() => registry.serverKeys),
  allLearnedKeys: vi.fn(() => registry.learned),
}));
vi.mock('../../src/manual-defer-store.js', () => ({
  getDeferredServers: vi.fn(() => []), setServerDeferred: vi.fn(), isServerDeferred: vi.fn(() => false),
}));
// Real session-throughput would need many exports; mock just what C2 reads.
vi.mock('../../src/session-throughput.js', () => ({
  getToolsUsed: vi.fn(() => usedHere.set),
  setDeferredDefsProvider: vi.fn(),
}));

import { stampToolUsage, _resetUsageStoreForTest, _setClockForTest, COLD_RESUME_STALE_MS } from '../../src/tool-usage-store.js';
import { getAutoDeferred, _resetAutoDeferForTest } from '../../src/auto-defer-store.js';

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
    computeNewSessionAutoDefer: () => ToolKey[];
    setServerDeferred: (server: string, deferred: boolean) => Promise<{ affectedSessions: number; failedSessions: string[]; keys: ToolKey[] }>;
    create: (cwd: string, config: { model: string; toolFactory: () => unknown[]; excludedTools?: string[] }) => Promise<string>;
    sharedClient: unknown;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.meta.clear();
  registry.learned = [];
  registry.serverKeys = [];
  usedHere.set = new Set<string>();
  fsMock.readFileSync.mockImplementation(() => { throw new Error('no file'); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  _setClockForTest(() => nowMs);
  _resetUsageStoreForTest();
  _resetAutoDeferForTest();
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

describe('SessionManager new-session auto-defer (C3 create seam)', () => {
  it('defers never-used eligible MCP tools with NO coldness gate (no lastUsedAt, no config)', async () => {
    registry.learned = [MCP_A, MCP_B];
    // Deliberately NO storage.meta entry — proves create has no isColdResume gate
    // (computeColdResumeAutoDefer returns [] without lastUsedAt; this must NOT).
    const mgr = await makeManager();
    const deferred = mgr.computeNewSessionAutoDefer();
    expect(deferred).toContain(MCP_A);
    expect(deferred).toContain(MCP_B);
  });

  it('keeps a fresh (recently stamped) tool and defers the never-used one', async () => {
    registry.learned = [MCP_A, MCP_B];
    stampToolUsage(MCP_A); // used somewhere just now → fresh system-wide
    const mgr = await makeManager();
    const deferred = mgr.computeNewSessionAutoDefer();
    expect(deferred).not.toContain(MCP_A); // cross-session freshness → kept
    expect(deferred).toContain(MCP_B);     // never used → deferred
  });

  it('an unlearned MCP key is never a candidate', async () => {
    registry.learned = []; // nothing learned
    const mgr = await makeManager();
    const deferred = mgr.computeNewSessionAutoDefer();
    expect(deferred).not.toContain(MCP_A);
  });

  it('create() seeds excludedTools with base ∪ manual-defer ∪ new-session auto-defer (seam)', async () => {
    // MCP_A used just now (fresh, kept), MCP_B never used (auto-deferred at create).
    registry.learned = [MCP_A, MCP_B];
    stampToolUsage(MCP_A);
    const mgr = await makeManager();
    mgr.sharedClient = sdk.fakeClient; // skip ensureClient's health-timer/quota path
    await mgr.create('/tmp/c3', { model: 'gpt-5.5', toolFactory: () => [], excludedTools: ['builtin:powershell'] });
    const seeded = (sdk.fakeClient.createSession.mock.calls.at(-1) as unknown as [{ excludedTools: string[] }])[0].excludedTools;
    expect(seeded).toContain('builtin:powershell'); // base seed preserved
    expect(seeded).toContain(MCP_B);                // never-used → auto-deferred at create
    expect(seeded).not.toContain(MCP_A);            // fresh → kept (proves the union is wired, not a no-op)
  });
});

describe('SessionManager auto-defer LATCH (spec-auto-defer-latch)', () => {
  it('SET grows the persisted latch with the newly-stale keys', async () => {
    registry.learned = [MCP_A, MCP_B];
    const mgr = await makeManager();
    mgr.computeNewSessionAutoDefer();
    const latch = new Set(getAutoDeferred());
    expect(latch.has(MCP_A)).toBe(true);
    expect(latch.has(MCP_B)).toBe(true);
  });

  it('is a LATCH not a live function: a key stays deferred after it becomes fresh', async () => {
    registry.learned = [MCP_A];
    const mgr = await makeManager();
    const first = mgr.computeNewSessionAutoDefer();
    expect(first).toContain(MCP_A); // never used → stale → latched + returned
    stampToolUsage(MCP_A);          // now fresh system-wide (a reveal-use elsewhere)
    const second = mgr.computeNewSessionAutoDefer();
    expect(second).toContain(MCP_A); // STILL returned — freshness does not un-latch
  });

  it('Caco-allowlist tools are NOT latched (no operator clear path) — they stay LIVE', async () => {
    registry.learned = [];
    const cacoKeyOf = (await import('../../src/tool-key.js')).cacoKey;
    const { DEFER_ELIGIBLE_CACO_TOOLS } = await import('../../src/tool-registry.js');
    const cacoName = DEFER_ELIGIBLE_CACO_TOOLS[0];
    const cacoK = cacoKeyOf(cacoName) as unknown as ToolKey;
    const mgr = await makeManager();
    const first = mgr.computeNewSessionAutoDefer();
    expect(first).toContain(cacoK);                  // never used → live-stale → deferred
    expect([...getAutoDeferred()]).not.toContain(cacoK); // but NOT persisted into the latch
    stampToolUsage(cacoK);                           // used somewhere → fresh
    const second = mgr.computeNewSessionAutoDefer();
    expect(second).not.toContain(cacoK);             // live recompute → freshness un-defers it
  });

  it('used-here filters the RETURN but the key is still latched system-wide', async () => {
    registry.learned = [MCP_A];
    usedHere.set = new Set<string>([MCP_A]);
    storage.meta.set(SID, { lastUsedAt: metaLastUsedAgoMs(COLD) });
    const mgr = await makeManager();
    const deferred = mgr.computeColdResumeAutoDefer(SID, {});
    expect(deferred).not.toContain(MCP_A);              // this session's seed is protected
    expect([...getAutoDeferred()]).toContain(MCP_A);    // but the system-wide latch holds it
  });

  it('manual un-defer clears the latch for the server keys and stamps recency so they do not re-latch', async () => {
    registry.learned = [MCP_A];
    registry.serverKeys = [MCP_A];
    const mgr = await makeManager();
    mgr.computeNewSessionAutoDefer();                    // latch MCP_A (never used → stale)
    expect([...getAutoDeferred()]).toContain(MCP_A);
    await mgr.setServerDeferred('github-mcp-server', false); // operator un-defer
    expect([...getAutoDeferred()]).not.toContain(MCP_A);     // CLEAR
    const after = mgr.computeNewSessionAutoDefer();
    expect(after).not.toContain(MCP_A);                 // recency stamp prevents immediate re-latch
  });

  it('a warm resume never touches the latch (warm never auto-mutated)', async () => {
    registry.learned = [MCP_A, MCP_B];
    storage.meta.set(SID, { lastUsedAt: metaLastUsedAgoMs(60_000) }); // warm
    const mgr = await makeManager();
    expect(mgr.computeColdResumeAutoDefer(SID, {})).toEqual([]);
    expect([...getAutoDeferred()]).toEqual([]); // no SET on a warm seam
  });
});
