import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionManagerFake = vi.hoisted(() => ({
  getSessionCwd: vi.fn<(sessionId: string) => string | undefined>(),
  isBusy: vi.fn<(sessionId: string) => boolean>(),
  getDispatchLineage: vi.fn<(sessionId: string) => { depth: number; peerOrigin: boolean; turnId: string } | undefined>(),
}));

const peerFake = vi.hoisted(() => ({
  resolve: vi.fn(),
  preflight: vi.fn(),
  send: vi.fn(),
  wait: vi.fn(),
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
vi.mock('../../src/peer-target.js', async (orig) => ({
  ...(await orig<typeof import('../../src/peer-target.js')>()),
  resolvePeerTargetFresh: peerFake.resolve,
}));
vi.mock('../../src/peer-delegate.js', () => ({ peerPreflight: peerFake.preflight, peerSend: peerFake.send, peerWaitReply: peerFake.wait }));

import { createDelegateTool } from '../../src/delegate-tool.js';
import type { SessionIdRef } from '../../src/types.js';

interface WaitOptions {
  idleTimeoutMs: number;
  maxTotalMs: number;
  isGone: () => boolean;
}

interface DelegatePrompt {
  pluginDirectories?: string[];
  // Optional so a dropped-key call is expressible here — the whole point of the
  // fix is that the SCHEMA no longer rejects it before the handler can report it
  // (spec-delegate-arg-integrity). Re-tightening the schema breaks these tests.
  sessionId?: string;
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
  sessionManagerFake.getDispatchLineage.mockReturnValue(undefined);
  peerFake.resolve.mockImplementation(async (raw: string) => {
    const cut = raw.lastIndexOf(':');
    return cut < 0
      ? { kind: 'local', sessionId: raw }
      : { kind: 'peer', sessionId: raw.slice(cut + 1), peer: { origin: 'http://localhost:53001', name: 'devbox', id: raw.slice(0, cut) } };
  });
  peerFake.preflight.mockResolvedValue(null);
  peerFake.send.mockResolvedValue({ token: 'turn-1' });
  peerFake.wait.mockResolvedValue('peer finished');
});

describe('caco_session_delegate to a peer (spec-peer-session-tools)', () => {
  it('mixes a local and a peer target and returns both replies in order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await tool().handler({ prompts: [
      { sessionId: 'target-session-0003', message: 'local work' },
      { sessionId: 'dev-id:remote-session-9', message: 'remote work' },
    ] });
    expect(JSON.parse(out.textResultForLlm)).toEqual([
      { sessionId: 'target-session-0003', response: 'delegate finished' },
      { sessionId: 'dev-id:remote-session-9', response: 'peer finished' },
    ]);
    const devbox = { origin: 'http://localhost:53001', name: 'devbox', id: 'dev-id' };
    expect(peerFake.preflight).toHaveBeenCalledWith(devbox, 'remote-session-9');
    expect(peerFake.send).toHaveBeenCalledWith(devbox, 'remote-session-9', 'remote work', 'caller-session-0001');
    expect(peerFake.wait).toHaveBeenCalledWith(devbox, 'remote-session-9', 'turn-1', { maxTotalMs: 3600000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops before sending anything when a peer preflight fails', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    peerFake.preflight.mockResolvedValue('devbox runs an older Caco; update it first.');
    const out = await tool().handler({ prompts: [{ sessionId: 'target-session-0003', message: 'a' }, { sessionId: 'dev-id:r', message: 'b' }] });
    expect(out).toEqual({ resultType: 'error', textResultForLlm: 'devbox runs an older Caco; update it first.' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(peerFake.send).not.toHaveBeenCalled();
  });

  it('returns a failed peer send as that target\'s result without waiting', async () => {
    peerFake.send.mockResolvedValue({ error: '(send failed: HTTP 409 - herd child)' });
    const out = await tool().handler({ prompts: [{ sessionId: 'dev-id:r', message: 'b' }] });
    expect(JSON.parse(out.textResultForLlm)).toEqual([{ sessionId: 'dev-id:r', response: '(send failed: HTTP 409 - herd child)' }]);
    expect(peerFake.wait).not.toHaveBeenCalled();
  });

  it('refuses peer targets from a peer-rooted turn, pluginDirectories, and resolver errors', async () => {
    sessionManagerFake.getDispatchLineage.mockReturnValue({ depth: 1, peerOrigin: true, turnId: 't' });
    expect((await tool().handler({ prompts: [{ sessionId: 'dev-id:r', message: 'b' }] })).textResultForLlm)
      .toBe('This turn started from another machine, so it cannot reach other machines.');
    sessionManagerFake.getDispatchLineage.mockReturnValue(undefined);
    expect((await tool().handler({ prompts: [{ sessionId: 'dev-id:r', message: 'b', pluginDirectories: ['/x'] } as DelegatePrompt] })).textResultForLlm)
      .toBe('pluginDirectories is local only.');
    peerFake.resolve.mockResolvedValueOnce({ kind: 'error', error: 'Unknown instance "zz". Run caco_sessions_overview to list instances.' });
    expect((await tool().handler({ prompts: [{ sessionId: 'zz:r', message: 'b' }] })).textResultForLlm).toContain('Unknown instance');
    expect(peerFake.send).not.toHaveBeenCalled();
  });

  it('a peer-rooted turn may still delegate locally', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
    sessionManagerFake.getDispatchLineage.mockReturnValue({ depth: 1, peerOrigin: true, turnId: 't' });
    const out = await tool().handler({ prompts: [{ sessionId: 'target-session-0003', message: 'a' }] });
    expect(out.resultType).toBe('text');
  });
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

describe('caco_session_delegate incomplete arguments', () => {
  it('reports a dropped sessionId actionably instead of failing opaquely', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // Exactly the shape observed in the incident: message present, sessionId gone.
    const out = await tool().handler({ prompts: [{ message: 'review this' }] });

    expect(out.resultType).toBe('error');
    expect(out.textResultForLlm).toContain('prompts[0]');
    expect(out.textResultForLlm).toMatch(/re-send/i);
    expect(out.textResultForLlm).not.toMatch(/does not exist|not loaded/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses the WHOLE batch when any entry is unaddressable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await tool().handler({ prompts: [
      { sessionId: 'good-session-0002', message: 'valid' },
      { message: 'no target' },
    ] });

    expect(out.resultType).toBe('error');
    expect(out.textResultForLlm).toContain('prompts[1]');
    // Partial delivery would leave the caller blocking on a reply it never asked
    // for, so the valid entry must NOT be sent either.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a blank sessionId as missing rather than looking it up', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    storageFake.getSessionMeta.mockReturnValue(undefined);

    const out = await tool().handler({ prompts: [{ sessionId: '   ', message: 'hi' }] });

    expect(out.textResultForLlm).toContain('prompts[0]');
    expect(out.textResultForLlm).not.toMatch(/does not exist/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('caco_session_delegate prefix-only target', () => {
  it('treats a prefix-only sessionId as missing, not as a lookup for the empty id', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    storageFake.getSessionMeta.mockReturnValue(undefined);

    const out = await tool().handler({ prompts: [{ sessionId: 'caco-session:', message: 'hi' }] });

    expect(out.resultType).toBe('error');
    expect(out.textResultForLlm).toContain('prompts[0]');
    expect(out.textResultForLlm).not.toMatch(/does not exist/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
