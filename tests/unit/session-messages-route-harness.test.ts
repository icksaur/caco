import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

const routeMocks = vi.hoisted(() => {
  const sessionManager = {
    getSessionCwd: vi.fn((_sessionId: string): string | null => '/tmp/caco-test-cwd'),
    isBusy: vi.fn(() => false),
    cancelSession: vi.fn(async () => ({ forced: false })),
    resetAutoContinue: vi.fn(),
    sendStream: vi.fn(async () => {}),
    checkAgentCall: vi.fn((_correlationId: string, _sessionId: string): { allowed: boolean; reason?: string } => ({ allowed: true })),
    isActive: vi.fn(() => true),
    resume: vi.fn(async () => {}),
    recordAgentCall: vi.fn(),
    getPendingTools: vi.fn((): string[] => []),
    getAutoContinueAttempts: vi.fn(() => 0),
    enableTools: vi.fn(async () => {}),
    clearPendingTools: vi.fn(),
    markContinuationInFlight: vi.fn(),
    clearContinuationInFlight: vi.fn(),
    bumpAutoContinueAttempts: vi.fn(),
    hasPendingAutoContinue: vi.fn(() => false),
    pollQuota: vi.fn(async () => {}),
    getModels: vi.fn((): unknown[] => []),
    ensureClientHealthy: vi.fn(async () => {}),
    getSession: vi.fn(() => null),
    startDispatch: vi.fn(),
    endDispatch: vi.fn(),
    getDispatchDepth: vi.fn((_sessionId: string): number | undefined => 1),
    getRevealDepth: vi.fn((_sessionId: string): number => 1),
  };
  return {
    sessionManager,
    setAutoContinuePrefProvider: vi.fn(),
    broadcastEvent: vi.fn(),
    broadcastGlobalEvent: vi.fn(),
    getLastAssistantMessage: vi.fn(async (_sessionId: string) => 'last response'),
    handleSessionIdle: vi.fn((_sessionId: string, _options: unknown, _deps: unknown): void => undefined),
    idleFeedAppend: vi.fn(),
    maybeAutoContinue: vi.fn(async (_sessionId: string, _deps: unknown): Promise<boolean> => false),
    updateSessionMeta: vi.fn((_sessionId: string, updater: (meta: { responseOptions?: object }) => void): boolean => {
      updater({ responseOptions: {} });
      return true;
    }),
  };
});

vi.mock('../../src/session-manager.js', () => ({ sessionManager: routeMocks.sessionManager, setAutoContinuePrefProvider: routeMocks.setAutoContinuePrefProvider }));
vi.mock('../../src/session-state.js', () => ({ sessionState: { preferences: {}, getSessionConfig: vi.fn(() => ({})) } }));
vi.mock('../../src/applet-state.js', () => ({ setAppletUserState: vi.fn(), setAppletNavigation: vi.fn() }));
vi.mock('../../src/image-utils.js', () => ({ parseImageDataUrl: vi.fn(() => null) }));
vi.mock('../../src/routes/websocket.js', () => ({ broadcastEvent: routeMocks.broadcastEvent, broadcastGlobalEvent: routeMocks.broadcastGlobalEvent }));
vi.mock('../../src/storage.js', () => ({ getSessionMeta: vi.fn(() => null), updateSessionMeta: routeMocks.updateSessionMeta }));
vi.mock('../../src/unobserved-tracker.js', () => ({ unobservedTracker: { markIdle: vi.fn() } }));
vi.mock('../../src/config.js', () => ({ DISPATCH_TIMEOUT_MS: 1000, AGENT_MAX_DEPTH: 3 }));
vi.mock('../../src/message-source.js', () => ({ prefixMessageSource: vi.fn((source: string, id: string, text: string) => `[${source}:${id}] ${text}`) }));
vi.mock('../../src/dispatch-watchdog.js', () => ({ createWatchdog: vi.fn(() => ({ cancel: vi.fn() })) }));
vi.mock('../../src/dispatch-state.js', () => ({ dispatchState: { signalIdle: vi.fn(), waitForIdle: vi.fn(async () => 'timeout'), getCorrelationId: vi.fn() } }));
vi.mock('../../src/dispatch-retry.js', () => ({ retryWithFreshClient: vi.fn() }));
vi.mock('../../src/dispatch-events.js', () => ({ applyDispatchEventEffects: vi.fn() }));
vi.mock('../../src/session-throughput.js', () => ({ resetRequest: vi.fn(), snapshot: vi.fn(() => ({})), markRequestComplete: vi.fn(() => null) }));
vi.mock('../../src/request-metrics-log.js', () => ({ appendRequestMetrics: vi.fn() }));
vi.mock('../../src/usage-metrics.js', () => ({ buildUsageRecord: vi.fn(() => ({})), emitUsageRecord: vi.fn(), resolveUsageRates: vi.fn(() => null) }));
vi.mock('../../src/model-billing.js', () => ({ modelCostSummary: vi.fn(() => ({})) }));
vi.mock('../../src/auto-continue-runtime.js', () => ({ maybeAutoContinue: routeMocks.maybeAutoContinue, AUTOCONTINUE_IDENTIFIER: 'auto', AUTO_CONTINUE_CAP: 3 }));
vi.mock('../../src/preferences.js', () => ({ isAutoContinueEnabled: vi.fn(() => false) }));
vi.mock('../../src/herd-runtime.js', () => ({ onSessionIdle: vi.fn() }));
vi.mock('../../src/idle-authority.js', () => ({ handleSessionIdle: routeMocks.handleSessionIdle }));
vi.mock('../../src/session-history.js', () => ({ getLastAssistantMessage: routeMocks.getLastAssistantMessage }));
vi.mock('../../src/idle-feed.js', () => ({ idleFeed: { append: routeMocks.idleFeedAppend } }));

