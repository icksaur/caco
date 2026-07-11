/**
 * Idle-feed route wiring (spec-idle-notifications Plan 3).
 *
 * Proves the route's `notifyExternalIdle` closure: on a real idle it reads the
 * session's last assistant response and appends it (with the dispatch
 * correlationId) to the REAL idle feed — and only when `needsObservation` is true.
 * Collaborators are module-mocked in the same style as
 * session-messages-dispatch.test.ts; the idle feed is real so we assert the
 * observable append.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sm = vi.hoisted(() => ({
  hasPendingAutoContinue: vi.fn(() => false),
  getPendingTools: vi.fn(() => [] as string[]),
  pollQuota: vi.fn(async () => {}),
  isBusy: vi.fn(() => false),
  resetAutoContinue: vi.fn(),
  getCacoToolCatalog: vi.fn(() => [] as { name: string }[]),
}));
const getLastAssistantMessage = vi.hoisted(() => vi.fn(async () => 'the final answer: COMPLETE'));
const getSessionMeta = vi.hoisted(() => vi.fn(() => ({ kind: 'interactive' })));

vi.mock('../../src/session-manager.js', () => ({ sessionManager: sm, setAutoContinuePrefProvider: vi.fn() }));
vi.mock('../../src/session-state.js', () => ({ sessionState: { getSessionConfig: vi.fn(() => ({})), preferences: {} } }));
vi.mock('../../src/routes/websocket.js', () => ({ broadcastGlobalEvent: vi.fn(), broadcastEvent: vi.fn() }));
vi.mock('../../src/unobserved-tracker.js', () => ({ unobservedTracker: { markIdle: vi.fn() } }));
vi.mock('../../src/herd-runtime.js', () => ({ onSessionIdle: vi.fn() }));
vi.mock('../../src/session-history.js', () => ({ getLastAssistantMessage }));
vi.mock('../../src/storage.js', async (orig) => ({ ...(await orig() as object), getSessionMeta }));

import { handleIdle } from '../../src/routes/session-messages.js';
import { idleFeed } from '../../src/idle-feed.js';

const SID = 'session-1';

beforeEach(() => {
  vi.clearAllMocks();
  idleFeed._resetForTest();
});

describe('idle-feed route wiring', () => {
  it('appends the last response + correlationId on a needsObservation idle', async () => {
    handleIdle(SID, true, 'corr-42');
    // The notifier awaits getLastAssistantMessage before appending.
    await vi.waitFor(async () => {
      const r = await idleFeed.read({ after: 0, wait: 0 });
      expect(r.events).toHaveLength(1);
    });
    const r = await idleFeed.read({ after: 0, wait: 0 });
    expect(r.events[0]).toMatchObject({
      sessionId: SID,
      response: 'the final answer: COMPLETE',
      kind: 'interactive',
      correlationId: 'corr-42',
    });
  });

  it('does NOT append when needsObservation is false (herd child / delegate / auto-continue)', async () => {
    handleIdle(SID, false, 'corr-99');
    await new Promise((r) => setTimeout(r, 20));
    const r = await idleFeed.read({ after: 0, wait: 0 });
    expect(r.events).toEqual([]);
    expect(getLastAssistantMessage).not.toHaveBeenCalled();
  });
});
