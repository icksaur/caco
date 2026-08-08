import { describe, it, expect, vi, beforeEach } from 'vitest';

const sm = vi.hoisted(() => ({
  getToolCatalog: vi.fn(async () => ({ catalog: new Map(), excluded: new Set(), policyDisabled: new Set() })),
  enableTools: vi.fn(),
}));
vi.mock('../../src/session-manager.js', () => ({ sessionManager: sm }));
vi.mock('../../src/session-tool-state.js', () => ({ formatDeferredTools: vi.fn(() => 'DEFERRED') }));

import { createToolRevealTool } from '../../src/tool-reveal-tool.js';

type Handler = (args: { names?: string[] }) => Promise<{ textResultForLlm: string }>;

function makeHandler(): Handler {
  return createToolRevealTool({ id: 'sess-1' })[0].handler as unknown as Handler;
}

describe('caco_enable_tools result wording (spec-enable-tools-autocontinue P6)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('describes auto-continuation in a new request, not "next turn"', async () => {
    sm.enableTools.mockResolvedValue({ ok: true, enabled: ['github-list_issues'], alreadyEnabled: [], phantom: [] });
    const res = await makeHandler()({ names: ['list_issues'] });
    expect(res.textResultForLlm).toMatch(/continue in a new request/i);
    expect(res.textResultForLlm).not.toMatch(/next turn/i);
  });

  it('the tool description also avoids the misleading "next turn" claim', () => {
    const tool = createToolRevealTool({ id: 'sess-1' })[0] as unknown as { description: string };
    expect(tool.description).toMatch(/new request/i);
    expect(tool.description).not.toMatch(/next turn/i);
  });
});
