import { describe, it, expect } from 'vitest';
import { buildToolCatalog } from '../../src/tool-catalog.js';
import { toolKey } from '../../src/tool-key.js';

describe('buildToolCatalog — the one "what tools exist" view, keyed by ToolKey', () => {
  it('includes all three origins, keyed canonically', () => {
    const cat = buildToolCatalog({
      caco: [{ name: 'caco_docs', description: 'docs', hardDisabled: false }],
      builtins: [{ name: 'view', description: 'read' }],
      mcp: [{ serverName: 'github', tools: [{ name: 'list_issues', description: 'issues' }] }],
    });
    expect(cat.get(toolKey({ origin: 'caco', name: 'caco_docs' }))?.origin).toBe('caco');
    expect(cat.get(toolKey({ origin: 'builtin', name: 'view' }))?.origin).toBe('builtin');
    expect(cat.get(toolKey({ origin: 'mcp', serverName: 'github', toolName: 'list_issues' }))?.origin).toBe('mcp');
    expect(cat.size).toBe(3);
  });

  it('carries hardDisabled + parameters for Caco tools', () => {
    const cat = buildToolCatalog({
      caco: [{ name: 'register_mcp_server', description: 'oauth', hardDisabled: true, parameters: { properties: {} } }],
      builtins: [], mcp: [],
    });
    const t = cat.get(toolKey({ origin: 'caco', name: 'register_mcp_server' }))!;
    expect(t.hardDisabled).toBe(true);
    expect(t.parameters).toEqual({ properties: {} });
  });

  it('dedupes a builtin that appears twice (listed + excluded) into one entry, first wins', () => {
    const cat = buildToolCatalog({
      caco: [],
      builtins: [
        { name: 'bash', description: 'Run a shell command', parameters: { cmd: { type: 'string' } } },
        { name: 'bash', description: '' },
      ],
      mcp: [],
    });
    const key = toolKey({ origin: 'builtin', name: 'bash' });
    expect([...cat.values()].filter(t => t.key === key)).toHaveLength(1);
    // first entry (the schema-bearing one) wins
    expect(cat.get(key)?.parameters).toEqual({ cmd: { type: 'string' } });
  });

  it('normalizes a builtin name given with the builtin: prefix', () => {
    const cat = buildToolCatalog({ caco: [], builtins: [{ name: 'builtin:powershell', description: '' }], mcp: [] });
    expect(cat.has(toolKey({ origin: 'builtin', name: 'powershell' }))).toBe(true);
    expect(cat.get(toolKey({ origin: 'builtin', name: 'powershell' }))?.name).toBe('powershell');
  });
});
