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

describe('caco_enable_tools failure/phantom wording (cf-message)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('an unknown-name rejection (relistable) DOES advise re-listing', async () => {
    sm.enableTools.mockResolvedValue({ ok: false, error: 'unknown tool: nonesuch', relistable: true });
    const res = await makeHandler()({ names: ['nonesuch'] });
    expect(res.textResultForLlm).toMatch(/no arguments to list/i);
  });

  it('a disabled/operational failure (NOT relistable) does NOT advise re-listing', async () => {
    sm.enableTools.mockResolvedValue({ ok: false, error: 'tool is disabled and not re-enableable: builtin:x', relistable: false });
    const res = await makeHandler()({ names: ['x'] });
    expect(res.textResultForLlm).not.toMatch(/no arguments to list/i);
    expect(res.textResultForLlm).toMatch(/Nothing was changed/);
  });

  it('renders one precise, non-looping line per phantom reason (no re-list advice, no user path)', async () => {
    sm.enableTools.mockResolvedValue({
      ok: true, enabled: [], alreadyEnabled: [], phantom: ['ADO-x', 'icm-y', 'old-z'],
      phantomReasons: [
        { key: 'ADO-x', reason: 'not-configured', server: 'ADO' },
        { key: 'icm-y', reason: 'temporarily-unavailable', server: 'icm' },
        { key: 'old-z', reason: 'stale-unverified' },
      ],
    });
    const res = await makeHandler()({ names: ['ADO-x', 'icm-y', 'old-z'] });
    const t = res.textResultForLlm;
    expect(t).toMatch(/not configured/i);       // not-configured message
    expect(t).toMatch(/not connected right now/i); // temporarily-unavailable message
    expect(t).toMatch(/stale cache entry/i);     // stale-unverified message
    expect(t).not.toMatch(/no arguments to list/i); // NEVER re-list advice for a phantom
    expect(t).not.toMatch(/C:\\|\/Users\/|\/home\//); // no user-specific path
  });

  it('falls back to the blanket phantom message when no phantomReasons (freshness absent)', async () => {
    sm.enableTools.mockResolvedValue({ ok: true, enabled: [], alreadyEnabled: [], phantom: ['ADO-x'] });
    const res = await makeHandler()({ names: ['ADO-x'] });
    expect(res.textResultForLlm).toMatch(/not loaded here/i);
    expect(res.textResultForLlm).not.toMatch(/no arguments to list/i);
  });
});
