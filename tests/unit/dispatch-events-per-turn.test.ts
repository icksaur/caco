/**
 * Oracles for the per-turn usage accumulator (spec-usage-metrics amendment, row 9).
 *
 * `assistant.usage` is the only per-call event carrying a required `model`, so
 * it is the attribution source for Auto and for mid-request switches. These pin
 * that EVERY such event is captured (sub-agent turns included — they are real
 * spend on the parent's dispatch), that the fresh/cached split matches the
 * throughput recorder's, and that the two model events feed display-only metadata.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const recordUsage = vi.fn();
const snapshotMock = vi.fn(() => ({ known: true }));

vi.mock('../../src/session-meta-store.js', () => ({ setSessionIntent: vi.fn() }));
vi.mock('../../src/storage.js', () => ({ updateSessionMeta: vi.fn() }));
vi.mock('../../src/usage-state.js', () => ({
  updateUsage: vi.fn(() => ({ changed: false })),
  getUsage: vi.fn(() => null),
}));
vi.mock('../../src/routes/websocket.js', () => ({ broadcastGlobalEvent: vi.fn() }));
vi.mock('../../src/session-throughput.js', () => ({
  recordUsage: (...a: unknown[]) => recordUsage(...(a as [])),
  recordRateLimit: vi.fn(),
  recordToolCall: vi.fn(),
  recordToolUse: vi.fn(),
  recordCompaction: vi.fn(),
  snapshot: (...a: unknown[]) => snapshotMock(...(a as [])),
}));
vi.mock('../../src/tool-key-registry.js', () => ({
  learnMcpKey: vi.fn(), lookupMcpKey: vi.fn(() => undefined), learnFromMetadata: vi.fn(),
}));
vi.mock('../../src/tool-usage-store.js', () => ({ stampToolUsage: vi.fn() }));

import { applyDispatchEventEffects } from '../../src/dispatch-events.js';
import {
  setAutoResolvedModel,
  getAutoResolvedModel,
  clearAutoResolvedModel,
} from '../../src/auto-model-cache.js';
import type { TurnUsage } from '../../src/usage-metrics.js';

const SID = 'session-1';

function makeDeps(perTurn: TurnUsage[], switched: { value?: unknown } = {}) {
  return {
    autoAddFileContext: vi.fn(),
    onEvent: vi.fn(),
    cacoToolNames: () => new Set<string>(),
    onTurnUsage: (t: TurnUsage) => { perTurn.push(t); },
    onModelSwitch: (s: { fromModel: string; toModel: string; cause?: string }) => { switched.value = s; },
    resolveRates: () => null,
  };
}

beforeEach(() => {
  recordUsage.mockClear();
  clearAutoResolvedModel(SID);
});

describe('per-turn usage capture', () => {
  it('captures a root turn with the model the SDK reported for that call', () => {
    const perTurn: TurnUsage[] = [];
    applyDispatchEventEffects(SID, {
      type: 'assistant.usage',
      data: { model: 'gpt-5-mini', inputTokens: 1000, cacheReadTokens: 400, outputTokens: 50 },
    } as never, makeDeps(perTurn));

    expect(perTurn).toHaveLength(1);
    expect(perTurn[0].model).toBe('gpt-5-mini');
    expect(perTurn[0].initiator).toBe('root');
  });

  it('splits fresh from cached input exactly as the throughput recorder does', () => {
    const perTurn: TurnUsage[] = [];
    applyDispatchEventEffects(SID, {
      type: 'assistant.usage',
      data: { model: 'gpt-5-mini', inputTokens: 1000, cacheReadTokens: 400, outputTokens: 50 },
    } as never, makeDeps(perTurn));

    // recordUsage computes fresh = max(0, input - cacheRead) internally; the
    // accumulator must agree or the record's tokens and the footer's disagree.
    expect(perTurn[0].freshInputTokens).toBe(600);
    expect(perTurn[0].cachedTokens).toBe(400);
    expect(perTurn[0].outputTokens).toBe(50);
  });

  it('clamps fresh input to zero when cache read exceeds the prompt', () => {
    const perTurn: TurnUsage[] = [];
    applyDispatchEventEffects(SID, {
      type: 'assistant.usage',
      data: { model: 'gpt-5-mini', inputTokens: 50, cacheReadTokens: 80, outputTokens: 1 },
    } as never, makeDeps(perTurn));

    expect(perTurn[0].freshInputTokens).toBe(0);
  });

  it('captures sub-agent turns too — they are real spend on this request', () => {
    const perTurn: TurnUsage[] = [];
    const deps = makeDeps(perTurn);
    applyDispatchEventEffects(SID, {
      type: 'assistant.usage',
      agentId: 'agent-7',
      data: { model: 'gpt-5-mini', initiator: 'sub-agent', inputTokens: 10, outputTokens: 2 },
    } as never, deps);

    expect(perTurn).toHaveLength(1);
    expect(perTurn[0].initiator).toBe('sub-agent');
  });

  it('recognizes mcp-sampling and folds anything else into root', () => {
    const perTurn: TurnUsage[] = [];
    const deps = makeDeps(perTurn);
    applyDispatchEventEffects(SID, {
      type: 'assistant.usage', data: { model: 'm', initiator: 'mcp-sampling' },
    } as never, deps);
    applyDispatchEventEffects(SID, {
      type: 'assistant.usage', data: { model: 'm', initiator: 'something-new' },
    } as never, deps);

    expect(perTurn[0].initiator).toBe('mcp-sampling');
    expect(perTurn[1].initiator).toBe('root');
  });

  it('reads a live-shaped event whose fields sit at the root', () => {
    const perTurn: TurnUsage[] = [];
    // Live events carry properties at the root; history wraps them in `data`.
    applyDispatchEventEffects(SID, {
      type: 'assistant.usage',
      model: 'claude-opus-4.6', inputTokens: 900, cacheReadTokens: 100, outputTokens: 5,
    } as never, makeDeps(perTurn));

    expect(perTurn[0].model).toBe('claude-opus-4.6');
    expect(perTurn[0].freshInputTokens).toBe(800);
  });

  it('captures nano-AIU when present and leaves it absent otherwise', () => {
    const perTurn: TurnUsage[] = [];
    const deps = makeDeps(perTurn);
    applyDispatchEventEffects(SID, {
      type: 'assistant.usage', data: { model: 'm', copilotUsage: { totalNanoAiu: 4200 } },
    } as never, deps);
    applyDispatchEventEffects(SID, { type: 'assistant.usage', data: { model: 'm' } } as never, deps);

    expect(perTurn[0].nanoAiu).toBe(4200);
    expect(perTurn[1].nanoAiu).toBeUndefined();
  });

  it('defaults missing token fields to zero rather than NaN', () => {
    const perTurn: TurnUsage[] = [];
    applyDispatchEventEffects(SID, { type: 'assistant.usage', data: { model: 'm' } } as never, makeDeps(perTurn));

    expect(perTurn[0].freshInputTokens).toBe(0);
    expect(perTurn[0].cachedTokens).toBe(0);
    expect(perTurn[0].outputTokens).toBe(0);
  });

  it('ignores a usage event with no model — it cannot be attributed', () => {
    const perTurn: TurnUsage[] = [];
    applyDispatchEventEffects(SID, {
      type: 'assistant.usage', data: { inputTokens: 10, outputTokens: 2 },
    } as never, makeDeps(perTurn));

    expect(perTurn).toHaveLength(0);
    // Token accounting still happens — only the attribution is skipped.
    expect(recordUsage).toHaveBeenCalled();
  });
});

describe('display-only model metadata', () => {
  it('records a root model switch that happened during the request', () => {
    const switched: { value?: unknown } = {};
    applyDispatchEventEffects(SID, {
      type: 'session.model_change',
      data: { previousModel: 'gpt-5-mini', newModel: 'claude-opus-4.6', cause: 'rate_limit_auto_switch' },
    } as never, makeDeps([], switched));

    expect(switched.value).toEqual({
      fromModel: 'gpt-5-mini',
      toModel: 'claude-opus-4.6',
      cause: 'rate_limit_auto_switch',
    });
  });

  it('ignores a sub-agent model change — it is not the request-level model', () => {
    const switched: { value?: unknown } = {};
    applyDispatchEventEffects(SID, {
      type: 'session.model_change',
      agentId: 'agent-7',
      data: { previousModel: 'a', newModel: 'b' },
    } as never, makeDeps([], switched));

    expect(switched.value).toBeUndefined();
  });

  it('remembers what Auto resolved to, so later dispatches can label the session', () => {
    applyDispatchEventEffects(SID, {
      type: 'session.auto_mode_resolved', data: { chosenModel: 'gpt-5-mini' },
    } as never, makeDeps([]));

    expect(getAutoResolvedModel(SID)).toBe('gpt-5-mini');
  });

  it('forgets the resolved model when the session runtime is disposed', async () => {
    const { disposeSessionRuntime } = await import('../../src/session-runtime.js');
    setAutoResolvedModel(SID, 'gpt-5-mini');
    expect(getAutoResolvedModel(SID)).toBe('gpt-5-mini');

    // Through the REAL teardown seam, not a direct clear: nothing calls
    // getSessionRuntime in production, so an eviction placed inside
    // SessionRuntime.dispose() would never run and the cache would leak.
    disposeSessionRuntime(SID);

    expect(getAutoResolvedModel(SID)).toBeUndefined();
  });
});
