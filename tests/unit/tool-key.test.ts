import { describe, it, expect } from 'vitest';
import { toolKey, toolKeyFromEvent } from '../../src/tool-key.js';

describe('toolKey — one canonical key per tool, origin-encoded', () => {
  it('MCP → server/tool (matches the SDK excludedTools namespacedName)', () => {
    expect(toolKey({ origin: 'mcp', serverName: 'github-mcp-server', toolName: 'list_issues' }))
      .toBe('github-mcp-server/list_issues');
  });

  it('builtin → builtin:name (matches DEFAULT_EXCLUDED_BUILTINS form)', () => {
    expect(toolKey({ origin: 'builtin', name: 'bash' })).toBe('builtin:bash');
  });

  it('builtin normalizes an already-prefixed name (idempotent, no double prefix)', () => {
    expect(toolKey({ origin: 'builtin', name: 'builtin:bash' })).toBe('builtin:bash');
  });

  it('caco → caco:name', () => {
    expect(toolKey({ origin: 'caco', name: 'caco_run_workflow' })).toBe('caco:caco_run_workflow');
  });

  it('throws on an mcp descriptor missing serverName/toolName (never fabricates a key)', () => {
    expect(() => toolKey({ origin: 'mcp', serverName: '', toolName: 'x' })).toThrow();
    expect(() => toolKey({ origin: 'mcp', serverName: 's', toolName: '' })).toThrow();
  });

  it('throws on a builtin/caco descriptor with an empty name', () => {
    expect(() => toolKey({ origin: 'builtin', name: '' })).toThrow();
    expect(() => toolKey({ origin: 'caco', name: '' })).toThrow();
  });
});

describe('toolKeyFromEvent — resolve a tool.execution_start event to the SAME key excludedTools uses', () => {
  const cacoNames = new Set(['caco_run_workflow', 'caco_docs']);

  it('MCP event (mcpServerName+mcpToolName) → the exact excludedTools namespacedName', () => {
    const key = toolKeyFromEvent(
      { toolName: 'github-mcp-server-list_issues', mcpServerName: 'github-mcp-server', mcpToolName: 'list_issues' },
      cacoNames,
    );
    // identical to the descriptor key AND to the SDK excludedTools string
    expect(key).toBe(toolKey({ origin: 'mcp', serverName: 'github-mcp-server', toolName: 'list_issues' }));
    expect(key).toBe('github-mcp-server/list_issues');
  });

  it('bare Caco tool name → caco:name (disambiguated via cacoToolNames)', () => {
    const key = toolKeyFromEvent({ toolName: 'caco_docs' }, cacoNames);
    expect(key).toBe(toolKey({ origin: 'caco', name: 'caco_docs' }));
    expect(key).toBe('caco:caco_docs');
  });

  it('bare non-Caco name → builtin:name (matches DEFAULT_EXCLUDED_BUILTINS)', () => {
    const key = toolKeyFromEvent({ toolName: 'bash' }, cacoNames);
    expect(key).toBe(toolKey({ origin: 'builtin', name: 'bash' }));
    expect(key).toBe('builtin:bash');
  });

  it('throws when the event carries no toolName (never fabricates a key)', () => {
    expect(() => toolKeyFromEvent({}, cacoNames)).toThrow();
  });

  it('an MCP event missing mcpToolName falls back to bare-name classification (builtin)', () => {
    // Defensive: without the raw mcp fields we cannot form server/tool, so treat the
    // model-facing toolName as a bare name rather than fabricating a partial mcp key.
    const key = toolKeyFromEvent({ toolName: 'view' }, cacoNames);
    expect(key).toBe('builtin:view');
  });
});
