import { describe, it, expect } from 'vitest';
import { buildToolCatalog } from '../../src/tool-catalog.js';
import { formatToolCatalog } from '../../src/session-tool-state.js';
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

describe('formatToolCatalog — grouped, state-annotated discovery text', () => {
  const cat = buildToolCatalog({
    caco: [
      { name: 'caco_run_workflow', description: 'Run a workflow.', hardDisabled: false },
      { name: 'register_mcp_server', description: 'OAuth MCP registration.', hardDisabled: true },
    ],
    builtins: [
      { name: 'view', description: 'Read a file.' },
      { name: 'bash', description: 'Run a shell command.\nSecond line ignored.' },
    ],
    mcp: [
      { serverName: 'github', tools: [{ name: 'list_issues', description: 'List issues.' }] },
    ],
  });
  const excluded = new Set([toolKey({ origin: 'builtin', name: 'bash' })]);
  const out = formatToolCatalog(cat, excluded);

  it('groups by Caco / Built-in / MCP:server', () => {
    expect(out).toContain('## Caco');
    expect(out).toContain('## Built-in');
    expect(out).toContain('## MCP: github');
  });

  it('annotates each tool with its classifyTool state', () => {
    expect(out).toMatch(/caco_run_workflow.*\benabled\b/);
    expect(out).toMatch(/register_mcp_server.*\boff\b/);   // hardDisabled
    expect(out).toMatch(/\bbash\b.*\bdeferred\b/);          // excluded
    expect(out).toMatch(/\bview\b.*\benabled\b/);
    expect(out).toMatch(/list_issues.*\benabled\b/);
  });

  it('uses only the first line of a multi-line description', () => {
    expect(out).toContain('Run a shell command.');
    expect(out).not.toContain('Second line ignored.');
  });

  it('shows an excluded-only builtin (bare, absent from tools.list) as deferred', () => {
    // Mirrors getToolCatalog appending bare entries for excluded builtins that
    // tools.list omits (e.g. powershell on Linux). Must appear as [deferred], not vanish.
    const c = buildToolCatalog({
      caco: [], mcp: [],
      builtins: [{ name: 'view', description: 'Read.' }, { name: 'powershell', description: '' }],
    });
    const excl = new Set([toolKey({ origin: 'builtin', name: 'powershell' })]);
    const text = formatToolCatalog(c, excl);
    expect(text).toMatch(/powershell.*\bdeferred\b/);
  });

  it('mentions the enable path so a deferred tool is actionable', () => {
    expect(out).toContain('caco_enable_tools');
  });
});

