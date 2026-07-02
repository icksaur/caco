import { describe, it, expect } from 'vitest';
import { buildMcpServerPayload } from '../../src/routes/workspace-api.js';

describe('buildMcpServerPayload — /api/mcp/servers response shape', () => {
  it('prepends a Built-in pseudo-server with the client tools', () => {
    const out = buildMcpServerPayload([], {}, [{ name: 'view', description: 'Read a file' }]);
    expect(out[0]).toEqual({
      name: 'Built-in', status: 'connected', source: 'caco', error: null,
      tools: [{ name: 'view', description: 'Read a file' }],
    });
  });

  it('attaches each server its own tools by name, after the built-in entry', () => {
    const servers = [
      { name: 'github', status: 'connected', source: 'config' },
      { name: 'linear', status: 'needs-auth' },
    ];
    const toolsByName = {
      github: [{ name: 'create_issue', description: 'Open an issue' }],
      linear: [],
    };
    const out = buildMcpServerPayload(servers, toolsByName, []);
    expect(out.map(s => s.name)).toEqual(['Built-in', 'github', 'linear']);
    expect(out[1]).toEqual({ name: 'github', status: 'connected', source: 'config', error: null, tools: [{ name: 'create_issue', description: 'Open an issue' }] });
    expect(out[2]).toEqual({ name: 'linear', status: 'needs-auth', source: null, error: null, tools: [] });
  });

  it('defaults built-in tools to [] when omitted', () => {
    const out = buildMcpServerPayload([], {});
    expect(out).toEqual([{ name: 'Built-in', status: 'connected', source: 'caco', error: null, tools: [] }]);
  });

  it('defaults tools to [] when a server has no entry (never undefined)', () => {
    const out = buildMcpServerPayload([{ name: 'x', status: 'connected' }], {}, []);
    expect(out[1].tools).toEqual([]);
  });

  it('normalizes missing source/error to null', () => {
    const out = buildMcpServerPayload([{ name: 'x', status: 'failed', error: 'boom' }], { x: [] }, []);
    expect(out[1]).toMatchObject({ source: null, error: 'boom' });
  });
});
