/**
 * Wiring test for the durable usage record emitted from completeDispatch
 * (spec-usage-metrics Plan 3). Drives dispatchMessage to a session.idle event
 * and asserts exactly one UsageRecord is emitted, priced by the dispatch-start
 * model. Heavy collaborators are module-mocked; usage-metrics is REAL so we can
 * register a capturing sink.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionEvent } from '../../src/routes/websocket.js';
import type { UsageRecord } from '../../src/usage-metrics.js';

type Handler = (e: { type: string; data?: unknown }) => void;
let capturedHandler: Handler | null = null;

const markComplete = vi.hoisted(() => vi.fn());

const fakeSession = {
  on: (cb: Handler) => {
    capturedHandler = cb;
    return () => {};
  },
};

const sm = vi.hoisted(() => ({
  isBusy: vi.fn(() => false),
  startDispatch: vi.fn(),
  endDispatch: vi.fn(),
  isActive: vi.fn(() => true),
  ensureClientHealthy: vi.fn(async () => {}),
  getSession: vi.fn((): unknown => null),
  resume: vi.fn(async () => {}),
  pollQuota: vi.fn(async () => {}),
  sendStream: vi.fn(async () => {}),
  getCacoToolCatalog: vi.fn(() => [] as { name: string }[]),
  getModels: vi.fn(() => [{ id: 'claude-opus-4.6' }] as unknown[]),
  // Auto-continuation hook runs on idle; no reveal in these tests ⇒ empty pending
  // so triggerAutoContinue short-circuits before touching anything else.
  getPendingTools: vi.fn(() => [] as string[]),
  resetAutoContinue: vi.fn(),
}));

vi.mock('../../src/session-manager.js', () => ({ sessionManager: sm }));
vi.mock('../../src/session-state.js', () => ({ sessionState: { getSessionConfig: vi.fn(() => ({})) } }));
vi.mock('../../src/routes/websocket.js', () => ({
  broadcastGlobalEvent: vi.fn(),
  broadcastEvent: vi.fn(),
}));
vi.mock('../../src/storage.js', () => ({
  getSessionMeta: vi.fn(() => ({ model: 'claude-opus-4.6' })),
  updateSessionMeta: vi.fn(),
}));
vi.mock('../../src/model-billing.js', () => ({
  modelCostSummary: vi.fn(() => ({ inputPerMtok: 15, outputPerMtok: 75, cachePerMtok: 1.5, contextWindow: 200_000, multiplier: 1 })),
}));
vi.mock('../../src/session-throughput.js', () => ({
  resetRequest: vi.fn(),
  snapshot: vi.fn(() => ({})),
  markRequestComplete: markComplete,
}));
vi.mock('../../src/request-metrics-log.js', () => ({ appendRequestMetrics: vi.fn() }));
vi.mock('../../src/dispatch-events.js', () => ({ applyDispatchEventEffects: vi.fn() }));
vi.mock('../../src/dispatch-watchdog.js', () => ({
  createWatchdog: vi.fn(() => ({ reset: vi.fn(), cancel: vi.fn(), notifyEvent: vi.fn() })),
}));
vi.mock('../../src/dispatch-state.js', () => ({ dispatchState: { notifyActivity: vi.fn() } }));

import { dispatchMessage } from '../../src/routes/session-messages.js';
import { registerUsageSink, clearUsageSinks } from '../../src/usage-metrics.js';

const SID = 'session-1';
const ROW_WITH_TURNS = {
  requestIn: 1_000_000, requestCache: 2_000_000, requestOut: 500_000,
  requestTurns: 3, requestReasoning: 0, requestToolCalls: 0, requestToolFailures: 0,
  requestWorkflowCodeBytes: 0, requestWallMs: 1000, rateLimitCount: 0,
};

let emitted: UsageRecord[];

beforeEach(() => {
  vi.clearAllMocks();
  clearUsageSinks();
  emitted = [];
  registerUsageSink({ emit: r => emitted.push(r) });
  capturedHandler = null;
  sm.isBusy.mockReturnValue(false);
  sm.isActive.mockReturnValue(true);
  sm.getSession.mockReturnValue(fakeSession);
  markComplete.mockReturnValue(ROW_WITH_TURNS);
});

async function driveIdle(): Promise<void> {
  const onEvent = vi.fn();
  await dispatchMessage(SID, 'hi', {}, { onEvent });
  expect(capturedHandler).toBeTypeOf('function');
  capturedHandler!({ type: 'session.idle' } as SessionEvent);
  await new Promise(r => setTimeout(r, 0));
}

describe('usage record wiring in completeDispatch', () => {
  it('emits exactly one usage record on session.idle, priced by the dispatch-start model', async () => {
    await driveIdle();
    expect(emitted).toHaveLength(1);
    const rec = emitted[0];
    expect(rec.sessionId).toBe(SID);
    expect(rec.model).toBe('claude-opus-4.6');
    expect(rec.contextWindow).toBe(200_000);
    expect(rec.inputTokens).toBe(1_000_000);
    expect(rec.cachedTokens).toBe(2_000_000);
    expect(rec.outputTokens).toBe(500_000);
    expect(rec.turns).toBe(3);
    // (In*15 + Cache*1.5 + Out*75)/1e6 = 15 + 3 + 37.5 = 55.5
    expect(rec.requestCredits).toBeCloseTo(55.5, 9);
  });

  it('is idempotent: a second idle event does not emit a second record', async () => {
    await driveIdle();
    capturedHandler!({ type: 'session.idle' } as SessionEvent);
    await new Promise(r => setTimeout(r, 0));
    expect(emitted).toHaveLength(1);
  });

  it('emits no record when the request ran zero turns (pre-send abort)', async () => {
    markComplete.mockReturnValue({ ...ROW_WITH_TURNS, requestTurns: 0 });
    await driveIdle();
    expect(emitted).toHaveLength(0);
  });
});
