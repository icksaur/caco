import { describe, it, expect, beforeEach, vi } from 'vitest';

// Isolate persistence: stub fs so the registry doesn't touch the real ~/.caco.
const store = vi.hoisted(() => ({ data: new Map<string, string>() }));
vi.mock('fs', () => ({
  readFileSync: vi.fn(() => { throw new Error('no file'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { learnMcpKey, lookupMcpKey, learnFromMetadata, keysForServer, _resetRegistryForTest } from '../../src/tool-key-registry.js';

beforeEach(() => { _resetRegistryForTest(); store.data.clear(); });

describe('tool-key-registry — discovered (server,raw) → model-facing key', () => {
  it('learns and looks up a model-facing key', () => {
    learnMcpKey('github-mcp-server', 'actions_get', 'github-mcp-server-actions_get');
    expect(lookupMcpKey('github-mcp-server', 'actions_get')).toBe('github-mcp-server-actions_get');
  });

  it('returns undefined for an unlearned (server,raw) — never fabricates', () => {
    expect(lookupMcpKey('unknown', 'nope')).toBeUndefined();
  });

  it('learns the irregular case (web_search: model name has no server prefix)', () => {
    learnMcpKey('github-mcp-server', 'web_search', 'web_search');
    // The lookup key is (server,raw); the VALUE is the irregular model-facing name.
    expect(lookupMcpKey('github-mcp-server', 'web_search')).toBe('web_search');
  });

  it('learnFromMetadata records every MCP tool (model name + raw identity)', () => {
    learnFromMetadata([
      { name: 'github-mcp-server-list_issues', mcpServerName: 'github-mcp-server', mcpToolName: 'list_issues' },
      { name: 'web_search', mcpServerName: 'github-mcp-server', mcpToolName: 'web_search' },
      { name: 'grep' }, // non-MCP: ignored (no server/raw)
    ]);
    expect(lookupMcpKey('github-mcp-server', 'list_issues')).toBe('github-mcp-server-list_issues');
    expect(lookupMcpKey('github-mcp-server', 'web_search')).toBe('web_search');
  });

  it('re-learning updates the mapping (idempotent, last wins)', () => {
    learnMcpKey('s', 't', 'old-name');
    learnMcpKey('s', 't', 'new-name');
    expect(lookupMcpKey('s', 't')).toBe('new-name');
  });

  it('keysForServer returns all learned keys for one server (for defer-whole-server)', () => {
    learnMcpKey('github-mcp-server', 'list_issues', 'github-mcp-server-list_issues');
    learnMcpKey('github-mcp-server', 'web_search', 'web_search');
    learnMcpKey('other-server', 'foo', 'other-server-foo');
    const keys = keysForServer('github-mcp-server').sort();
    expect(keys).toEqual(['github-mcp-server-list_issues', 'web_search'].sort());
    expect(keysForServer('nope')).toEqual([]);
  });
});