let server: Server;
let base: string;
let handleIdle: (sessionId: string, needsObservation: boolean, correlationId?: string) => void;

beforeAll(async () => {
  const mod = await import('../../src/routes/session-messages.js');
  handleIdle = mod.handleIdle;
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => { server?.close(); });

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.sessionManager.getSessionCwd.mockReturnValue('/tmp/caco-test-cwd');
  routeMocks.sessionManager.isBusy.mockReturnValue(false);
  routeMocks.sessionManager.cancelSession.mockResolvedValue({ forced: false });
  routeMocks.updateSessionMeta.mockImplementation((_sessionId: string, updater: (meta: { responseOptions?: object }) => void) => { updater({ responseOptions: {} }); return true; });
  routeMocks.handleSessionIdle.mockImplementation((_sessionId: string, _options: unknown, _deps: unknown) => undefined);
  routeMocks.maybeAutoContinue.mockResolvedValue(false);
  routeMocks.sessionManager.getDispatchDepth.mockReturnValue(1);
});

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

describe('session messages route harness', () => {
  it('400s messages with a missing prompt before touching the session manager', async () => {
    const res = await postJson('/sessions/s1/messages', {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'prompt is required' });
    expect(routeMocks.sessionManager.resetAutoContinue).not.toHaveBeenCalled();
    expect(routeMocks.sessionManager.getSessionCwd).not.toHaveBeenCalled();
  });

  it('400s agent-initiated messages that omit correlationId', async () => {
    const res = await postJson('/sessions/s1/messages', { prompt: 'hi', source: 'agent', fromSession: 'agent-source' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'correlationId required for agent-initiated calls' });
    expect(routeMocks.sessionManager.resetAutoContinue).not.toHaveBeenCalled();
  });

  it('400s a fromSession without source:agent (biconditional contract)', async () => {
    const res = await postJson('/sessions/s1/messages', { prompt: 'hi', fromSession: 'agent-source', correlationId: 'c1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "source:'agent' requires fromSession, and fromSession requires source:'agent'" });
  });

  it('400s source:agent without a fromSession (biconditional contract)', async () => {
    const res = await postJson('/sessions/s1/messages', { prompt: 'hi', source: 'agent', correlationId: 'c1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "source:'agent' requires fromSession, and fromSession requires source:'agent'" });
  });

  it('404s when the session cwd lookup misses', async () => {
    routeMocks.sessionManager.getSessionCwd.mockReturnValue(null);
    const res = await postJson('/sessions/missing/messages', { prompt: 'hi' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Session not found: missing' });
    expect(routeMocks.sessionManager.resetAutoContinue).toHaveBeenCalledWith('missing');
  });

  it('403s immediate steering from agent sources', async () => {
    const res = await postJson('/sessions/s1/messages', { prompt: 'steer', source: 'agent', mode: 'immediate' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Steering is only available for user input' });
    expect(routeMocks.sessionManager.getSessionCwd).toHaveBeenCalledWith('s1');
    expect(routeMocks.sessionManager.isBusy).not.toHaveBeenCalled();
  });

  it('400s immediate steering when the session is not busy', async () => {
    const res = await postJson('/sessions/s1/messages', { prompt: 'steer', mode: 'immediate' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Cannot steer: session is not busy' });
    expect(routeMocks.sessionManager.isBusy).toHaveBeenCalledWith('s1');
    expect(routeMocks.sessionManager.sendStream).not.toHaveBeenCalled();
  });

  it('accepts immediate steering when the user steers a busy session', async () => {
    routeMocks.sessionManager.isBusy.mockReturnValue(true);
    const res = await postJson('/sessions/s1/messages', { prompt: 'steer now', mode: 'immediate' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionId: 's1', steered: true });
    expect(routeMocks.sessionManager.sendStream).toHaveBeenCalledWith('s1', 'steer now', { mode: 'immediate' });
    expect(routeMocks.broadcastEvent).toHaveBeenCalledWith('s1', { type: 'user.message', data: { content: 'steer now' } });
  });

  it('500s immediate steering when sendStream rejects', async () => {
    routeMocks.sessionManager.isBusy.mockReturnValue(true);
    routeMocks.sessionManager.sendStream.mockRejectedValueOnce(new Error('stream refused'));
    const res = await postJson('/sessions/s1/messages', { prompt: 'steer now', mode: 'immediate' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Steer failed: stream refused' });
  });

  it('409s non-immediate messages while the session is busy', async () => {
    routeMocks.sessionManager.isBusy.mockReturnValue(true);
    const res = await postJson('/sessions/s1/messages', { prompt: 'hi' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Session is busy processing another message', code: 'SESSION_BUSY' });
  });

  it('400s an agent self-post before dispatch', async () => {
    const res = await postJson('/sessions/s1/messages', { prompt: 'loop', source: 'agent', fromSession: 's1', correlationId: 'corr-1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Cannot post to own session' });
  });

  it('400s when the agent-call runaway guard rejects the correlation', async () => {
    routeMocks.sessionManager.checkAgentCall.mockReturnValueOnce({ allowed: false, reason: 'too many calls' });
    const res = await postJson('/sessions/s2/messages', { prompt: 'relay', source: 'agent', fromSession: 's1', correlationId: 'corr-1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Agent call rejected: too many calls' });
    expect(routeMocks.sessionManager.checkAgentCall).toHaveBeenCalledWith('corr-1', 's2');
  });

  describe('hop-count depth (spec-herd-depth-breadth)', () => {
    it('fan-out: an agent call from a depth-1 caller dispatches the child at depth 2', async () => {
      routeMocks.sessionManager.getDispatchDepth.mockReturnValue(1);
      const res = await postJson('/sessions/child-a/messages', { prompt: 'work', source: 'agent', fromSession: 'parent', correlationId: 'corr-1' });
      expect(res.status).toBe(200);
      expect(routeMocks.sessionManager.getDispatchDepth).toHaveBeenCalledWith('parent');
      expect(routeMocks.sessionManager.startDispatch).toHaveBeenCalledWith('child-a', expect.any(String), 2);
    });

    it('fan-out is flat: a second child from the same depth-1 caller is also depth 2', async () => {
      routeMocks.sessionManager.getDispatchDepth.mockReturnValue(1);
      await postJson('/sessions/child-a/messages', { prompt: 'work', source: 'agent', fromSession: 'parent', correlationId: 'corr-1' });
      await postJson('/sessions/child-b/messages', { prompt: 'work', source: 'agent', fromSession: 'parent', correlationId: 'corr-1' });
      expect(routeMocks.sessionManager.startDispatch).toHaveBeenCalledWith('child-b', expect.any(String), 2);
    });

    it('nesting: a depth-2 caller pushes its child to depth 3 (allowed at max 3)', async () => {
      routeMocks.sessionManager.getDispatchDepth.mockReturnValue(2);
      const res = await postJson('/sessions/grandchild/messages', { prompt: 'work', source: 'agent', fromSession: 'child', correlationId: 'corr-1' });
      expect(res.status).toBe(200);
      expect(routeMocks.sessionManager.startDispatch).toHaveBeenCalledWith('grandchild', expect.any(String), 3);
    });

    it('nesting: a depth-3 caller pushes past the limit and is rejected', async () => {
      routeMocks.sessionManager.getDispatchDepth.mockReturnValue(3);
      const res = await postJson('/sessions/too-deep/messages', { prompt: 'work', source: 'agent', fromSession: 'deep-caller', correlationId: 'corr-1' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Agent call rejected: Effective call depth 4 exceeds limit (max 3)' });
      expect(routeMocks.sessionManager.startDispatch).not.toHaveBeenCalled();
    });

    it('absent/idle caller: an agent call whose caller has no live dispatch is rejected', async () => {
      routeMocks.sessionManager.getDispatchDepth.mockReturnValue(undefined);
      const res = await postJson('/sessions/s2/messages', { prompt: 'work', source: 'agent', fromSession: 'idle-parent', correlationId: 'corr-1' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Agent call rejected: caller has no active dispatch' });
      expect(routeMocks.sessionManager.startDispatch).not.toHaveBeenCalled();
    });

    it('wake-pop: a source:system wake is a root at depth 1 regardless of any child depth', async () => {
      const res = await postJson('/sessions/parent/messages', { prompt: 'your herd needs attention', source: 'system' });
      expect(res.status).toBe(200);
      expect(routeMocks.sessionManager.getDispatchDepth).not.toHaveBeenCalled();
      expect(routeMocks.sessionManager.startDispatch).toHaveBeenCalledWith('parent', expect.any(String), 1);
    });

    it('root: a plain user message dispatches at depth 1', async () => {
      const res = await postJson('/sessions/s1/messages', { prompt: 'hello' });
      expect(res.status).toBe(200);
      expect(routeMocks.sessionManager.startDispatch).toHaveBeenCalledWith('s1', expect.any(String), 1);
    });
  });

  it('reaches only the no-session dispatch teardown path for a normal message', async () => {
    routeMocks.sessionManager.getSession.mockReturnValueOnce(null);
    const res = await postJson('/sessions/s1/messages', { prompt: 'dispatch then stop' }, { 'x-request-id': 'req-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sessionId: 's1' });
    expect(routeMocks.sessionManager.startDispatch).toHaveBeenCalledWith('s1', expect.any(String), 1);
    expect(routeMocks.sessionManager.endDispatch).toHaveBeenCalledWith('s1');
    expect(routeMocks.broadcastEvent).toHaveBeenCalledWith('s1', { type: 'session.error', data: { message: 'No active session' } });
    expect(routeMocks.broadcastGlobalEvent).toHaveBeenCalledWith({ type: 'session.busy', data: { sessionId: 's1', isBusy: false } });
  });

  it('wires idle authority dependencies without starting a message dispatch', async () => {
    routeMocks.handleSessionIdle.mockImplementation((_sessionId: string, _options: unknown, rawDeps: unknown) => {
      const deps = rawDeps as { hasPendingAutoContinue: (id: string) => boolean; pendingToolCount: (id: string) => number; runAutoContinue: (id: string) => Promise<boolean>; markIdle: (id: string) => void; herdOnSessionIdle: (id: string) => void; pollQuota: () => void; signalDispatchIdle: (id: string) => void; notifyExternalIdle: (id: string) => void };
      expect(deps.hasPendingAutoContinue('s1')).toBe(false);
      expect(deps.pendingToolCount('s1')).toBe(0);
      deps.markIdle('s1'); deps.herdOnSessionIdle('s1'); deps.pollQuota(); deps.signalDispatchIdle('s1'); deps.notifyExternalIdle('s1');
      void deps.runAutoContinue('s1');
    });
    routeMocks.maybeAutoContinue.mockImplementationOnce(async (_sessionId: string, rawDeps: unknown) => {
      const deps = rawDeps as { getPendingTools: (id: string) => string[]; getAttempts: (id: string) => number; isBusy: (id: string) => boolean; reassert: (id: string, tools: string[]) => Promise<void>; clearPendingTools: (id: string) => void; markContinuing: (id: string) => void; clearContinuing: (id: string) => void; bumpAttempts: (id: string) => void; emitSystem: (id: string, text: string) => void; enabled: () => boolean };
      expect(deps.getPendingTools('s1')).toEqual([]);
      expect(deps.getAttempts('s1')).toBe(0);
      expect(deps.isBusy('s1')).toBe(false);
      await deps.reassert('s1', ['tool-a']);
      deps.clearPendingTools('s1'); deps.markContinuing('s1'); deps.clearContinuing('s1'); deps.bumpAttempts('s1'); deps.emitSystem('s1', 'continuing');
      expect(deps.enabled()).toBe(false);
      return false;
    });
    handleIdle('s1', true, 'corr-1');
    await vi.waitFor(() => { expect(routeMocks.idleFeedAppend).toHaveBeenCalledWith('s1', 'last response', 'interactive', 'corr-1'); });
    expect(routeMocks.maybeAutoContinue).toHaveBeenCalled();
    expect(routeMocks.broadcastEvent).toHaveBeenCalledWith('s1', { type: 'session.info', data: { message: 'continuing' } });
  });

  it('returns cancel success without a forced busy broadcast when cancelSession is not forced', async () => {
    const res = await postJson('/sessions/s1/cancel', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, forced: false });
    expect(routeMocks.updateSessionMeta).toHaveBeenCalledWith('s1', expect.any(Function), { createIfMissing: false });
    expect(routeMocks.sessionManager.cancelSession).toHaveBeenCalledWith('s1');
    expect(routeMocks.broadcastGlobalEvent).not.toHaveBeenCalled();
  });

  it('broadcasts idle state when cancelSession force-clears a dispatch', async () => {
    routeMocks.sessionManager.cancelSession.mockResolvedValue({ forced: true });
    const res = await postJson('/sessions/s1/cancel', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, forced: true });
    expect(routeMocks.broadcastGlobalEvent).toHaveBeenCalledWith({ type: 'session.busy', data: { sessionId: 's1', isBusy: false } });
  });
});
