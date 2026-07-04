import { describe, it, expect } from 'vitest';
import { buildToolCatalog } from '../../src/tool-catalog.js';
import { formatToolCatalog } from '../../src/session-tool-state.js';
import { builtinKey, cacoKey, mcpKey } from '../../src/tool-key.js';

describe('buildToolCatalog — the one "what tools exist" view, keyed by ToolKey', () => {
  it('includes all three origins, keyed canonically', () => {
    const cat = buildToolCatalog({
      caco: [{ name: 'caco_docs', description: 'docs', hardDisabled: false }],
      builtins: [{ name: 'view', description: 'read' }],
      mcp: [{ serverName: 'github', tools: [{ key: mcpKey('github-list_issues'), name: 'list_issues', description: 'issues' }] }],
    });
    expect(cat.get(cacoKey('caco_docs'))?.origin).toBe('caco');
    expect(cat.get(builtinKey('view'))?.origin).toBe('builtin');
    expect(cat.get(mcpKey('github-list_issues'))?.origin).toBe('mcp');
    expect(cat.get(mcpKey('github-list_issues'))?.server).toBe('github');
    expect(cat.size).toBe(3);
  });

  it('carries hardDisabled + parameters for Caco tools', () => {
    const cat = buildToolCatalog({
      caco: [{ name: 'register_mcp_server', description: 'oauth', hardDisabled: true, parameters: { properties: {} } }],
      builtins: [], mcp: [],
    });
    const t = cat.get(cacoKey('register_mcp_server'))!;
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
    const key = builtinKey('bash');
    expect([...cat.values()].filter(t => t.key === key)).toHaveLength(1);
    expect(cat.get(key)?.parameters).toEqual({ cmd: { type: 'string' } });
  });

  it('normalizes a builtin name given with the builtin: prefix', () => {
    const cat = buildToolCatalog({ caco: [], builtins: [{ name: 'builtin:powershell', description: '' }], mcp: [] });
    expect(cat.has(builtinKey('powershell'))).toBe(true);
    expect(cat.get(builtinKey('powershell'))?.name).toBe('powershell');
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
      { serverName: 'github', tools: [{ key: mcpKey('github-list_issues'), name: 'list_issues', description: 'List issues.' }] },
    ],
  });
  const excluded = new Set([builtinKey('bash')]);
  const out = formatToolCatalog(cat, excluded);

  it('groups by Caco / Built-in / MCP:server', () => {
    expect(out).toContain('## Caco');
    expect(out).toContain('## Built-in');
    expect(out).toContain('## MCP: github');
  });

  it('annotates each tool with its classifyTool state', () => {
    expect(out).toMatch(/caco_run_workflow.*\benabled\b/);
    expect(out).toMatch(/register_mcp_server.*\boff\b/);
    expect(out).toMatch(/\bbash\b.*\bdeferred\b/);
    expect(out).toMatch(/\bview\b.*\benabled\b/);
    expect(out).toMatch(/list_issues.*\benabled\b/);
  });

  it('uses only the first line of a multi-line description', () => {
    expect(out).toContain('Run a shell command.');
    expect(out).not.toContain('Second line ignored.');
  });

  it('shows an excluded-only builtin (bare, absent from tools.list) as deferred', () => {
    const c = buildToolCatalog({
      caco: [], mcp: [],
      builtins: [{ name: 'view', description: 'Read.' }, { name: 'powershell', description: '' }],
    });
    const excl = new Set([builtinKey('powershell')]);
    const text = formatToolCatalog(c, excl);
    expect(text).toMatch(/powershell.*\bdeferred\b/);
  });

  it('mentions the enable path so a deferred tool is actionable', () => {
    expect(out).toContain('caco_enable_tools');
  });
});
