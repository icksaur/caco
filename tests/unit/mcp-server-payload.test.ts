import { describe, it, expect, vi } from 'vitest';

// Control the observed-size cache so knownTokenCost for a schema-less deferred MCP
// tool is deterministic (else buildMcpServerPayload would read ~/.caco/tool-size.json).
const sizeMock = vi.hoisted(() => ({ sizes: new Map<string, number>() }));
vi.mock('../../src/tool-size-store.js', () => ({
  getToolSize: (k: string) => sizeMock.sizes.get(k),
  recordObservedSizes: vi.fn(),
}));

import { buildMcpServerPayload, estimateToolTokens, resolveServersTarget } from '../../src/routes/workspace-api.js';
import { mcpKey } from '../../src/tool-key.js';

describe('resolveServersTarget — viewed-session vs most-recent fallback', () => {
  it('honors an explicit sessionId when it names an active session', () => {
    expect(resolveServersTarget('viewed', id => id === 'viewed', 'recent')).toBe('viewed');
  });
  it('falls back to most-recent-active when the requested session is inactive', () => {
    expect(resolveServersTarget('cold', () => false, 'recent')).toBe('recent');
  });
  it('falls back to most-recent-active when no sessionId is requested', () => {
    expect(resolveServersTarget(undefined, () => true, 'recent')).toBe('recent');
  });
  it('returns undefined when neither a valid request nor a most-recent session exists', () => {
    expect(resolveServersTarget(undefined, () => false, null)).toBeUndefined();
    expect(resolveServersTarget('cold', () => false, null)).toBeUndefined();
  });
});


describe('estimateToolTokens — full serialized-JSON char count ÷ 4', () => {
  it('counts the whole JSON definition (keys AND values), matching the wire form', () => {
    const tool = { name: 'aaaa', description: 'bbbb', parameters: { properties: { id: { type: 'string' } } } };
    const expected = Math.round(JSON.stringify({ name: 'aaaa', description: 'bbbb', parameters: { properties: { id: { type: 'string' } } } }).length / 4);
    expect(estimateToolTokens(tool)).toBe(expected);
  });

  it('includes schema keys (the undercount bug fix): keys materially raise the count', () => {
    const withKeys = estimateToolTokens({ name: 'x', parameters: { properties: { a: { type: 'string' }, b: { type: 'number' } } } });
    // values-only would have counted just "string"+"number" (~12 chars → 3 tokens);
    // full JSON is far larger because of properties/a/b/type keys + punctuation.
    expect(withKeys).toBeGreaterThan(10);
  });

  it('omits absent fields from the definition', () => {
    expect(estimateToolTokens({ name: 'n' })).toBe(Math.round(JSON.stringify({ name: 'n' }).length / 4));
  });
});

