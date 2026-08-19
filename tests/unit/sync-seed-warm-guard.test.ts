import { describe, it, expect } from 'vitest';
import { buildSyncSeed, shouldCommitWarmSet } from '../../src/session-tool-state.js';
import type { ToolKey } from '../../src/tool-key.js';

const K = (s: string) => s as ToolKey;

describe('buildSyncSeed — D3 synchronous superset seed', () => {
  it('unions all four origins', () => {
    const seed = buildSyncSeed({
      cacoEnableableKeys: [K('caco:register_mcp_server')],
      builtinEnableableKeys: [K('builtin:web_search')],
      learnedMcpKeys: [K('ADO-a'), K('ADO-b')],
      carriedExcluded: [K('builtin:read_agent')],
    });
    expect([...seed].sort()).toEqual(
      ['ADO-a', 'ADO-b', 'builtin:read_agent', 'builtin:web_search', 'caco:register_mcp_server'].sort(),
    );
  });

  it('dedupes across origins', () => {
    const seed = buildSyncSeed({
      cacoEnableableKeys: [K('x')],
      builtinEnableableKeys: [K('x')],
      learnedMcpKeys: [K('x')],
      carriedExcluded: [K('x')],
    });
    expect([...seed]).toEqual(['x']);
  });

  it('carries an excluded key of any origin (builtin cache may be empty)', () => {
    const seed = buildSyncSeed({
      cacoEnableableKeys: [],
      builtinEnableableKeys: [], // fire-and-forget cache still empty
      learnedMcpKeys: [],
      carriedExcluded: [K('builtin:some_deferred_builtin')],
    });
    expect(seed.has(K('builtin:some_deferred_builtin'))).toBe(true);
  });

  it('empty inputs ⇒ empty seed', () => {
    const seed = buildSyncSeed({ cacoEnableableKeys: [], builtinEnableableKeys: [], learnedMcpKeys: [], carriedExcluded: [] });
    expect(seed.size).toBe(0);
  });
});

describe('shouldCommitWarmSet — async warm lifecycle guard', () => {
  const s = {}; // an ActiveSession identity token

  it('commits on the happy path (named session, enumeration ok, same session)', () => {
    expect(shouldCommitWarmSet({ sessionId: 'sid', enumerationOk: true, activeAtEntry: s, activeNow: s })).toBe(true);
  });

  it('never commits for the no-arg (undefined sessionId) variant', () => {
    expect(shouldCommitWarmSet({ sessionId: undefined, enumerationOk: true, activeAtEntry: s, activeNow: s })).toBe(false);
  });

  it('never commits when the MCP enumeration failed (would write an MCP-free set)', () => {
    expect(shouldCommitWarmSet({ sessionId: 'sid', enumerationOk: false, activeAtEntry: s, activeNow: s })).toBe(false);
  });

  it('never commits when the session was torn down (activeNow undefined)', () => {
    expect(shouldCommitWarmSet({ sessionId: 'sid', enumerationOk: true, activeAtEntry: s, activeNow: undefined })).toBe(false);
  });

  it('never commits when a DIFFERENT session object now holds the id (recreated same-id)', () => {
    const recreated = {};
    expect(shouldCommitWarmSet({ sessionId: 'sid', enumerationOk: true, activeAtEntry: s, activeNow: recreated })).toBe(false);
  });

  it('never commits when no session was captured at entry', () => {
    expect(shouldCommitWarmSet({ sessionId: 'sid', enumerationOk: true, activeAtEntry: undefined, activeNow: s })).toBe(false);
  });
});
