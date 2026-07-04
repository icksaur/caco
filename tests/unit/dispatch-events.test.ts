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
const broadcastGlobalEvent = vi.fn();
const recordUsage = vi.fn();
const recordRateLimit = vi.fn();
const recordToolCall = vi.fn();
const recordToolUse = vi.fn();
const updateSessionMeta = vi.fn();
const snapshotMock = vi.fn(() => ({ requestIn: 0, requestCache: 0, requestOut: 0, totalIn: 0, totalCache: 0, totalOut: 0, rateLimitCount: 0, updatedAt: 'now', known: true }));

vi.mock('../../src/session-meta-store.js', () => ({
  setSessionIntent: (...args: unknown[]) => setSessionIntent(...args),
}));
vi.mock('../../src/storage.js', () => ({
  updateSessionMeta: (...args: unknown[]) => updateSessionMeta(...(args as [])),
}));
vi.mock('../../src/usage-state.js', () => ({
  updateUsage: (...args: unknown[]) => updateUsage(...(args as [])),
  getUsage: (...args: unknown[]) => getUsage(...(args as [])),
}));
vi.mock('../../src/routes/websocket.js', () => ({
  broadcastGlobalEvent: (...args: unknown[]) => broadcastGlobalEvent(...(args as [never])),
}));
vi.mock('../../src/session-throughput.js', () => ({
  recordUsage: (...args: unknown[]) => recordUsage(...(args as [])),
  recordRateLimit: (...args: unknown[]) => recordRateLimit(...(args as [])),
  recordToolCall: (...args: unknown[]) => recordToolCall(...(args as [])),
  recordToolUse: (...args: unknown[]) => recordToolUse(...(args as [])),
  snapshot: (...args: unknown[]) => snapshotMock(...(args as [])),
}));
vi.mock('../../src/tool-key-registry.js', () => ({
  learnMcpKey: vi.fn(),
  lookupMcpKey: vi.fn(() => undefined),
  learnFromMetadata: vi.fn(),
}));
// Mock the usage store so tool.execution_start effects don't write unit-test tool
// stamps into the real ~/.caco/tool-usage.json (which would pollute the C2 signal).
const stampToolUsage = vi.fn();
vi.mock('../../src/tool-usage-store.js', () => ({
  stampToolUsage: (...args: unknown[]) => stampToolUsage(...(args as [])),
}));

import { applyDispatchEventEffects, setGitEditPoller } from '../../src/dispatch-events.js';
import { mcpKey, cacoKey, builtinKey } from '../../src/tool-key.js';

const SID = 'session-1';

function makeDeps() {
  return {
    autoAddFileContext: vi.fn(),
    onEvent: vi.fn(),
    cacoToolNames: () => new Set<string>(),
  };
}

