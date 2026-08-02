import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionManagerFake = vi.hoisted(() => ({
  getModels: vi.fn<() => Array<{ id: string }>>(),
  isBusy: vi.fn<(sessionId: string) => boolean>(),
  isActive: vi.fn<(sessionId: string) => boolean>(),
  isUnderMaintenance: vi.fn<(sessionId: string) => boolean>(),
}));

const storageFake = vi.hoisted(() => ({
  getSessionMeta: vi.fn<(sessionId: string) => { name?: string; lastIdleAt?: string; orchestratedBy?: string; herdOriginParent?: string; folder?: string; autoArchiveTaggedAt?: number } | undefined>(),
  updateSessionMeta: vi.fn<(sessionId: string, updater: (meta: { orchestratedBy?: string; herdOriginParent?: string; folder?: string; autoArchiveTaggedAt?: number }) => void) => void>(),
}));

const historyFake = vi.hoisted(() => ({
  getLastAssistantMessage: vi.fn<(sessionId: string) => Promise<string>>(),
}));

const delegateFake = vi.hoisted(() => ({
  boundDelegateResponse: vi.fn<(text: string, sessionId8: string) => string>(),
}));

const herdFake = vi.hoisted(() => ({
  registerHerdBond: vi.fn<(childId: string, parentId: string) => void>(),
  clearHerdBond: vi.fn<(childId: string) => void>(),
  getHerdChildren: vi.fn<(parentId: string) => string[]>(),
  deriveChildStatus: vi.fn<(isBusy: boolean, isActive: boolean) => 'busy' | 'idle' | 'inactive'>(),
  herdParentActionError: vi.fn<(callerOrchestratedBy?: string) => string | null>(),
  herdAcquireError: vi.fn<(opts: { callerId: string; targetId: string; targetExists: boolean; targetOrchestratedBy?: string }) => string | null>(),
  herdMemberError: vi.fn<(opts: { action: 'resume' | 'disown'; callerId: string; targetOrchestratedBy?: string }) => string | null>(),
  buildHerdStatePayload: vi.fn<(entries: HerdStateEntry[]) => { count: number; children: HerdStateEntry[] }>(),
}));

const trackerFake = vi.hoisted(() => ({
  markObserved: vi.fn<(sessionId: string) => boolean>(),
}));

vi.mock('../../src/session-manager.js', () => ({ sessionManager: sessionManagerFake }));
vi.mock('../../src/storage.js', () => storageFake);
vi.mock('../../src/session-history.js', () => historyFake);
vi.mock('../../src/delegate-tool.js', () => delegateFake);
// `shouldParkOnDisown` is deliberately NOT faked: the parking branch must be driven
// by the fixture's real provenance stamp, so a hand-written double that drifted from
// the real predicate could not hide a regression.
vi.mock('../../src/herd.js', async () => ({
  ...herdFake,
  shouldParkOnDisown: (await vi.importActual<typeof import('../../src/herd.js')>('../../src/herd.js')).shouldParkOnDisown,
}));
vi.mock('../../src/unobserved-tracker.js', () => ({ unobservedTracker: trackerFake }));

import { createHerdTools } from '../../src/herd-tools.js';
import type { SessionIdRef } from '../../src/types.js';

interface HerdStateEntry {
  sessionId: string;
  name: string | null;
  status: 'busy' | 'idle' | 'inactive';
  lastIdleAt: string | null;
  lastResponse: string;
}

interface HerdArgs {
  action: 'create' | 'acquire' | 'resume' | 'disown';
  sessionId?: string;
  cwd?: string;
  model?: string;
  prompt?: string;
}

interface ToolWithHandler<TArgs> {
  name: string;
  handler: (args: TArgs) => Promise<{ textResultForLlm: string; resultType: 'text' | 'error' }>;
}

const sessionRef: SessionIdRef = { id: 'parent-session-0001' };

