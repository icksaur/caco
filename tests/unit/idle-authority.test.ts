import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSessionIdle, type IdleAuthorityDeps } from '../../src/idle-authority.js';

const SID = 'sess-1';

function makeDeps(over: Partial<{
  willFire: boolean;
  pending: number;
  started: boolean;
}> = {}): { deps: IdleAuthorityDeps; spies: Record<string, ReturnType<typeof vi.fn>> } {
  const spies = {
    hasPendingAutoContinue: vi.fn(() => over.willFire ?? false),
    pendingToolCount: vi.fn(() => over.pending ?? 0),
    runAutoContinue: vi.fn(async () => over.started ?? false),
    markIdle: vi.fn(),
    herdOnSessionIdle: vi.fn(),
    pollQuota: vi.fn(),
    signalDispatchIdle: vi.fn(),
  };
  const deps: IdleAuthorityDeps = {
    hasPendingAutoContinue: spies.hasPendingAutoContinue as unknown as IdleAuthorityDeps['hasPendingAutoContinue'],
    pendingToolCount: spies.pendingToolCount as unknown as IdleAuthorityDeps['pendingToolCount'],
    runAutoContinue: spies.runAutoContinue as unknown as IdleAuthorityDeps['runAutoContinue'],
    markIdle: spies.markIdle,
    herdOnSessionIdle: spies.herdOnSessionIdle,
    pollQuota: spies.pollQuota,
    signalDispatchIdle: spies.signalDispatchIdle,
  };
  return { deps, spies };
}

describe('handleSessionIdle (spec-idle-authority)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('FALSE idle (willFire + continuation STARTED): fires and suppresses ALL real-idle effects', async () => {
    const { deps, spies } = makeDeps({ willFire: true, pending: 1, started: true });
    await handleSessionIdle(SID, { needsObservation: true }, deps);
    expect(spies.runAutoContinue).toHaveBeenCalledWith(SID);
    // none of the completion consumers fire on a false idle
    expect(spies.signalDispatchIdle).not.toHaveBeenCalled();
    expect(spies.markIdle).not.toHaveBeenCalled();
    expect(spies.herdOnSessionIdle).not.toHaveBeenCalled();
    expect(spies.pollQuota).not.toHaveBeenCalled();
  });

  it('willFire but the continuation FAILED to start: falls through to real-idle effects (no drop)', async () => {
    // A fire that throws (non-409/non-eviction) yields no further idle; the
    // authority must still wake the herd / complete the delegate / mark unobserved,
    // AND force-emit the dispatch idle that end() suppressed (else waitForActive/
    // waitForIdle/restart are stranded).
    const { deps, spies } = makeDeps({ willFire: true, pending: 1, started: false });
    await handleSessionIdle(SID, { needsObservation: true }, deps);
    expect(spies.runAutoContinue).toHaveBeenCalledWith(SID);
    expect(spies.signalDispatchIdle).toHaveBeenCalledWith(SID);
    expect(spies.markIdle).toHaveBeenCalledWith(SID);
    expect(spies.herdOnSessionIdle).toHaveBeenCalledWith(SID);
    expect(spies.pollQuota).toHaveBeenCalled();
  });

  it('REAL idle, nothing pending: runs all real-idle effects, never invokes the continuation', async () => {
    const { deps, spies } = makeDeps({ willFire: false, pending: 0 });
    await handleSessionIdle(SID, { needsObservation: true }, deps);
    expect(spies.runAutoContinue).not.toHaveBeenCalled();
    // end() already emitted a real idle (not suppressed), so no replacement emit.
    expect(spies.signalDispatchIdle).not.toHaveBeenCalled();
    expect(spies.markIdle).toHaveBeenCalledWith(SID);
    expect(spies.herdOnSessionIdle).toHaveBeenCalledWith(SID);
    expect(spies.pollQuota).toHaveBeenCalled();
  });

  it('REAL idle, pending-but-capped: drives runAutoContinue (cap message) AND runs real-idle effects', async () => {
    // willFire is false (capped) but pending>0, so the continuation runtime must
    // still be driven (to emit the terminal cap message), then the session is
    // reported done to herd/delegate/unobserved.
    const { deps, spies } = makeDeps({ willFire: false, pending: 1 });
    await handleSessionIdle(SID, { needsObservation: true }, deps);
    expect(spies.runAutoContinue).toHaveBeenCalledWith(SID);
    expect(spies.markIdle).toHaveBeenCalledWith(SID);
    expect(spies.herdOnSessionIdle).toHaveBeenCalledWith(SID);
    expect(spies.pollQuota).toHaveBeenCalled();
  });

  it('honors needsObservation=false: real idle skips markIdle but still runs herd + quota', async () => {
    const { deps, spies } = makeDeps({ willFire: false, pending: 0 });
    await handleSessionIdle(SID, { needsObservation: false }, deps);
    expect(spies.markIdle).not.toHaveBeenCalled();
    expect(spies.herdOnSessionIdle).toHaveBeenCalledWith(SID);
    expect(spies.pollQuota).toHaveBeenCalled();
  });

  it('captures willFire BEFORE runAutoContinue (fire path clears the pending set)', async () => {
    const { deps, spies } = makeDeps({ willFire: true, pending: 1, started: true });
    await handleSessionIdle(SID, { needsObservation: true }, deps);
    // hasPendingAutoContinue read once, before runAutoContinue
    const predOrder = spies.hasPendingAutoContinue.mock.invocationCallOrder[0];
    const runOrder = spies.runAutoContinue.mock.invocationCallOrder[0];
    expect(predOrder).toBeLessThan(runOrder);
  });
});
