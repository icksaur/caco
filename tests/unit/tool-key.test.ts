import { describe, it, expect } from 'vitest';
import { toolKey } from '../../src/tool-key.js';

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
