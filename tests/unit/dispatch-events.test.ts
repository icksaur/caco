/**
 * Tests for src/dispatch-events.ts
 *
 * Verifies the event → side-effect mapping. Side effects target module-level
 * stores; tests use vi.mock to intercept and assert on the calls.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const setSessionIntent = vi.fn();
const updateUsage = vi.fn(() => ({ changed: false }));
const getUsage = vi.fn((): unknown => null);
const shouldEmitReload = vi.fn();
const consumeReloadSignal = vi.fn();
const broadcastGlobalEvent = vi.fn();
const recordUsage = vi.fn();
const recordRateLimit = vi.fn();
const recordToolCall = vi.fn();
const snapshotMock = vi.fn(() => ({ requestIn: 0, requestCache: 0, requestOut: 0, totalIn: 0, totalCache: 0, totalOut: 0, rateLimitCount: 0, updatedAt: 'now', known: true }));

vi.mock('../../src/session-meta-store.js', () => ({
  setSessionIntent: (...args: unknown[]) => setSessionIntent(...args),
}));
vi.mock('../../src/usage-state.js', () => ({
  updateUsage: (...args: unknown[]) => updateUsage(...(args as [])),
  getUsage: (...args: unknown[]) => getUsage(...(args as [])),
}));
vi.mock('../../src/routes/websocket.js', () => ({
  broadcastGlobalEvent: (...args: unknown[]) => broadcastGlobalEvent(...(args as [never])),
}));
vi.mock('../../src/sdk-event-parser.js', () => ({
  shouldEmitReload: (...args: unknown[]) => shouldEmitReload(...args),
}));
vi.mock('../../src/applet-state.js', () => ({
  consumeReloadSignal: (...args: unknown[]) => consumeReloadSignal(...args),
}));
vi.mock('../../src/session-throughput.js', () => ({
  recordUsage: (...args: unknown[]) => recordUsage(...(args as [])),
  recordRateLimit: (...args: unknown[]) => recordRateLimit(...(args as [])),
  recordToolCall: (...args: unknown[]) => recordToolCall(...(args as [])),
  snapshot: (...args: unknown[]) => snapshotMock(...(args as [])),
}));

import { applyDispatchEventEffects, setGitEditPoller } from '../../src/dispatch-events.js';

const SID = 'session-1';

function makeDeps() {
  return {
    autoAddFileContext: vi.fn(),
    onEvent: vi.fn(),
  };
}

beforeEach(() => {
  setSessionIntent.mockClear();
  updateUsage.mockClear();
  updateUsage.mockReturnValue({ changed: false });
  getUsage.mockClear();
  getUsage.mockReturnValue(null);
  shouldEmitReload.mockReset();
  consumeReloadSignal.mockReset();
  broadcastGlobalEvent.mockClear();
  recordUsage.mockClear();
  recordRateLimit.mockClear();
  recordToolCall.mockClear();
  snapshotMock.mockClear();
  setGitEditPoller(null);
});

describe('applyDispatchEventEffects', () => {
  it('captures intent from assistant.intent', () => {
    const deps = makeDeps();
    applyDispatchEventEffects(SID, { type: 'assistant.intent', data: { intent: 'fix the bug' } } as never, deps);
    expect(setSessionIntent).toHaveBeenCalledWith(SID, 'fix the bug');
  });

  it('captures intent from report_intent tool calls', () => {
    const deps = makeDeps();
    applyDispatchEventEffects(SID, {
      type: 'tool.execution_start',
      data: { toolName: 'report_intent', arguments: { intent: 'researching' } },
    } as never, deps);
    expect(setSessionIntent).toHaveBeenCalledWith(SID, 'researching');
  });

  it('auto-adds file context for create tool', () => {
    const deps = makeDeps();
    applyDispatchEventEffects(SID, {
      type: 'tool.execution_start',
      data: { toolName: 'create', arguments: { path: '/tmp/foo.ts' } },
    } as never, deps);
    expect(deps.autoAddFileContext).toHaveBeenCalledWith(SID, '/tmp/foo.ts');
  });

  it('auto-adds file context for edit tool', () => {
    const deps = makeDeps();
    applyDispatchEventEffects(SID, {
      type: 'tool.execution_start',
      data: { toolName: 'edit', arguments: { path: '/tmp/bar.ts' } },
    } as never, deps);
    expect(deps.autoAddFileContext).toHaveBeenCalledWith(SID, '/tmp/bar.ts');
  });

  it('does NOT auto-add file context for non-modifying tools', () => {
    const deps = makeDeps();
    applyDispatchEventEffects(SID, {
      type: 'tool.execution_start',
      data: { toolName: 'view', arguments: { path: '/tmp/baz.ts' } },
    } as never, deps);
    expect(deps.autoAddFileContext).not.toHaveBeenCalled();
  });

  it('passes quotaSnapshots from assistant.usage', () => {
    const deps = makeDeps();
    const snapshots = { 'claude-sonnet': { isUnlimitedEntitlement: false, entitlementRequests: 100, usedRequests: 10, remainingPercentage: 90 } };
    applyDispatchEventEffects(SID, { type: 'assistant.usage', data: { quotaSnapshots: snapshots } } as never, deps);
    expect(updateUsage).toHaveBeenCalledWith(snapshots);
  });

  it('broadcasts caco.usage globally when usage changed', () => {
    const deps = makeDeps();
    const usage = { remainingPercentage: 90, isUnlimited: false, updatedAt: 'now' };
    updateUsage.mockReturnValue({ changed: true });
    getUsage.mockReturnValue(usage as never);
    applyDispatchEventEffects(SID, { type: 'assistant.usage', data: { quotaSnapshots: {} } } as never, deps);
    expect(broadcastGlobalEvent).toHaveBeenCalledWith({ type: 'caco.usage', data: { ...usage } });
  });

  it('does NOT broadcast caco.usage when unchanged', () => {
    const deps = makeDeps();
    updateUsage.mockReturnValue({ changed: false });
    applyDispatchEventEffects(SID, { type: 'assistant.usage', data: { quotaSnapshots: {} } } as never, deps);
    expect(broadcastGlobalEvent).not.toHaveBeenCalled();
  });

  it('emits caco.reload when reload is signalled', () => {
    shouldEmitReload.mockReturnValue(true);
    consumeReloadSignal.mockReturnValue(true);
    const deps = makeDeps();
    applyDispatchEventEffects(SID, { type: 'tool.execution_complete', data: {} } as never, deps);
    expect(deps.onEvent).toHaveBeenCalledWith({ type: 'caco.reload', data: {} });
  });

  it('does NOT emit caco.reload when signal absent', () => {
    shouldEmitReload.mockReturnValue(true);
    consumeReloadSignal.mockReturnValue(false);
    const deps = makeDeps();
    applyDispatchEventEffects(SID, { type: 'tool.execution_complete', data: {} } as never, deps);
    expect(deps.onEvent).not.toHaveBeenCalled();
  });

  it('does NOT emit caco.reload for non-reload-triggering events', () => {
    shouldEmitReload.mockReturnValue(false);
    const deps = makeDeps();
    applyDispatchEventEffects(SID, { type: 'assistant.message', data: {} } as never, deps);
    expect(consumeReloadSignal).not.toHaveBeenCalled();
    expect(deps.onEvent).not.toHaveBeenCalled();
  });

  it('ignores irrelevant events without side effects', () => {
    const deps = makeDeps();
    applyDispatchEventEffects(SID, { type: 'assistant.message', data: { content: 'hi' } } as never, deps);
    expect(setSessionIntent).not.toHaveBeenCalled();
    expect(updateUsage).not.toHaveBeenCalled();
    expect(deps.autoAddFileContext).not.toHaveBeenCalled();
    expect(deps.onEvent).not.toHaveBeenCalled();
  });

  describe('file-edits polling', () => {
    it('triggers file-edits polling after successful apply_patch completion', () => {
      const deps = makeDeps();
      const triggerPoll = vi.fn();
      setGitEditPoller({ triggerPoll } as never);

      applyDispatchEventEffects(SID, {
        type: 'tool.execution_complete',
        data: { toolName: 'apply_patch', success: true },
      } as never, deps);

      expect(triggerPoll).toHaveBeenCalledWith(SID, 'event');
    });

    it('does not trigger file-edits polling after failed apply_patch completion', () => {
      const deps = makeDeps();
      const triggerPoll = vi.fn();
      setGitEditPoller({ triggerPoll } as never);

      applyDispatchEventEffects(SID, {
        type: 'tool.execution_complete',
        data: { toolName: 'apply_patch', success: false },
      } as never, deps);

      expect(triggerPoll).not.toHaveBeenCalled();
    });
  });

  describe('round-trip metrics: tool calls', () => {
    it('records a successful tool completion as a non-failed call', () => {
      const deps = makeDeps();
      applyDispatchEventEffects(SID, {
        type: 'tool.execution_complete',
        data: { toolName: 'grep', success: true },
      } as never, deps);
      expect(recordToolCall).toHaveBeenCalledWith(SID, false);
    });

    it('records a failed tool completion as a failed call', () => {
      const deps = makeDeps();
      applyDispatchEventEffects(SID, {
        type: 'tool.execution_complete',
        data: { toolName: 'grep', success: false },
      } as never, deps);
      expect(recordToolCall).toHaveBeenCalledWith(SID, true);
    });
  });

  describe('throughput: assistant.usage', () => {
    it('records token usage from data-wrapped event (history format)', () => {
      const deps = makeDeps();
      applyDispatchEventEffects(SID, {
        type: 'assistant.usage',
        data: { inputTokens: 1000, outputTokens: 500 },
      } as never, deps);
      expect(recordUsage).toHaveBeenCalledWith(SID, { inputTokens: 1000, outputTokens: 500 });
    });

    it('records token usage from root-shaped event (live format)', () => {
      const deps = makeDeps();
      applyDispatchEventEffects(SID, {
        type: 'assistant.usage',
        inputTokens: 800,
        outputTokens: 300,
      } as never, deps);
      expect(recordUsage).toHaveBeenCalledWith(SID, { inputTokens: 800, outputTokens: 300 });
    });

    it('emits caco.throughput session-scoped on assistant.usage', () => {
      const deps = makeDeps();
      applyDispatchEventEffects(SID, {
        type: 'assistant.usage',
        data: { inputTokens: 10, outputTokens: 5 },
      } as never, deps);
      expect(deps.onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'caco.throughput' })
      );
    });
  });

  describe('throughput: model.call_failure', () => {
    it('records rate limit when statusCode is 429 (data-wrapped)', () => {
      const deps = makeDeps();
      applyDispatchEventEffects(SID, {
        type: 'model.call_failure',
        data: { statusCode: 429 },
      } as never, deps);
      expect(recordRateLimit).toHaveBeenCalledWith(SID);
      expect(deps.onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'caco.throughput' })
      );
    });

    it('records rate limit when statusCode is 429 (root-shaped)', () => {
      const deps = makeDeps();
      applyDispatchEventEffects(SID, {
        type: 'model.call_failure',
        statusCode: 429,
      } as never, deps);
      expect(recordRateLimit).toHaveBeenCalledWith(SID);
    });

    it('does NOT record rate limit for non-429 status codes', () => {
      const deps = makeDeps();
      applyDispatchEventEffects(SID, {
        type: 'model.call_failure',
        data: { statusCode: 500 },
      } as never, deps);
      expect(recordRateLimit).not.toHaveBeenCalled();
      expect(deps.onEvent).not.toHaveBeenCalled();
    });

    it('does NOT record rate limit when statusCode is absent', () => {
      const deps = makeDeps();
      applyDispatchEventEffects(SID, {
        type: 'model.call_failure',
        data: {},
      } as never, deps);
      expect(recordRateLimit).not.toHaveBeenCalled();
    });
  });

});