describe('buildMcpServerPayload — groups, states, merge', () => {
  it('prepends Built-in then Caco, then MCP servers', () => {
    const out = buildMcpServerPayload(
      [{ name: 'github', status: 'connected' }],
      { github: [{ key: mcpKey('github-x'), name: 'x', description: 'd', excludable: true }] },
      {},
      [{ name: 'view', description: 'Read a file' }],
      ['bash'],
      [{ name: 'caco_run_workflow', description: 'run', hardDisabled: false, origin: 'builtin' }],
    );
    expect(out.map(s => s.name)).toEqual(['Built-in', 'Caco', 'github']);
  });

  it('marks an MCP tool in the session live exclusion set as state:deferred', () => {
    const excludedKey = mcpKey('github-list_issues');
    const out = buildMcpServerPayload(
      [{ name: 'github', status: 'connected' }],
      { github: [
        { key: excludedKey, name: 'list_issues', description: 'd', excludable: true },
        { key: mcpKey('github-get_pr'), name: 'get_pr', description: 'd', excludable: true },
      ] },
      {}, [], [], [], [],
      { nowActiveSeconds: 0, lastUsed: new Map() },
      [excludedKey], // session live exclusion set
    );
    const tools = Object.fromEntries(out[2].tools.map(t => [t.name, t]));
    expect(tools.list_issues.state).toBe('deferred'); // actually excluded
    expect(tools.get_pr.state).toBe('enabled');       // not excluded
  });

  it('a deferred MCP tool with no live schema carries its last-observed knownTokenCost', () => {
    const deferredKey = mcpKey('github-list_issues');
    sizeMock.sizes.set(deferredKey as string, 250); // learned in a prior session
    const out = buildMcpServerPayload(
      [{ name: 'github', status: 'connected' }],
      { github: [
        { key: deferredKey, name: 'list_issues', description: 'd', excludable: true },
        { key: mcpKey('github-get_pr'), name: 'get_pr', description: 'd', excludable: true }, // no cached size
      ] },
      {}, // no observed metadata → no live schema
      [], [], [], [],
      { nowActiveSeconds: 0, lastUsed: new Map() },
      [deferredKey],
    );
    const tools = Object.fromEntries(out[2].tools.map(t => [t.name, t]));
    // deferred + cached size ⇒ knownTokenCost surfaces (live tokenCost stays null)
    expect(tools.list_issues.tokenCost).toBeNull();
    expect(tools.list_issues.knownTokenCost).toBe(250);
    // deferred + no cached size ⇒ knownTokenCost null (never fabricated)
    expect(tools.get_pr.knownTokenCost).toBeNull();
    sizeMock.sizes.clear();
  });

  it('marks a manually-deferred MCP server deferred:true (only that server)', () => {
    const out = buildMcpServerPayload(
      [{ name: 'github', status: 'connected' }, { name: 'linear', status: 'connected' }],
      { github: [{ key: mcpKey('github-x'), name: 'x', description: 'd', excludable: true }], linear: [] },
      {}, [], [], [],
      ['github'], // deferredServers
    );
    const github = out.find(s => s.name === 'github')!;
    const linear = out.find(s => s.name === 'linear')!;
    expect(github.deferred).toBe(true);
    expect(linear.deferred).toBe(false);
  });

  it('Built-in: a policy-excluded builtin is one disabled entry (deduped), not two, and never deferred', () => {
    const out = buildMcpServerPayload(
      [], {}, {},
      [{ name: 'bash', description: 'Run a shell command', parameters: { cmd: { type: 'string' } } }, { name: 'view', description: 'Read' }],
      ['bash', 'powershell'],
    );
    const bi = out[0].tools;
    // bash: listed AND policy-excluded → single DISABLED entry (policy, not dynamic defer)
    const bashEntries = bi.filter(t => t.name === 'bash');
    expect(bashEntries).toHaveLength(1);
    expect(bashEntries[0]).toMatchObject({ state: 'disabled', observed: false });
    expect(bashEntries[0].parameters).toEqual({ cmd: { type: 'string' } });
    // view: enabled
    expect(bi.find(t => t.name === 'view')).toMatchObject({ state: 'enabled', observed: true });
    // powershell: policy-excluded but NOT in tools.list → bare disabled entry
    const ps = bi.find(t => t.name === 'powershell');
    expect(ps).toMatchObject({ state: 'disabled', observed: false, description: '', tokenCost: null });
  });

  it('Caco: hardDisabled → disabled, else enabled; token cost from parameters', () => {
    const out = buildMcpServerPayload([], {}, {}, [], [], [
      { name: 'caco_docs', description: 'docs', hardDisabled: false, origin: 'builtin', parameters: { properties: { section: { type: 'string' } } } },
      { name: 'register_mcp_server', description: 'oauth', hardDisabled: true, origin: 'builtin' },
    ]);
    const caco = out[1].tools;
    const docs = caco.find(t => t.name === 'caco_docs')!;
    expect(docs).toMatchObject({ state: 'enabled' });
    expect(docs.tokenCost!).toBeGreaterThan(0);
    expect(caco.find(t => t.name === 'register_mcp_server')).toMatchObject({ state: 'disabled', observed: false });
  });

  it('Built-in: the eligibility badge matches what enumeration would defer', () => {
    // The badge used to report "eligible" only for tools ALREADY excluded, so the
    // applet claimed nothing would ever defer.
    const out = buildMcpServerPayload([], {}, {}, [
      { name: 'task', description: 't' },
      { name: 'str_replace_editor', description: 'e' },
      { name: 'skill', description: 's' },
      { name: 'bash', description: 'b' },
    ], ['bash'], []);
    const verdict = (n: string) => out[0].tools.find(t => t.name === n)!.deferEligible;

    expect(verdict('task')).toBe(true);
    expect(verdict('str_replace_editor')).toBe(false);
    expect(verdict('skill')).toBe(false);
    expect(verdict('bash')).toBe(false);
  });

  it('Caco: the eligibility badge matches what enumeration would actually defer', () => {
    // The badge is the operator's only view of the rule, so re-deriving it from
    // name + hardDisabled here — which cannot see builtin-vs-extension — made it
    // disagree with behaviour for every tool.
    const out = buildMcpServerPayload([], {}, {}, [], [], [
      { name: 'caco_herd', description: 'h', hardDisabled: false, origin: 'builtin' },
      { name: 'caco_enable_tools', description: 'e', hardDisabled: false, origin: 'builtin' },
      { name: 'register_mcp_server', description: 'r', hardDisabled: true, origin: 'builtin' },
      { name: 'my_plugin_tool', description: 'p', hardDisabled: false, origin: 'extension' },
    ]);
    const verdict = (name: string) => out[1].tools.find(t => t.name === name)!.deferEligible;

    expect(verdict('caco_herd')).toBe(true);
    expect(verdict('caco_enable_tools')).toBe(false);
    expect(verdict('register_mcp_server')).toBe(false);
    expect(verdict('my_plugin_tool')).toBe(false);
  });

  it('enriches an available MCP tool with observed schema when loaded (state enabled)', () => {
    const servers = [{ name: 'github', status: 'connected' }];
    const available = { github: [{ key: mcpKey('github-create_issue'), name: 'create_issue', description: 'Open an issue', excludable: true }] };
    const observed = { 'github-create_issue': { parameters: { title: { type: 'string' } }, deferLoading: false } };
    const out = buildMcpServerPayload(servers, available, observed);
    const t = out[2].tools[0];
    expect(t).toMatchObject({ name: 'create_issue', namespacedName: 'github-create_issue', observed: true, state: 'enabled' });
    expect(t.parameters).toEqual({ title: { type: 'string' } });
    expect(t.tokenCost).not.toBeNull();
  });

  it('marks an available-but-unobserved MCP tool observed:false with null schema/cost', () => {
    const servers = [{ name: 'linear', status: 'connected' }];
    const available = { linear: [{ key: mcpKey('linear-search'), name: 'search', description: 'Search issues', excludable: true }] };
    const out = buildMcpServerPayload(servers, available, {});
    const t = out[2].tools[0];
    expect(t).toMatchObject({ observed: false, parameters: null, tokenCost: null });
    expect(t.description).toBe('Search issues');
  });

  it('treats presence in observed set as observed even with no input_schema (schema/cost null, not deferred)', () => {
    const servers = [{ name: 'gh', status: 'connected' }];
    const available = { gh: [{ key: mcpKey('gh-ping'), name: 'ping', description: 'noop', excludable: true }] };
    const observed = { 'gh-ping': { deferLoading: false } };
    const out = buildMcpServerPayload(servers, available, observed);
    const tool = out[2].tools[0];
    expect(tool.observed).toBe(true);
    expect(tool.parameters).toBeNull();
    expect(tool.tokenCost).toBeNull();
  });

  it('carries deferLoading through from observed metadata', () => {
    const servers = [{ name: 's', status: 'connected' }];
    const available = { s: [{ key: mcpKey('s-t'), name: 't', description: 'd', excludable: true }] };
    const observed = { 's-t': { parameters: { a: { type: 'number' } }, deferLoading: true } };
    const out = buildMcpServerPayload(servers, available, observed);
    expect(out[2].tools[0].deferLoading).toBe(true);
  });

  it('attaches usage age + cold-resume verdict per tool from the shared threshold', () => {
    const servers = [{ name: 'gh', status: 'connected' }];
    const fresh = mcpKey('gh-fresh');
    const stale = mcpKey('gh-stale');
    const available = {
      gh: [
        { key: fresh, name: 'fresh', description: 'd', excludable: true },
        { key: stale, name: 'stale', description: 'd', excludable: true },
        { key: 'gh/unlearned' as ReturnType<typeof mcpKey>, name: 'unlearned', description: 'd', excludable: false }, // no key ⇒ not eligible
      ],
    };
    const nowActiveSeconds = 3 * 60 * 60; // 3 active-hours
    const lastUsed = new Map([[fresh, nowActiveSeconds - 60], [stale, nowActiveSeconds - 3 * 60 * 60]]);
    const out = buildMcpServerPayload(servers, available, {}, [], [], [], [], { nowActiveSeconds, lastUsed });
    const tools = Object.fromEntries(out[2].tools.map(t => [t.name, t]));
    // fresh: used 60 active-seconds ago ⇒ eligible, not stale, kept
    expect(tools.fresh.deferEligible).toBe(true);
    expect(tools.fresh.stale).toBe(false);
    expect(tools.fresh.wouldDefer).toBe(false);
    // stale: unused 3 active-hours (> 2h threshold) ⇒ would defer
    expect(tools.stale.stale).toBe(true);
    expect(tools.stale.wouldDefer).toBe(true);
    // unlearned MCP tool (no exclusion key) is never eligible, so never would-defer
    expect(tools.unlearned.deferEligible).toBe(false);
    expect(tools.unlearned.wouldDefer).toBe(false);
    // never-used eligible tool is maximally stale ⇒ would defer (matches cold-resume math)
    const neverServers = [{ name: 'gh', status: 'connected' }];
    const neverAvail = { gh: [{ key: mcpKey('gh-never'), name: 'never', description: 'd', excludable: true }] };
    const neverOut = buildMcpServerPayload(neverServers, neverAvail, {}, [], [], [], [], { nowActiveSeconds, lastUsed: new Map() });
    const never = neverOut[2].tools[0];
    expect(never.ageActiveSeconds).toBeNull();
    expect(never.wouldDefer).toBe(true);
  });

  it('omits usage fields (age null, no verdict) when no usage snapshot is passed', () => {
    const servers = [{ name: 'gh', status: 'connected' }];
    const available = { gh: [{ key: mcpKey('gh-x'), name: 'x', description: 'd', excludable: true }] };
    const out = buildMcpServerPayload(servers, available, {});
    const t = out[2].tools[0];
    expect(t.ageActiveSeconds).toBeNull();
    expect(t.stale).toBe(false);
    expect(t.wouldDefer).toBe(false);
  });
});