function tools() {
  const [stateTool, herdTool] = createHerdTools(sessionRef, () => 'corr-123') as unknown as [
    ToolWithHandler<Record<string, never>>,
    ToolWithHandler<HerdArgs>,
  ];
  return { stateTool, herdTool };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Nope',
    json: () => Promise.resolve(body),
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionManagerFake.getModels.mockReturnValue([{ id: 'auto' }, { id: 'sonnet' }]);
  sessionManagerFake.isBusy.mockReturnValue(false);
  sessionManagerFake.isActive.mockReturnValue(true);
  sessionManagerFake.isUnderMaintenance.mockReturnValue(false);
  storageFake.getSessionMeta.mockImplementation(() => undefined);
  storageFake.updateSessionMeta.mockImplementation((_sessionId, updater) => {
    updater({});
  });
  historyFake.getLastAssistantMessage.mockResolvedValue('assistant reply');
  delegateFake.boundDelegateResponse.mockImplementation((text, id8) => `${id8}:${text}`);
  herdFake.getHerdChildren.mockReturnValue([]);
  herdFake.deriveChildStatus.mockImplementation((busy, active) => (busy ? 'busy' : active ? 'idle' : 'inactive'));
  herdFake.herdParentActionError.mockImplementation(orchestratedBy => (
    orchestratedBy ? `child of ${orchestratedBy.slice(0, 8)} cannot parent` : null
  ));
  herdFake.herdAcquireError.mockImplementation(opts => {
    if (opts.targetId === opts.callerId) return 'Cannot acquire yourself into your own herd.';
    if (!opts.targetExists) return `Session ${opts.targetId.slice(0, 8)} does not exist.`;
    if (opts.targetOrchestratedBy && opts.targetOrchestratedBy !== opts.callerId) return 'Already another parent.';
    return null;
  });
  herdFake.herdMemberError.mockImplementation(opts => (
    opts.targetOrchestratedBy === opts.callerId ? null : `That session is not a child of your herd, so you cannot ${opts.action} it.`
  ));
  herdFake.buildHerdStatePayload.mockImplementation(entries => ({ count: entries.length, children: entries }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('caco_herd_state', () => {
  it('returns live child status and bounded last responses', async () => {
    herdFake.getHerdChildren.mockReturnValue(['child-a-0001', 'child-b-0002']);
    storageFake.getSessionMeta.mockImplementation(sessionId => ({
      name: sessionId.endsWith('0001') ? 'alpha' : 'beta',
      lastIdleAt: sessionId.endsWith('0001') ? '2026-01-01T00:00:00.000Z' : undefined,
    }));
    sessionManagerFake.isBusy.mockImplementation(sessionId => sessionId.endsWith('0002'));
    sessionManagerFake.isActive.mockReturnValue(true);
    historyFake.getLastAssistantMessage.mockImplementation(sessionId => Promise.resolve(`reply from ${sessionId}`));

    const out = await tools().stateTool.handler({});
    const payload = JSON.parse(out.textResultForLlm) as { count: number; children: HerdStateEntry[] };

    expect(payload.count).toBe(2);
    expect(payload.children[0]).toMatchObject({
      sessionId: 'child-a-0001',
      name: 'alpha',
      status: 'idle',
      lastIdleAt: '2026-01-01T00:00:00.000Z',
      lastResponse: 'child-a-:reply from child-a-0001',
    });
    expect(payload.children[1]).toMatchObject({ status: 'busy', lastResponse: 'child-b-:reply from child-b-0002' });
    expect(herdFake.getHerdChildren).toHaveBeenCalledWith('parent-session-0001');
    expect(sessionManagerFake.isBusy).toHaveBeenCalledWith('child-b-0002');
  });
});

describe('caco_herd create', () => {
  it('creates a child, bonds it, and sends the first prompt with correlation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'new-child-0003' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await tools().herdTool.handler({
      action: 'create',
      cwd: '/workspace/project',
      model: 'auto',
      prompt: 'start work',
    });

    expect(out.resultType).toBe('text');
    expect(out.textResultForLlm).toContain('Created herd child new-child-0003');
    expect(fetchMock).toHaveBeenNthCalledWith(1, expect.stringContaining('/api/sessions'), expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        cwd: '/workspace/project',
        model: 'auto',
        description: 'herd child of parent-s',
        kind: 'agent',
      }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, expect.stringContaining('/api/sessions/new-child-0003/messages'), expect.objectContaining({
      body: JSON.stringify({
        prompt: 'start work',
        source: 'agent',
        fromSession: 'parent-session-0001',
        correlationId: 'corr-123',
      }),
    }));
    expect(storageFake.updateSessionMeta).toHaveBeenCalledWith('new-child-0003', expect.any(Function));
    expect(herdFake.registerHerdBond).toHaveBeenCalledWith('new-child-0003', 'parent-session-0001');
    // Provenance is stamped in the SAME write as the bond (spec-soft-archive-folder):
    // this is the only path that creates a herd child, so it is the only place the
    // write-once origin can be recorded.
    const updater = storageFake.updateSessionMeta.mock.calls.at(-1)![1];
    const m: { orchestratedBy?: string; herdOriginParent?: string } = {};
    updater(m);
    expect(m.orchestratedBy).toBe('parent-session-0001');
    expect(m.herdOriginParent).toBe('parent-session-0001');
  });

  it('rejects create from a herd child before touching fetch', async () => {
    storageFake.getSessionMeta.mockImplementation(sessionId => (
      sessionId === 'parent-session-0001' ? { orchestratedBy: 'grand-parent' } : undefined
    ));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await tools().herdTool.handler({ action: 'create', cwd: '/workspace/project', model: 'auto' });

    expect(out.resultType).toBe('error');
    expect(out.textResultForLlm).toContain('cannot parent');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates create required fields and model id', async () => {
    const missing = await tools().herdTool.handler({ action: 'create', cwd: '/workspace/project' });
    const invalid = await tools().herdTool.handler({ action: 'create', cwd: '/workspace/project', model: 'missing-model' });

    expect(missing).toMatchObject({ resultType: 'error', textResultForLlm: 'create requires cwd and model.' });
    expect(invalid.resultType).toBe('error');
    expect(invalid.textResultForLlm).toContain('Unknown model "missing-model"');
  });

  it('reports session creation and first-prompt dispatch failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'quota' }, false, 429))
      .mockResolvedValueOnce(jsonResponse({ sessionId: 'new-child-0003' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'route rejected' }, false, 400));
    vi.stubGlobal('fetch', fetchMock);

    const failedCreate = await tools().herdTool.handler({ action: 'create', cwd: '/workspace/project', model: 'auto' });
    const failedPrompt = await tools().herdTool.handler({
      action: 'create',
      cwd: '/workspace/project',
      model: 'auto',
      prompt: 'start work',
    });

    expect(failedCreate).toMatchObject({ resultType: 'error', textResultForLlm: 'Failed to create child: quota' });
    expect(failedPrompt.resultType).toBe('text');
    expect(failedPrompt.textResultForLlm).toContain('first prompt failed to send: HTTP 400');
  });
});

