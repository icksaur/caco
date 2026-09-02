/**
 * Oracle for the auto-continue idle annotation in dispatchMessage.
 *
 * A `session.idle` the server is about to supersede with an auto-continuation is
 * spurious: the client must not fire a "session complete" notification for it.
 * The server marks it with `willAutoContinue` so the client can tell the two
 * apart. Guards both directions — a real idle must stay unannotated, or the
 * client would go permanently silent.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Evt = { type: string; data?: Record<string, unknown> };

const sm = vi.hoisted(() => ({
  isBusy: vi.fn(() => false),
  startDispatch: vi.fn(),
  endDispatch: vi.fn(),
  isActive: vi.fn(() => true),
  ensureClientHealthy: vi.fn(async () => {}),
  getSession: vi.fn((): unknown => null),
  resume: vi.fn(async () => {}),
  pollQuota: vi.fn(async () => {}),
  getModels: vi.fn((): unknown[] => []),
  getPendingTools: vi.fn(() => [] as string[]),
  hasPendingAutoContinue: vi.fn(() => false),
  runAutoContinue: vi.fn(async () => false),
  resetAutoContinue: vi.fn(),
  getCacoToolCatalog: vi.fn(() => [] as { name: string }[]),
  nextDeferredToolsReminder: vi.fn(() => ({ text: '', commit: vi.fn() })),
  sendStream: vi.fn(async () => {}),
  abortStaleGeneration: vi.fn(),
  dropStaleSession: vi.fn(),
}));

vi.mock('../../src/session-manager.js', () => ({ sessionManager: sm, setAutoContinuePrefProvider: vi.fn() }));
vi.mock('../../src/session-state.js', () => ({
  sessionState: { getSessionConfig: vi.fn(() => ({})) },
}));
vi.mock('../../src/routes/websocket.js', () => ({
  broadcastGlobalEvent: vi.fn(),
  broadcastEvent: vi.fn(),
}));
vi.mock('../../src/session-throughput.js', () => ({
  resetRequest: vi.fn(),
  snapshot: vi.fn(() => ({})),
  markRequestComplete: vi.fn(() => null),
  recordUsage: vi.fn(),
  recordRateLimit: vi.fn(),
  recordToolCall: vi.fn(),
  recordToolUse: vi.fn(),
  recordCompaction: vi.fn(),
}));

import { dispatchMessage } from '../../src/routes/session-messages.js';

const SID = 'session-annotate';

/** A fake SDK session that hands back its event callback so a test can drive it. */
function fakeSession(): { session: unknown; emit: (e: Evt) => void } {
  let cb: ((e: Evt) => void) | null = null;
  return {
    session: { on: (fn: (e: Evt) => void) => { cb = fn; return () => { cb = null; }; } },
    emit: (e: Evt) => cb?.(e),
  };
}

async function idleEventsFor(pendingAutoContinue: boolean): Promise<Evt[]> {
  const { session, emit } = fakeSession();
  sm.getSession.mockReturnValue(session);
  sm.hasPendingAutoContinue.mockReturnValue(pendingAutoContinue);

  const seen: Evt[] = [];
  await dispatchMessage(SID, 'hi', {}, { onEvent: (e: unknown) => { seen.push(e as Evt); } });
  emit({ type: 'session.idle', data: { reason: 'turn-end' } });

  return seen.filter(e => e.type === 'session.idle');
}

beforeEach(() => {
  vi.clearAllMocks();
  sm.isBusy.mockReturnValue(false);
  sm.isActive.mockReturnValue(true);
  sm.nextDeferredToolsReminder.mockReturnValue({ text: '', commit: vi.fn() });
});

describe('dispatchMessage session.idle auto-continue annotation', () => {
  it('marks an idle that an auto-continuation will supersede', async () => {
    const idles = await idleEventsFor(true);

    expect(idles).toHaveLength(1);
    expect(idles[0].data?.willAutoContinue).toBe(true);
  });

  it('preserves the original event data alongside the annotation', async () => {
    const idles = await idleEventsFor(true);

    expect(idles[0].data?.reason).toBe('turn-end');
  });

  it('leaves a real idle unannotated so the client still notifies', async () => {
    const idles = await idleEventsFor(false);

    expect(idles).toHaveLength(1);
    expect(idles[0].data?.willAutoContinue).toBeUndefined();
  });
});
