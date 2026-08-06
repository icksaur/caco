import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Candidate enumeration for Caco auto-defer (spec-defer-default-inversion row 2).
 *
 * The old code derived candidates from a hand-maintained constant, so the set was
 * whatever someone remembered to list. It now derives from the registered catalog,
 * which means the interesting cases are the FILTERS: extension origin, hard-disabled,
 * and the protected four. This pins them against an independently written expected
 * list rather than re-deriving the filter in the assertion.
 */

const registry = { learned: [] as string[], serverKeys: [] as string[] };
const usage = { last: new Map<string, number>(), now: 100_000 };
const latch = { keys: new Set<string>() };

vi.mock('../../src/auto-defer-store.js', () => ({
  // The real store reads this machine's persisted MCP latch, which would leak
  // dozens of unrelated keys into every assertion.
  getAutoDeferred: () => latch.keys,
  addAutoDeferred: (ks: string[]) => { for (const k of ks) latch.keys.add(k); },
  removeAutoDeferred: (ks: string[]) => { for (const k of ks) latch.keys.delete(k); },
}));

vi.mock('../../src/tool-key-registry.js', () => ({
  lookupMcpKey: vi.fn(), learnFromMetadata: vi.fn(),
  keysForServer: () => registry.serverKeys,
  allLearnedKeys: () => registry.learned,
}));
vi.mock('../../src/manual-defer-store.js', () => ({
  getDeferredServers: () => [], setServerDeferred: vi.fn(), isServerDeferred: () => false,
}));
vi.mock('../../src/tool-usage-store.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    getNowActiveSeconds: () => usage.now,
    getLastUsedActiveSeconds: () => usage.last,
    stampToolUsage: vi.fn(),
  };
});
vi.mock('../../src/quota-poller.js', () => ({ pollQuota: vi.fn() }));
vi.mock('../../src/memory-tool.js', () => ({ formatMemoryForPrompt: vi.fn(() => '') }));

interface CatalogEntry {
  name: string; description: string; hardDisabled: boolean;
  origin: 'builtin' | 'extension'; parameters?: Record<string, unknown>;
}

const entry = (name: string, over: Partial<CatalogEntry> = {}): CatalogEntry =>
  ({ name, description: 'd', hardDisabled: false, origin: 'builtin', ...over });

async function candidatesFor(catalog: CatalogEntry[]): Promise<string[]> {
  const { SessionManager } = await import('../../src/session-manager.js');
  const mgr = new SessionManager();
  (mgr as unknown as { getCacoToolCatalog: () => CatalogEntry[] }).getCacoToolCatalog = () => catalog;
  // Everything is maximally stale (never used), so the returned set IS the candidate
  // set — isolating enumeration from the staleness rule.
  return (mgr as unknown as { computeNewSessionAutoDefer: () => string[] })
    .computeNewSessionAutoDefer()
    .map(k => String(k).replace(/^caco:/, ''));
}

beforeEach(() => {
  registry.learned = [];
  registry.serverKeys = [];
  usage.last = new Map();
  latch.keys = new Set();
});

describe('Caco auto-defer candidate enumeration', () => {
  it('defers every built-in except the protected four', async () => {
    const catalog = [
      entry('caco_herd'), entry('caco_herd_state'), entry('create_caco_session'),
      entry('restart_server'), entry('get_session_state'), entry('caco_memory'),
      entry('index'), entry('caco_session_delegate'),
      entry('caco_enable_tools'), entry('caco_run_workflow'),
      entry('retrieve_output'), entry('caco_docs'),
    ];

    const got = await candidatesFor(catalog);

    expect(got.sort()).toEqual([
      'caco_herd', 'caco_herd_state', 'caco_memory', 'caco_session_delegate',
      'create_caco_session', 'get_session_state', 'index', 'restart_server',
    ].sort());
  });

  it('never defers an extension tool, whatever its name', async () => {
    // A fixed blocklist cannot protect a dynamic third-party tool set, so the
    // origin filter — not the name — has to be what keeps them out.
    const got = await candidatesFor([
      entry('my_plugin_tool', { origin: 'extension' }),
      entry('caco_herd'),
    ]);

    expect(got).toEqual(['caco_herd']);
  });

  it('never defers a hard-disabled tool, which already costs nothing', async () => {
    const got = await candidatesFor([
      entry('register_mcp_server', { hardDisabled: true }),
      entry('caco_session_store_sql', { hardDisabled: true }),
      entry('caco_herd'),
    ]);

    expect(got).toEqual(['caco_herd']);
  });

  it('purges a Caco tool an older build latched, instead of deferring it forever', async () => {
    // The latch is unioned into the seed WITHOUT re-checking eligibility, and its
    // only clear path is a per-MCP-server un-defer that a pseudo-server cannot
    // offer. A stale entry for a now-protected tool would therefore defer it with
    // no way back — the exact stranding the "MCP keys only" rule exists to prevent.
    latch.keys = new Set(['caco_docs']);

    const got = await candidatesFor([entry('caco_docs'), entry('caco_herd')]);

    expect(got).toEqual(['caco_herd']);
    expect([...latch.keys]).toEqual([]);
  });

  it('yields nothing when the catalog is unregistered, over-sending rather than over-hiding', async () => {
    expect(await candidatesFor([])).toEqual([]);
  });

  it('picks up a newly shipped built-in with no registry edit', async () => {
    // The whole point of the inversion: a tool added tomorrow is deferrable today.
    const got = await candidatesFor([entry('a_tool_shipped_tomorrow')]);

    expect(got).toEqual(['a_tool_shipped_tomorrow']);
  });
});
