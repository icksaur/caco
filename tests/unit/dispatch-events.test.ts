/**
 * Tests for src/dispatch-events.ts
 *
 * Verifies the event → side-effect mapping. Side effects target module-level
 * stores; tests use vi.mock to intercept and assert on the calls.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const setSessionIntent = vi.fn();
const updateUsage = vi.fn();
const shouldEmitReload = vi.fn();
const consumeReloadSignal = vi.fn();

vi.mock('../../src/session-meta-store.js', () => ({
  setSessionIntent: (...args: unknown[]) => setSessionIntent(...args),
}));
vi.mock('../../src/usage-state.js', () => ({
  updateUsage: (...args: unknown[]) => updateUsage(...args),
}));
vi.mock('../../src/sdk-event-parser.js', () => ({
  shouldEmitReload: (...args: unknown[]) => shouldEmitReload(...args),
}));
vi.mock('../../src/applet-state.js', () => ({
  consumeReloadSignal: (...args: unknown[]) => consumeReloadSignal(...args),
}));

import { applyDispatchEventEffects } from '../../src/dispatch-events.js';

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
  shouldEmitReload.mockReset();
  consumeReloadSignal.mockReset();
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
});
