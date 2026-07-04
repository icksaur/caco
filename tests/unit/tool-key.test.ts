import { describe, it, expect } from 'vitest';
import { builtinKey, cacoKey, mcpKey, toolKeyFromEvent } from '../../src/tool-key.js';

describe('key producers — a ToolKey IS the excludedTools string', () => {
  it('builtin → builtin:name', () => {
    expect(builtinKey('bash')).toBe('builtin:bash');
  });
  it('builtin normalizes an already-prefixed name (idempotent)', () => {
    expect(builtinKey('builtin:bash')).toBe('builtin:bash');
  });
  it('caco → bare model-facing name (NOT caco:-prefixed — verified by the C0 probe)', () => {
    expect(cacoKey('caco_memory')).toBe('caco_memory');
  });
  it('mcp → the model-facing name verbatim', () => {
    expect(mcpKey('github-mcp-server-list_issues')).toBe('github-mcp-server-list_issues');
    expect(mcpKey('web_search')).toBe('web_search');
  });
  it('throws on empty input (never fabricates)', () => {
    expect(() => builtinKey('')).toThrow();
    expect(() => cacoKey('')).toThrow();
    expect(() => mcpKey('')).toThrow();
  });
});

describe('toolKeyFromEvent — resolve a tool.execution_start event to the excludedTools key', () => {
  const cacoNames = new Set(['caco_run_workflow', 'caco_docs']);

  it('MCP event → the model-facing toolName (the key excludedTools matches)', () => {
    const key = toolKeyFromEvent(
      { toolName: 'github-mcp-server-list_issues', mcpServerName: 'github-mcp-server', mcpToolName: 'list_issues' },
      cacoNames,
    );
    expect(key).toBe('github-mcp-server-list_issues');
    expect(key).toBe(mcpKey('github-mcp-server-list_issues'));
  });

  it('MCP irregular name (web_search, no prefix) resolves to toolName verbatim', () => {
    const key = toolKeyFromEvent(
      { toolName: 'web_search', mcpServerName: 'github-mcp-server', mcpToolName: 'web_search' },
      cacoNames,
    );
    expect(key).toBe('web_search');
  });

  it('bare Caco tool name → bare key (disambiguated via cacoToolNames)', () => {
    expect(toolKeyFromEvent({ toolName: 'caco_docs' }, cacoNames)).toBe('caco_docs');
  });

  it('bare non-Caco name → builtin:name', () => {
    expect(toolKeyFromEvent({ toolName: 'bash' }, cacoNames)).toBe('builtin:bash');
  });

  it('throws when the event carries no toolName (never fabricates)', () => {
    expect(() => toolKeyFromEvent({}, cacoNames)).toThrow();
  });

  it('an MCP event missing toolName throws (needs the model-facing name)', () => {
    expect(() => toolKeyFromEvent({ mcpServerName: 'gh' }, cacoNames)).toThrow();
  });
});