beforeEach(() => {
  setSessionIntent.mockClear();
  updateUsage.mockClear();
  updateUsage.mockReturnValue({ changed: false });
  getUsage.mockClear();
  getUsage.mockReturnValue(null);
  broadcastGlobalEvent.mockClear();
  recordUsage.mockClear();
  recordRateLimit.mockClear();
  recordToolCall.mockClear();
  recordToolUse.mockClear();
  stampToolUsage.mockClear();
  updateSessionMeta.mockClear();
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

    it('records a live-format success (root-level success) as non-failed', () => {
      const deps = makeDeps();
      // Live SDK events carry `success` at the event root, not under `data`.
      applyDispatchEventEffects(SID, {
        type: 'tool.execution_complete',
        toolName: 'grep',
        success: true,
      } as never, deps);
      expect(recordToolCall).toHaveBeenCalledWith(SID, false);
    });

    it('records a live-format failure (root-level success:false) as failed', () => {
      const deps = makeDeps();
      applyDispatchEventEffects(SID, {
        type: 'tool.execution_complete',
        toolName: 'grep',
        success: false,
      } as never, deps);
      expect(recordToolCall).toHaveBeenCalledWith(SID, true);
    });
  });

  describe('inline offer-action (assistant.message → responseOptions)', () => {
    function metaAfter(content: string): { responseOptions?: string[] } {
      applyDispatchEventEffects(SID, { type: 'assistant.message', data: { content } } as never, makeDeps());
      if (!updateSessionMeta.mock.calls.length) return {};
      const meta: { responseOptions?: string[] } = {};
      const mutator = updateSessionMeta.mock.calls[0][1] as (m: typeof meta) => void;
      mutator(meta);
      return meta;
    }

    it('writes responseOptions from a final caco-actions block', () => {
      const meta = metaAfter('Here is the fix.\n```caco-actions\nFix the test\nAdd a test\n```');
      expect(updateSessionMeta).toHaveBeenCalledWith(SID, expect.any(Function));
      expect(meta.responseOptions).toEqual(['Fix the test', 'Add a test']);
    });

    it('does nothing when the message has no block', () => {
      applyDispatchEventEffects(SID, { type: 'assistant.message', data: { content: 'Just prose.' } } as never, makeDeps());
      expect(updateSessionMeta).not.toHaveBeenCalled();
    });

    it('does not write for a block quoted mid-message (final-trailer rule)', () => {
      applyDispatchEventEffects(SID, {
        type: 'assistant.message',
        data: { content: 'Example:\n```caco-actions\nsample\n```\nbut not really.' },
      } as never, makeDeps());
      expect(updateSessionMeta).not.toHaveBeenCalled();
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

  describe('tool-usage stamping (tool.execution_start → recordToolUse under the excludedTools key)', () => {
    const cacoNames = new Set(['caco_run_workflow', 'caco_docs']);
    function depsWithCaco() {
      return { autoAddFileContext: vi.fn(), onEvent: vi.fn(), cacoToolNames: () => cacoNames };
    }

    it('stamps an MCP tool under the model-facing key (what excludedTools matches)', () => {
      applyDispatchEventEffects(SID, {
        type: 'tool.execution_start',
        data: { toolName: 'github-mcp-server-list_issues', mcpServerName: 'github-mcp-server', mcpToolName: 'list_issues' },
      } as never, depsWithCaco());
      expect(recordToolUse).toHaveBeenCalledWith(SID, mcpKey('github-mcp-server-list_issues'));
    });

    it('stamps a bare Caco tool as its bare name (disambiguated)', () => {
      applyDispatchEventEffects(SID, {
        type: 'tool.execution_start', data: { toolName: 'caco_docs' },
      } as never, depsWithCaco());
      expect(recordToolUse).toHaveBeenCalledWith(SID, cacoKey('caco_docs'));
    });

    it('stamps a bare non-Caco tool as builtin:name', () => {
      applyDispatchEventEffects(SID, {
        type: 'tool.execution_start', data: { toolName: 'grep' },
      } as never, depsWithCaco());
      expect(recordToolUse).toHaveBeenCalledWith(SID, builtinKey('grep'));
    });

    it('with an empty cacoToolNames set, a bare tool stamps as builtin (not caco)', () => {
      applyDispatchEventEffects(SID, {
        type: 'tool.execution_start', data: { toolName: 'grep' },
      } as never, makeDeps());
      expect(recordToolUse).toHaveBeenCalledWith(SID, builtinKey('grep'));
    });

    it('stamps the usage store under the SAME key as recordToolUse (seam key-equality)', () => {
      applyDispatchEventEffects(SID, {
        type: 'tool.execution_start',
        data: { toolName: 'github-mcp-server-list_issues', mcpServerName: 'github-mcp-server', mcpToolName: 'list_issues' },
      } as never, depsWithCaco());
      const usedKey = recordToolUse.mock.calls.at(-1)?.[1];
      expect(usedKey).toEqual(mcpKey('github-mcp-server-list_issues'));
      // The system-wide usage stamp MUST use the identical key, or auto-defer mis-fires.
      expect(stampToolUsage).toHaveBeenCalledWith(usedKey);
    });

    it('logs but does not throw when the tool key is unresolvable (no toolName)', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => applyDispatchEventEffects(SID, {
        type: 'tool.execution_start', data: { arguments: {} },
      } as never, depsWithCaco())).not.toThrow();
      expect(recordToolUse).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

});
