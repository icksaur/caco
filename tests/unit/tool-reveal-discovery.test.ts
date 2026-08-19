/**
 * caco_enable_tools discovery + enable modes (spec-enable-tools-discovery).
 * No-args ⇒ list deferred tools (pure read, NO mutation). names ⇒ enable via
 * SessionManager. Pins the sole-escape-hatch behavior and that discovery never
 * mutates the exclusion set.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mgr = vi.hoisted(() => ({ getToolCatalog: vi.fn(), enableTools: vi.fn() }));
vi.mock('../../src/session-manager.js', () => ({ sessionManager: mgr }));
vi.mock('../../src/session-tool-state.js', () => ({
  formatDeferredTools: vi.fn(() => 'DEFERRED_LIST'),
}));

import { createToolRevealTool } from '../../src/tool-reveal-tool.js';
import { formatDeferredTools } from '../../src/session-tool-state.js';
import type { SessionIdRef } from '../../src/types.js';

interface ToolWithHandler {
  name: string;
  handler: (args: { names?: string[] }) => Promise<{ textResultForLlm: string }>;
}

function tool(ref: SessionIdRef): ToolWithHandler {
  const [t] = createToolRevealTool(ref) as unknown as ToolWithHandler[];
  return t;
}

beforeEach(() => {
  mgr.getToolCatalog.mockReset();
  mgr.enableTools.mockReset();
  (formatDeferredTools as unknown as ReturnType<typeof vi.fn>).mockClear();
  mgr.getToolCatalog.mockResolvedValue({ catalog: {}, excluded: new Set(), policyDisabled: new Set() });
  mgr.enableTools.mockResolvedValue({ ok: true, enabled: ['x'], alreadyEnabled: [], phantom: [] });
});

describe('caco_enable_tools — no-args discovery mode', () => {
  it('with no names, lists deferred tools via getToolCatalog(sessionId) and does NOT enable', async () => {
    const out = await tool({ id: 'sess-1' }).handler({});
    expect(mgr.getToolCatalog).toHaveBeenCalledWith('sess-1');
    expect(formatDeferredTools).toHaveBeenCalledOnce();
    expect(mgr.enableTools).not.toHaveBeenCalled();
    expect(out.textResultForLlm).toBe('DEFERRED_LIST');
  });

  it('an empty names array is also discovery (no mutation)', async () => {
    await tool({ id: 'sess-1' }).handler({ names: [] });
    expect(mgr.getToolCatalog).toHaveBeenCalledWith('sess-1');
    expect(mgr.enableTools).not.toHaveBeenCalled();
  });
});

describe('caco_enable_tools — enable mode', () => {
  it('with names, calls enableTools and NOT the discovery formatter', async () => {
    const out = await tool({ id: 'sess-1' }).handler({ names: ['list_issues'] });
    expect(mgr.enableTools).toHaveBeenCalledWith('sess-1', ['list_issues']);
    expect(formatDeferredTools).not.toHaveBeenCalled();
    expect(out.textResultForLlm).toContain('Enabled 1 tool');
  });

  it('surfaces an enable failure and points back at no-args discovery', async () => {
    mgr.enableTools.mockResolvedValue({ ok: false, error: 'unknown tool: nope', relistable: true });
    const out = await tool({ id: 'sess-1' }).handler({ names: ['nope'] });
    expect(out.textResultForLlm).toContain('unknown tool: nope');
    expect(out.textResultForLlm).toContain('no arguments');
  });
});

describe('caco_enable_tools — no active session', () => {
  it('returns a no-session message without touching the manager', async () => {
    const out = await tool({ id: '' }).handler({});
    expect(out.textResultForLlm).toContain('no active session');
    expect(mgr.getToolCatalog).not.toHaveBeenCalled();
    expect(mgr.enableTools).not.toHaveBeenCalled();
  });
});
