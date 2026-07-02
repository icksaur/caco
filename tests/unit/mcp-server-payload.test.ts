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

describe('buildMcpServerPayload — merge available + observed', () => {
  it('prepends Built-in (always observed, full schema + token cost)', () => {
    const out = buildMcpServerPayload([], {}, {}, [
      { name: 'view', description: 'Read a file', parameters: { path: { type: 'string' } }, instructions: 'use it' },
    ]);
    expect(out[0].name).toBe('Built-in');
    const t = out[0].tools[0];
    expect(t).toMatchObject({ name: 'view', observed: true, deferLoading: false });
    expect(t.tokenCost).toBe(estimateToolTokens({ name: 'view', description: 'Read a file', parameters: { path: { type: 'string' } }, instructions: 'use it' }));
  });

  it('enriches an available MCP tool with observed schema when loaded', () => {
    const servers = [{ name: 'github', status: 'connected' }];
    const available = { github: [{ name: 'create_issue', description: 'Open an issue' }] };
    const observed = { 'github/create_issue': { parameters: { title: { type: 'string' } }, deferLoading: false } };
    const out = buildMcpServerPayload(servers, available, observed);
    const t = out[1].tools[0];
    expect(t).toMatchObject({ name: 'create_issue', namespacedName: 'github/create_issue', observed: true });
    expect(t.parameters).toEqual({ title: { type: 'string' } });
    expect(t.tokenCost).not.toBeNull();
  });

  it('marks an available-but-unobserved tool observed:false with null schema/cost', () => {
    const servers = [{ name: 'linear', status: 'connected' }];
    const available = { linear: [{ name: 'search', description: 'Search issues' }] };
    const out = buildMcpServerPayload(servers, available, {});
    const t = out[1].tools[0];
    expect(t).toMatchObject({ observed: false, parameters: null, tokenCost: null });
    expect(t.description).toBe('Search issues');
  });

  it('treats presence in observed set as observed even with no input_schema (schema/cost null, not deferred)', () => {
    const servers = [{ name: 'gh', status: 'connected' }];
    const available = { gh: [{ name: 'ping', description: 'noop' }] };
    const observed = { 'gh/ping': { deferLoading: false } }; // present, but no parameters
    const out = buildMcpServerPayload(servers, available, observed);
    const tool = out[1].tools[0];
    expect(tool.observed).toBe(true);
    expect(tool.parameters).toBeNull();
    expect(tool.tokenCost).toBeNull();
  });

  it('carries deferLoading through from observed metadata', () => {
    const servers = [{ name: 's', status: 'connected' }];
    const available = { s: [{ name: 't', description: 'd' }] };
    const observed = { 's/t': { parameters: { a: { type: 'number' } }, deferLoading: true } };
    const out = buildMcpServerPayload(servers, available, observed);
    expect(out[1].tools[0].deferLoading).toBe(true);
  });
});
