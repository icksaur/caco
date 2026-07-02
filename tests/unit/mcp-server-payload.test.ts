import { describe, it, expect } from 'vitest';
import { buildMcpServerPayload, estimateToolTokens } from '../../src/routes/workspace-api.js';

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
      { github: [{ name: 'x', description: 'd' }] },
      {},
      [{ name: 'view', description: 'Read a file' }],
      ['bash'],
      [{ name: 'caco_run_workflow', description: 'run', hardDisabled: false }],
    );
    expect(out.map(s => s.name)).toEqual(['Built-in', 'Caco', 'github']);
  });

  it('Built-in: excluded builtin from tools.list is one deferred entry (deduped), not two', () => {
    const out = buildMcpServerPayload(
      [], {}, {},
      [{ name: 'bash', description: 'Run a shell command', parameters: { cmd: { type: 'string' } } }, { name: 'view', description: 'Read' }],
      ['bash', 'powershell'],
    );
    const bi = out[0].tools;
    // bash: listed AND excluded → single deferred entry keeping its schema
    const bashEntries = bi.filter(t => t.name === 'bash');
    expect(bashEntries).toHaveLength(1);
    expect(bashEntries[0]).toMatchObject({ state: 'deferred', observed: false });
    expect(bashEntries[0].parameters).toEqual({ cmd: { type: 'string' } });
    // view: enabled
    expect(bi.find(t => t.name === 'view')).toMatchObject({ state: 'enabled', observed: true });
    // powershell: excluded but NOT in tools.list → bare deferred entry
    const ps = bi.find(t => t.name === 'powershell');
    expect(ps).toMatchObject({ state: 'deferred', observed: false, description: '', tokenCost: null });
  });

  it('Caco: hardDisabled → off, else enabled; token cost from parameters', () => {
    const out = buildMcpServerPayload([], {}, {}, [], [], [
      { name: 'caco_docs', description: 'docs', hardDisabled: false, parameters: { properties: { section: { type: 'string' } } } },
      { name: 'register_mcp_server', description: 'oauth', hardDisabled: true },
    ]);
    const caco = out[1].tools;
    const docs = caco.find(t => t.name === 'caco_docs')!;
    expect(docs).toMatchObject({ state: 'enabled' });
    expect(docs.tokenCost!).toBeGreaterThan(0);
    expect(caco.find(t => t.name === 'register_mcp_server')).toMatchObject({ state: 'off', observed: false });
  });

  it('enriches an available MCP tool with observed schema when loaded (state enabled)', () => {
    const servers = [{ name: 'github', status: 'connected' }];
    const available = { github: [{ name: 'create_issue', description: 'Open an issue' }] };
    const observed = { 'github/create_issue': { parameters: { title: { type: 'string' } }, deferLoading: false } };
    const out = buildMcpServerPayload(servers, available, observed);
    const t = out[2].tools[0];
    expect(t).toMatchObject({ name: 'create_issue', namespacedName: 'github/create_issue', observed: true, state: 'enabled' });
    expect(t.parameters).toEqual({ title: { type: 'string' } });
    expect(t.tokenCost).not.toBeNull();
  });

  it('marks an available-but-unobserved MCP tool observed:false with null schema/cost', () => {
    const servers = [{ name: 'linear', status: 'connected' }];
    const available = { linear: [{ name: 'search', description: 'Search issues' }] };
    const out = buildMcpServerPayload(servers, available, {});
    const t = out[2].tools[0];
    expect(t).toMatchObject({ observed: false, parameters: null, tokenCost: null });
    expect(t.description).toBe('Search issues');
  });

  it('treats presence in observed set as observed even with no input_schema (schema/cost null, not deferred)', () => {
    const servers = [{ name: 'gh', status: 'connected' }];
    const available = { gh: [{ name: 'ping', description: 'noop' }] };
    const observed = { 'gh/ping': { deferLoading: false } };
    const out = buildMcpServerPayload(servers, available, observed);
    const tool = out[2].tools[0];
    expect(tool.observed).toBe(true);
    expect(tool.parameters).toBeNull();
    expect(tool.tokenCost).toBeNull();
  });

  it('carries deferLoading through from observed metadata', () => {
    const servers = [{ name: 's', status: 'connected' }];
    const available = { s: [{ name: 't', description: 'd' }] };
    const observed = { 's/t': { parameters: { a: { type: 'number' } }, deferLoading: true } };
    const out = buildMcpServerPayload(servers, available, observed);
    expect(out[2].tools[0].deferLoading).toBe(true);
  });
});
