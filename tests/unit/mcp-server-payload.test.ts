import { describe, it, expect } from 'vitest';
import { buildMcpServerPayload } from '../../src/routes/workspace-api.js';

describe('buildMcpServerPayload — /api/mcp/servers response shape', () => {
  it('attaches each server its own tools by name', () => {
    const servers = [
      { name: 'github', status: 'connected', source: 'config' },
      { name: 'linear', status: 'needs-auth' },
    ];
    const toolsByName = {
      github: [{ name: 'create_issue', description: 'Open an issue' }],
      linear: [],
    };
    const out = buildMcpServerPayload(servers, toolsByName);
    expect(out).toEqual([
      { name: 'github', status: 'connected', source: 'config', error: null, tools: [{ name: 'create_issue', description: 'Open an issue' }] },
      { name: 'linear', status: 'needs-auth', source: null, error: null, tools: [] },
    ]);
  });

  it('defaults tools to [] when a server has no entry (never undefined)', () => {
    const out = buildMcpServerPayload([{ name: 'x', status: 'connected' }], {});
    expect(out[0].tools).toEqual([]);
  });

  it('normalizes missing source/error to null', () => {
    const out = buildMcpServerPayload([{ name: 'x', status: 'failed', error: 'boom' }], { x: [] });
    expect(out[0]).toMatchObject({ source: null, error: 'boom' });
  });
});
