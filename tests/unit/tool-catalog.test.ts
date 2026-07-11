import { describe, it, expect } from 'vitest';
import { buildToolCatalog } from '../../src/tool-catalog.js';
import { formatDeferredTools, classifyTool, deferredToolKeys, renderDeferredToolsReminder, resolveEnableTargets } from '../../src/session-tool-state.js';
import { builtinKey, cacoKey, mcpKey } from '../../src/tool-key.js';

describe('buildToolCatalog — the one "what tools exist" view, keyed by ToolKey', () => {
  it('includes all three origins, keyed canonically', () => {
    const cat = buildToolCatalog({
      caco: [{ name: 'caco_docs', description: 'docs', hardDisabled: false }],
      builtins: [{ name: 'view', description: 'read' }],
      mcp: [{ serverName: 'github', tools: [{ key: mcpKey('github-list_issues'), name: 'list_issues', description: 'issues', excludable: true }] }],
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

describe('buildToolCatalog — unlearned MCP tool visibility', () => {
  it('shows an MCP tool whose key is not yet learned (display key, excludable:false)', () => {
    const cat = buildToolCatalog({
      caco: [], builtins: [],
      mcp: [{ serverName: 'github', tools: [{ key: mcpKey('github/list_issues'), name: 'list_issues', description: 'issues', excludable: false }] }],
    });
    const t = [...cat.values()].find(x => x.origin === 'mcp')!;
    expect(t.name).toBe('list_issues');
    expect(t.excludable).toBe(false);
    expect(t.key).toBe('github/list_issues'); // display-only id, NOT sent to excludedTools
  });
});

describe('formatDeferredTools — deferred-only discovery text for caco_enable_tools', () => {
  // A catalog spanning all origins: a deferred Caco tool (caco_docs), an enabled
  // Caco tool, a policy-disabled builtin (bash), a hard-disabled Caco tool
  // (register_mcp_server), a deferred builtin (view excluded), and two deferred MCP.
  const cat = buildToolCatalog({
    caco: [
      { name: 'caco_docs', description: 'Project + tool docs.', hardDisabled: false },
      { name: 'caco_run_workflow', description: 'Run a workflow.', hardDisabled: false },
      { name: 'register_mcp_server', description: 'OAuth MCP registration.', hardDisabled: true },
    ],
    builtins: [
      { name: 'view', description: 'Read a file.\nSecond line ignored.' },
      { name: 'bash', description: 'Run a shell command.' },
    ],
    mcp: [
      { serverName: 'github', tools: [
        { key: mcpKey('github-list_issues'), name: 'list_issues', description: 'List issues.', excludable: true },
        { key: mcpKey('github-get_commit'), name: 'get_commit', description: 'Get a commit.', excludable: true },
      ] },
    ],
  });
  // Deferred: caco_docs, view, list_issues, get_commit. Enabled: caco_run_workflow.
  // Disabled: bash (policy) + register_mcp_server (hard) = 2.
  const excluded = new Set([cacoKey('caco_docs'), builtinKey('view'), mcpKey('github-list_issues'), mcpKey('github-get_commit'), builtinKey('bash')]);
  const policyDisabled = new Set([builtinKey('bash')]);
  const out = formatDeferredTools(cat, excluded, policyDisabled);

  it('matches an independent expected rendering (deferred only, grouped, ordered)', () => {
    const expected = [
      '# Deferred Tools',
      '',
      'These tools are excluded this session to save per-turn tokens. Re-enable the ones you need with `caco_enable_tools({ names: ["<name>"] })` (batch related tools in ONE call); they become callable on your NEXT turn.',
      '',
      '## Caco',
      '- `caco_docs` — Project + tool docs.',
      '',
      '## Built-in',
      '- `view` — Read a file.',
      '',
      '## MCP: github',
      '- `list_issues` — List issues.',
      '- `get_commit` — Get a commit.',
      '',
      '2 tool(s) are disabled by policy (e.g. the shell family) and cannot be enabled.',
    ].join('\n');
    expect(out).toBe(expected);
  });

  it('omits enabled tools and every disabled tool by name', () => {
    expect(out).not.toContain('caco_run_workflow'); // enabled → already visible
    expect(out).not.toContain('bash');               // policy-disabled → count only
    expect(out).not.toContain('register_mcp_server'); // hard-disabled → count only
  });

  it('uses only the first line of a multi-line description', () => {
    expect(out).not.toContain('Second line ignored.');
  });

  it('returns an explicit message when nothing is deferred', () => {
    const text = formatDeferredTools(cat, new Set(), policyDisabled);
    expect(text).toContain('No deferred tools');
    expect(text).toContain('2 tool(s) are disabled by policy');
  });

  it('omits the disabled footer when there are no policy/hard-disabled tools', () => {
    const clean = buildToolCatalog({
      caco: [{ name: 'caco_docs', description: 'docs', hardDisabled: false }], builtins: [], mcp: [],
    });
    const text = formatDeferredTools(clean, new Set([cacoKey('caco_docs')]));
    expect(text).toContain('- `caco_docs` — docs');
    expect(text).not.toContain('disabled by policy');
  });

  // One source of truth: the reminder's keys must be exactly the tools the no-args
  // list renders — same selection, catalog-free.
  it('deferredToolKeys selects exactly the keys formatDeferredTools lists', () => {
    const expectedKeys = [...cat.values()]
      .filter(t => classifyTool(t.key, { excluded, hardDisabled: t.hardDisabled, policyDisabled }) === 'deferred')
      .map(t => t.key);
    expect(deferredToolKeys(excluded, policyDisabled)).toEqual(expectedKeys);
  });

  it('deferredToolKeys drops policy exclusions and preserves order', () => {
    expect(deferredToolKeys(excluded, policyDisabled)).toEqual([
      cacoKey('caco_docs'), builtinKey('view'), mcpKey('github-list_issues'), mcpKey('github-get_commit'),
    ]);
  });
});

describe('renderDeferredToolsReminder — the change-triggered discovery push', () => {
  it('lists the identifiers with the enable instruction, names only (no schema/desc)', () => {
    const out = renderDeferredToolsReminder([cacoKey('caco_docs'), mcpKey('list_issues')]);
    expect(out).toBe(
      '<deferred_tools>\n' +
      'Available but deferred (definitions hidden to save tokens). Enable before use with caco_enable_tools({ names: [...] }); callable next turn.\n' +
      'caco_docs, list_issues\n' +
      '</deferred_tools>'
    );
  });

  it('emits identifiers that round-trip through resolveEnableTargets (no ambiguity)', () => {
    const cat = buildToolCatalog({
      caco: [{ name: 'caco_docs', description: 'd', hardDisabled: false }],
      builtins: [],
      mcp: [{ serverName: 'github', tools: [{ key: mcpKey('list_issues'), name: 'list_issues', description: 'i', excludable: true }] }],
    });
    const keys = deferredToolKeys(new Set([cacoKey('caco_docs'), mcpKey('list_issues')]), new Set());
    const resolved = resolveEnableTargets(keys.map(k => k as string), cat);
    expect(resolved.ok).toBe(true);
  });
});