describe('buildMcpServerPayload — auto-defer latch awareness (spec-auto-defer-latch)', () => {
  it('marks a server deferred when ANY of its keys is latched (partial latch shows the clear path)', () => {
    const a = mcpKey('gh-a'), b = mcpKey('gh-b');
    const servers = [{ name: 'gh', status: 'connected', source: 'mcp' }];
    const available = { gh: [
      { key: a, name: 'a', description: 'd', excludable: true },
      { key: b, name: 'b', description: 'd', excludable: true },
    ] };
    // Only ONE of the two keys is latched — server must still report deferred:true so the
    // operator's only CLEAR path (the re-enable button) is reachable.
    const out = buildMcpServerPayload(servers, available, {}, [], [], [], [], undefined, [], new Set([a]));
    expect(out[2].deferred).toBe(true);
  });

  it('does NOT mark an unkeyable (empty-key) server deferred — no vacuous truth', () => {
    const servers = [{ name: 'gh', status: 'connected', source: 'mcp' }];
    const available = { gh: [] as { key: ReturnType<typeof mcpKey>; name: string; description: string; excludable: boolean }[] };
    const out = buildMcpServerPayload(servers, available, {}, [], [], [], [], undefined, [], new Set([mcpKey('gh-a')]));
    expect(out[2].deferred).toBe(false);
  });

  it('reports wouldDefer:true for a latched-but-FRESH tool (badge never lies about the next seam)', () => {
    const fresh = mcpKey('gh-fresh');
    const servers = [{ name: 'gh', status: 'connected', source: 'mcp' }];
    const available = { gh: [{ key: fresh, name: 'fresh', description: 'd', excludable: true }] };
    const nowActiveSeconds = 3 * 60 * 60;
    const lastUsed = new Map([[fresh, nowActiveSeconds - 60]]); // used 60s ago ⇒ live-fresh
    const out = buildMcpServerPayload(servers, available, {}, [], [], [], [], { nowActiveSeconds, lastUsed }, [], new Set([fresh]));
    const t = out[2].tools[0];
    expect(t.stale).toBe(false);      // raw staleness stays honest
    expect(t.wouldDefer).toBe(true);  // but it IS latched ⇒ seeded deferred next seam
  });
});
