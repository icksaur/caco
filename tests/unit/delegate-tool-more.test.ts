import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionManagerFake = vi.hoisted(() => ({
  getSessionCwd: vi.fn<(sessionId: string) => string | undefined>(),
  isBusy: vi.fn<(sessionId: string) => boolean>(),
}));

const dispatchStateFake = vi.hoisted(() => ({
  getCorrelationId: vi.fn<(sessionId: string) => string | undefined>(),
  waitForActive: vi.fn<(sessionId: string, opts: WaitOptions) => Promise<'idle' | 'gone' | 'timeout'>>(),
}));

const storageFake = vi.hoisted(() => ({
  getSessionMeta: vi.fn<(sessionId: string) => { name?: string; orchestratedBy?: string } | undefined>(),
}));

const historyFake = vi.hoisted(() => ({
  getLastAssistantMessage: vi.fn<(sessionId: string) => Promise<string>>(),
}));

vi.mock('../../src/session-manager.js', () => ({ sessionManager: sessionManagerFake }));
vi.mock('../../src/dispatch-state.js', () => ({ dispatchState: dispatchStateFake }));
vi.mock('../../src/storage.js', () => storageFake);
vi.mock('../../src/session-history.js', () => historyFake);

import { createDelegateTool } from '../../src/delegate-tool.js';
import type { SessionIdRef } from '../../src/types.js';

interface WaitOptions {
  idleTimeoutMs: number;
  maxTotalMs: number;
  isGone: () => boolean;
}

interface DelegatePrompt {
  sessionId: string;
  message: string;
}

interface ToolWithHandler {
  handler: (args: { prompts: DelegatePrompt[] }) => Promise<{ textResultForLlm: string; resultType: 'text' | 'error' }>;
}

const sessionRef: SessionIdRef = { id: 'caller-session-0001' };

function tool(): ToolWithHandler {
  const [delegateTool] = createDelegateTool(sessionRef) as unknown as ToolWithHandler[];
  return delegateTool;
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    json: () => Promise.resolve(body),
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionManagerFake.getSessionCwd.mockReturnValue('/workspace/project');
  sessionManagerFake.isBusy.mockReturnValue(false);
  dispatchStateFake.getCorrelationId.mockReturnValue('corr-456');
  dispatchStateFake.waitForActive.mockResolvedValue('idle');
  storageFake.getSessionMeta.mockReturnValue({ name: 'delegate' });
  historyFake.getLastAssistantMessage.mockResolvedValue('delegate finished');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('caco_session_delegate handler validation', () => {
  it('rejects delegating to the caller session before sending', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await tool().handler({ prompts: [{ sessionId: 'caco-session:caller-session-0001', message: 'review this' }] });

    expect(out).toMatchObject({ resultType: 'error', textResultForLlm: 'Cannot delegate to yourself.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing target with the actionable target error', async () => {
    sessionManagerFake.getSessionCwd.mockReturnValue(undefined);
    storageFake.getSessionMeta.mockReturnValue(undefined);

    const out = await tool().handler({ prompts: [{ sessionId: 'missing-session-0002', message: 'review this' }] });

    expect(out.resultType).toBe('error');
    expect(out.textResultForLlm).toContain('does not exist');
    expect(out.textResultForLlm).toContain('create_caco_session');
  });

  it('rejects a busy loaded target before sending', async () => {
    sessionManagerFake.isBusy.mockReturnValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await tool().handler({ prompts: [{ sessionId: 'target-session-0003', message: 'review this' }] });

    expect(out.resultType).toBe('error');
    expect(out.textResultForLlm).toContain('busy processing');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('caco_session_delegate handler orchestration', () => {
  it('sends an agent message, waits for idle, and returns the last assistant response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await tool().handler({ prompts: [{ sessionId: 'caco-session:target-session-0003', message: 'review this' }] });
    const results = JSON.parse(out.textResultForLlm) as Array<{ sessionId: string; response: string }>;

    expect(out.resultType).toBe('text');
    expect(results).toEqual([{ sessionId: 'target-session-0003', response: 'delegate finished' }]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/sessions/target-session-0003/messages'), expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        prompt: 'review this',
        source: 'agent',
        fromSession: 'caller-session-0001',
        correlationId: 'corr-456',
      }),
    }));
    expect(dispatchStateFake.waitForActive).toHaveBeenCalledWith('target-session-0003', expect.objectContaining({
      idleTimeoutMs: 900000,
      maxTotalMs: 3600000,
      isGone: expect.any(Function),
    }));
    expect(historyFake.getLastAssistantMessage).toHaveBeenCalledWith('target-session-0003');
  });

  it('returns send failures without waiting for idle', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'route rejected' }, false, 400));
    vi.stubGlobal('fetch', fetchMock);

    const out = await tool().handler({ prompts: [{ sessionId: 'target-session-0003', message: 'review this' }] });
    const results = JSON.parse(out.textResultForLlm) as Array<{ response: string }>;

    expect(results[0].response).toBe('(send failed: HTTP 400 — route rejected)');
    expect(dispatchStateFake.waitForActive).not.toHaveBeenCalled();
  });

  it('reports a fetch exception as a send failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const out = await tool().handler({ prompts: [{ sessionId: 'target-session-0003', message: 'review this' }] });
    const results = JSON.parse(out.textResultForLlm) as Array<{ response: string }>;

    expect(results[0].response).toBe('(send failed: network down)');
    expect(dispatchStateFake.waitForActive).not.toHaveBeenCalled();
  });

  it('reports gone and timeout wait results without hanging timers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    dispatchStateFake.waitForActive
      .mockResolvedValueOnce('gone')
      .mockResolvedValueOnce('timeout');

    const gone = await tool().handler({ prompts: [{ sessionId: 'target-session-0003', message: 'review this' }] });
    const timedOut = await tool().handler({ prompts: [{ sessionId: 'target-session-0004', message: 'review that' }] });
    const goneResults = JSON.parse(gone.textResultForLlm) as Array<{ response: string }>;
    const timeoutResults = JSON.parse(timedOut.textResultForLlm) as Array<{ response: string }>;

    expect(goneResults[0].response).toBe('(session disappeared during processing)');
    expect(timeoutResults[0].response).toContain('delegate still running after 15m idle timeout');
  });

  it('uses the wait isGone predicate to reflect unloaded targets', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await tool().handler({ prompts: [{ sessionId: 'target-session-0003', message: 'review this' }] });
    const [, waitOptions] = dispatchStateFake.waitForActive.mock.calls[0];

    sessionManagerFake.getSessionCwd.mockReturnValue(undefined);
    expect(waitOptions.isGone()).toBe(true);
  });
});
