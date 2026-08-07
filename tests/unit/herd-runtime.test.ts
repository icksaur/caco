import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the impure edges so we can assert the guard without real storage / HTTP.
const storage = vi.hoisted(() => ({
  markSessionIdle: vi.fn(),
  getSessionMeta: vi.fn(() => ({})),
  readSessionMeta: vi.fn(() => ({ ok: true })),
  updateSessionMeta: vi.fn(),
}));
const sm = vi.hoisted(() => ({
  hasPendingAutoContinue: vi.fn(() => false),
}));

vi.mock('../../src/storage.js', () => storage);
vi.mock('../../src/session-manager.js', () => ({ sessionManager: sm }));
vi.mock('../../src/config.js', () => ({ SERVER_URL: 'http://localhost:0' }));
vi.mock('../../src/sdk-session-store.js', () => ({ listSessionIds: vi.fn(() => []) }));

import { onSessionIdle } from '../../src/herd-runtime.js';
import * as herd from '../../src/herd.js';

describe('onSessionIdle guard (spec-idle-authority)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    herd.rebuildHerdIndex([]); // empty membership index
  });

  it('a pending-continuation idle is skipped: no stamp, no wake', async () => {
    sm.hasPendingAutoContinue.mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));

    await onSessionIdle('child-1');

    expect(storage.markSessionIdle).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled(); // wakeParent never reached
  });

  it('a real idle (no pending continuation) stamps lastIdleAt', async () => {
    sm.hasPendingAutoContinue.mockReturnValue(false);
    storage.getSessionMeta.mockReturnValue({}); // not a child (no orchestratedBy)

    await onSessionIdle('sess-1');

    // Threads the attendance verdict (spec-observation-authority): an unattended
    // idle stamps only lastIdleAt, so the badge still arms for the user.
    expect(storage.markSessionIdle).toHaveBeenCalledWith('sess-1', false);
  });
});