describe('caco_herd acquire, resume, and disown', () => {
  it('requires sessionId for target actions', async () => {
    const out = await tools().herdTool.handler({ action: 'resume', prompt: 'continue' });

    expect(out).toMatchObject({ resultType: 'error', textResultForLlm: 'resume requires a sessionId.' });
  });

  it('acquires an existing target with prefix stripped and sends an optional prompt', async () => {
    storageFake.getSessionMeta.mockImplementation(sessionId => (
      sessionId === 'target-child-0004' ? { name: 'target' } : undefined
    ));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await tools().herdTool.handler({
      action: 'acquire',
      sessionId: 'caco-session:target-child-0004',
      prompt: 'join herd',
    });

    expect(out).toMatchObject({ resultType: 'text', textResultForLlm: 'Acquired target-c into your herd.' });
    expect(storageFake.updateSessionMeta).toHaveBeenCalledWith('target-child-0004', expect.any(Function));
    expect(herdFake.registerHerdBond).toHaveBeenCalledWith('target-child-0004', 'parent-session-0001');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/sessions/target-child-0004/messages'), expect.objectContaining({
      body: expect.stringContaining('"prompt":"join herd"'),
    }));
  });

  it('rejects invalid acquire targets through herd validation', async () => {
    const out = await tools().herdTool.handler({ action: 'acquire', sessionId: 'missing-child-0005' });

    expect(out.resultType).toBe('error');
    expect(out.textResultForLlm).toContain('does not exist');
    expect(herdFake.registerHerdBond).not.toHaveBeenCalled();
  });

  it('resumes an owned child and reports dispatch failure', async () => {
    storageFake.getSessionMeta.mockImplementation(sessionId => (
      sessionId === 'target-child-0004' ? { orchestratedBy: 'parent-session-0001' } : undefined
    ));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const ok = await tools().herdTool.handler({ action: 'resume', sessionId: 'target-child-0004', prompt: 'continue' });
    const failed = await tools().herdTool.handler({ action: 'resume', sessionId: 'target-child-0004', prompt: 'continue again' });

    expect(ok).toMatchObject({ resultType: 'text', textResultForLlm: 'Resumed child target-c.' });
    expect(failed.resultType).toBe('error');
    expect(failed.textResultForLlm).toContain('Failed to resume target-c: network down');
    // Resume clears the child's unobserved badge (spec-herd-observe-clear) — even the
    // dispatch-failed second resume observed the child (marked before the send).
    expect(trackerFake.markObserved).toHaveBeenCalledWith('target-child-0004');
    expect(trackerFake.markObserved).toHaveBeenCalledTimes(2);
  });

  it('validates resume prompt and herd membership', async () => {
    storageFake.getSessionMeta.mockImplementation(sessionId => (
      sessionId === 'other-child-0006' ? { orchestratedBy: 'someone-else' } : { orchestratedBy: 'parent-session-0001' }
    ));

    const missingPrompt = await tools().herdTool.handler({ action: 'resume', sessionId: 'target-child-0004' });
    const notMine = await tools().herdTool.handler({ action: 'resume', sessionId: 'other-child-0006', prompt: 'continue' });

    expect(missingPrompt).toMatchObject({ resultType: 'error', textResultForLlm: 'resume requires a prompt.' });
    expect(notMine.resultType).toBe('error');
    expect(notMine.textResultForLlm).toContain('not a child of your herd');
    // Neither a missing-prompt resume nor a non-member resume observes the child.
    expect(trackerFake.markObserved).not.toHaveBeenCalled();
  });

  it('disowns a child it CREATED, parks it in auto-archive with a fresh tag, and clears the bond', async () => {
    storageFake.getSessionMeta.mockImplementation(sessionId => (
      sessionId === 'target-child-0004'
        ? { orchestratedBy: 'parent-session-0001', herdOriginParent: 'parent-session-0001' }
        : undefined
    ));

    const out = await tools().herdTool.handler({ action: 'disown', sessionId: 'target-child-0004' });

    expect(out).toMatchObject({ resultType: 'text' });
    expect((out as { textResultForLlm: string }).textResultForLlm).toContain('auto-archive');
    expect(storageFake.updateSessionMeta).toHaveBeenCalledWith('target-child-0004', expect.any(Function));
    // Apply the updater to a blank meta and assert the parking mutation.
    const updater = storageFake.updateSessionMeta.mock.calls.at(-1)![1];
    const m: { orchestratedBy?: string; folder?: string; autoArchiveTaggedAt?: number } = { orchestratedBy: 'parent-session-0001' };
    updater(m);
    expect(m.orchestratedBy).toBeUndefined();
    expect(m.folder).toBe('auto-archive');
    expect(typeof m.autoArchiveTaggedAt).toBe('number');
    expect(herdFake.clearHerdBond).toHaveBeenCalledWith('target-child-0004');
    // Disown observes the child, clearing its unobserved badge (spec-herd-observe-clear).
    expect(trackerFake.markObserved).toHaveBeenCalledWith('target-child-0004');
  });

  it('disowns an ACQUIRED child without parking it, leaving its folder untouched', async () => {
    // No herdOriginParent stamp => the herd did not create this session.
    storageFake.getSessionMeta.mockImplementation(sessionId => (
      sessionId === 'target-child-0004' ? { orchestratedBy: 'parent-session-0001' } : undefined
    ));

    const out = await tools().herdTool.handler({ action: 'disown', sessionId: 'target-child-0004' });

    expect(out).toMatchObject({ resultType: 'text' });
    expect((out as { textResultForLlm: string }).textResultForLlm).not.toContain('auto-archive');
    expect((out as { textResultForLlm: string }).textResultForLlm).toContain('not scheduled for archival');
    // Asserted against a meta that ALREADY carries a user folder: disown must neither
    // set the auto-archive folder nor clear the folder the session already had.
    const updater = storageFake.updateSessionMeta.mock.calls.at(-1)![1];
    const m: { orchestratedBy?: string; folder?: string; autoArchiveTaggedAt?: number } =
      { orchestratedBy: 'parent-session-0001', folder: 'my-work' };
    updater(m);
    expect(m.orchestratedBy).toBeUndefined();
    expect(m.folder).toBe('my-work');
    expect(m.autoArchiveTaggedAt).toBeUndefined();
    expect(herdFake.clearHerdBond).toHaveBeenCalledWith('target-child-0004');
    // Releasing an acquired child is still an observation (spec-herd-observe-clear).
    expect(trackerFake.markObserved).toHaveBeenCalledWith('target-child-0004');
  });

  it('does not park a child whose meta predates provenance (unknown => fail safe)', async () => {
    storageFake.getSessionMeta.mockImplementation(sessionId => (
      sessionId === 'target-child-0004' ? { orchestratedBy: 'parent-session-0001' } : undefined
    ));

    await tools().herdTool.handler({ action: 'disown', sessionId: 'target-child-0004' });

    const updater = storageFake.updateSessionMeta.mock.calls.at(-1)![1];
    const m: { orchestratedBy?: string; folder?: string; autoArchiveTaggedAt?: number } = { orchestratedBy: 'parent-session-0001' };
    updater(m);
    expect(m.folder).toBeUndefined();
    expect(m.autoArchiveTaggedAt).toBeUndefined();
  });

  it('acquire does not stamp provenance, so a later disown does not park', async () => {
    storageFake.getSessionMeta.mockImplementation(sessionId => (
      sessionId === 'target-child-0004' ? { name: 'pre-existing' } : undefined
    ));

    await tools().herdTool.handler({ action: 'acquire', sessionId: 'target-child-0004' });

    const updater = storageFake.updateSessionMeta.mock.calls.at(-1)![1];
    const m: { orchestratedBy?: string; herdOriginParent?: string } = {};
    updater(m);
    expect(m.orchestratedBy).toBe('parent-session-0001');
    expect(m.herdOriginParent).toBeUndefined();
  });

  it('acquire leaves an existing provenance stamp intact (write-once survives re-acquire)', async () => {
    storageFake.getSessionMeta.mockImplementation(sessionId => (
      sessionId === 'target-child-0004' ? { herdOriginParent: 'original-creator-0009' } : undefined
    ));

    await tools().herdTool.handler({ action: 'acquire', sessionId: 'target-child-0004' });

    const updater = storageFake.updateSessionMeta.mock.calls.at(-1)![1];
    const m: { orchestratedBy?: string; herdOriginParent?: string } = { herdOriginParent: 'original-creator-0009' };
    updater(m);
    expect(m.herdOriginParent).toBe('original-creator-0009');
  });

  it('keeps provenance across a create -> disown -> acquire -> disown round trip', async () => {
    // A PERSISTING store: the default harness discards mutations (it only captures the
    // updater), so a round trip run against it would pass without proving anything.
    const store = new Map<string, Record<string, unknown>>();
    storageFake.getSessionMeta.mockImplementation(id => store.get(id) as never);
    storageFake.updateSessionMeta.mockImplementation((id, updater) => {
      const meta = store.get(id) ?? {};
      updater(meta as never);
      store.set(id, meta);
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sessionId: 'new-child-0003' }));
    vi.stubGlobal('fetch', fetchMock);

    await tools().herdTool.handler({ action: 'create', cwd: '/workspace/project', model: 'auto' });
    expect(store.get('new-child-0003')?.herdOriginParent).toBe('parent-session-0001');

    await tools().herdTool.handler({ action: 'disown', sessionId: 'new-child-0003' });
    expect(store.get('new-child-0003')?.folder).toBe('auto-archive');

    await tools().herdTool.handler({ action: 'acquire', sessionId: 'new-child-0003' });
    expect(store.get('new-child-0003')?.folder).toBeUndefined();
    expect(store.get('new-child-0003')?.autoArchiveTaggedAt).toBeUndefined();

    const second = await tools().herdTool.handler({ action: 'disown', sessionId: 'new-child-0003' });
    // The stamp was never cleared, so the child is still herd-created and parks again.
    expect(store.get('new-child-0003')?.herdOriginParent).toBe('parent-session-0001');
    expect(store.get('new-child-0003')?.folder).toBe('auto-archive');
    expect((second as { textResultForLlm: string }).textResultForLlm).toContain('auto-archive');
  });

  it('refuses disown while the child is under an archive maintenance claim', async () => {
    storageFake.getSessionMeta.mockImplementation(sessionId => (
      sessionId === 'target-child-0004' ? { orchestratedBy: 'parent-session-0001' } : undefined
    ));
    sessionManagerFake.isUnderMaintenance.mockReturnValue(true);

    const out = await tools().herdTool.handler({ action: 'disown', sessionId: 'target-child-0004' });

    expect(out).toMatchObject({ resultType: 'error' });
    expect((out as { textResultForLlm: string }).textResultForLlm).toContain('being archived');
    expect(herdFake.clearHerdBond).not.toHaveBeenCalled();
    // A refused disown does not observe the child.
    expect(trackerFake.markObserved).not.toHaveBeenCalled();
  });

  it('acquire un-tags a parked session (clears auto-archive folder + tag)', async () => {
    storageFake.getSessionMeta.mockImplementation(sessionId => (
      sessionId === 'target-child-0004' ? { folder: 'auto-archive', autoArchiveTaggedAt: 123 } : undefined
    ));

    await tools().herdTool.handler({ action: 'acquire', sessionId: 'target-child-0004' });

    const updater = storageFake.updateSessionMeta.mock.calls.at(-1)![1];
    const m: { orchestratedBy?: string; folder?: string; autoArchiveTaggedAt?: number } = { folder: 'auto-archive', autoArchiveTaggedAt: 123 };
    updater(m);
    expect(m.orchestratedBy).toBe('parent-session-0001');
    expect(m.folder).toBeUndefined();
    expect(m.autoArchiveTaggedAt).toBeUndefined();
  });
});
