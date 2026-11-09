import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSessionIdle, type IdleAuthorityDeps } from '../../src/idle-authority.js';

const SID = 'sess-1';

function makeDeps(over: Partial<{
  willFire: boolean;
  pending: number;
  started: boolean;
  offerAt: string | undefined;
}> = {}): { deps: IdleAuthorityDeps; spies: Record<string, ReturnType<typeof vi.fn>> } {
  const spies = {
    hasPendingAutoContinue: vi.fn(() => over.willFire ?? false),
    pendingToolCount: vi.fn(() => over.pending ?? 0),
    runAutoContinue: vi.fn(async () => over.started ?? false),
    currentOfferAt: vi.fn(() => over.offerAt),
    markIdle: vi.fn(),
    herdOnSessionIdle: vi.fn(),
    pollQuota: vi.fn(),
    signalDispatchIdle: vi.fn(),
    notifyExternalIdle: vi.fn(),
  };
  const deps: IdleAuthorityDeps = {
    hasPendingAutoContinue: spies.hasPendingAutoContinue as unknown as IdleAuthorityDeps['hasPendingAutoContinue'],
    pendingToolCount: spies.pendingToolCount as unknown as IdleAuthorityDeps['pendingToolCount'],
    runAutoContinue: spies.runAutoContinue as unknown as IdleAuthorityDeps['runAutoContinue'],
    currentOfferAt: spies.currentOfferAt as unknown as IdleAuthorityDeps['currentOfferAt'],
    markIdle: spies.markIdle,
    herdOnSessionIdle: spies.herdOnSessionIdle,
    pollQuota: spies.pollQuota,
    signalDispatchIdle: spies.signalDispatchIdle,
    notifyExternalIdle: spies.notifyExternalIdle,
  };
  return { deps, spies };
}

describe('handleSessionIdle (spec-idle-authority)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('onRealIdle fires on a real idle only, never on a reveal false idle (spec-session-wake)', async () => {
    const onRealIdle = vi.fn();
    const falseIdle = makeDeps({ willFire: true, pending: 1, started: true });
    await handleSessionIdle(SID, { needsObservation: true }, { ...falseIdle.deps, onRealIdle });
    expect(onRealIdle).not.toHaveBeenCalled();
    const realIdle = makeDeps();
    await handleSessionIdle(SID, { needsObservation: false }, { ...realIdle.deps, onRealIdle });
    expect(onRealIdle).toHaveBeenCalledWith(SID);
  });

  it('FALSE idle (willFire + continuation STARTED): fires and suppresses ALL real-idle effects', async () => {
    const { deps, spies } = makeDeps({ willFire: true, pending: 1, started: true });
    await handleSessionIdle(SID, { needsObservation: true }, deps);
    expect(spies.runAutoContinue).toHaveBeenCalledWith(SID, { needsObservation: true });
    // none of the completion consumers fire on a false idle
    expect(spies.signalDispatchIdle).not.toHaveBeenCalled();
    expect(spies.markIdle).not.toHaveBeenCalled();
    expect(spies.herdOnSessionIdle).not.toHaveBeenCalled();
    expect(spies.pollQuota).not.toHaveBeenCalled();
    expect(spies.notifyExternalIdle).not.toHaveBeenCalled();
  });

  it('willFire but the continuation FAILED to start: falls through to real-idle effects (no drop)', async () => {
    // A fire that throws (non-409/non-eviction) yields no further idle; the
    // authority must still wake the herd / complete the delegate / mark unobserved,
    // AND force-emit the dispatch idle that end() suppressed (else waitForActive/
    // waitForIdle/restart are stranded).
    const { deps, spies } = makeDeps({ willFire: true, pending: 1, started: false });
    await handleSessionIdle(SID, { needsObservation: true }, deps);
    expect(spies.runAutoContinue).toHaveBeenCalledWith(SID, { needsObservation: true });
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
    expect(spies.runAutoContinue).toHaveBeenCalledWith(SID, { needsObservation: true });
    expect(spies.markIdle).toHaveBeenCalledWith(SID);
    expect(spies.herdOnSessionIdle).toHaveBeenCalledWith(SID);
    expect(spies.pollQuota).toHaveBeenCalled();
  });

  it('honors needsObservation=false: real idle skips markIdle + external notify but still runs herd + quota', async () => {
    const { deps, spies } = makeDeps({ willFire: false, pending: 0 });
    await handleSessionIdle(SID, { needsObservation: false }, deps);
    expect(spies.markIdle).not.toHaveBeenCalled();
    expect(spies.notifyExternalIdle).not.toHaveBeenCalled();
    // Attended: the herd hook runs regardless, but now learns the idle was
    // agent-requested so its unconditional lastIdleAt stamp cannot arm the badge
    // (spec-observation-authority).
    expect(spies.herdOnSessionIdle).toHaveBeenCalledWith(SID);
    expect(spies.pollQuota).toHaveBeenCalled();
  });

  it('notifyExternalIdle fires iff needsObservation on a real idle (the feed gate)', async () => {
    // needsObservation:true → external feed sees it.
    const yes = makeDeps({ willFire: false, pending: 0 });
    await handleSessionIdle(SID, { needsObservation: true }, yes.deps);
    expect(yes.spies.notifyExternalIdle).toHaveBeenCalledWith(SID);

    // needsObservation:false (herd child / delegate / auto-continue source) → not seen.
    const no = makeDeps({ willFire: false, pending: 0 });
    await handleSessionIdle(SID, { needsObservation: false }, no.deps);
    expect(no.spies.notifyExternalIdle).not.toHaveBeenCalled();

    // false idle (continuation started) → not seen even with needsObservation:true.
    const falseIdle = makeDeps({ willFire: true, pending: 1, started: true });
    await handleSessionIdle(SID, { needsObservation: true }, falseIdle.deps);
    expect(falseIdle.spies.notifyExternalIdle).not.toHaveBeenCalled();
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

describe('observation policy across continuations + scheduler offer gate (spec-observation-verdict-completeness)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a user turn with a reveal gets its badge at the continuation\'s real idle', async () => {
    const userCtx = { needsObservation: true };
    // Reveal idle: the continuation starts, so this idle is false and marks nothing,
    // but the continuation is handed the originating ctx.
    const reveal = makeDeps({ willFire: true, pending: 1, started: true });
    await handleSessionIdle(SID, userCtx, reveal.deps);
    expect(reveal.spies.markIdle).not.toHaveBeenCalled();
    const inherited = reveal.spies.runAutoContinue.mock.calls[0][1] as typeof userCtx;
    expect(inherited).toEqual(userCtx);

    // The continuation's own (real) idle runs under the inherited ctx and badges.
    const real = makeDeps({ willFire: false, pending: 0 });
    await handleSessionIdle(SID, inherited, real.deps);
    expect(real.spies.markIdle).toHaveBeenCalledWith(SID);
    expect(real.spies.notifyExternalIdle).toHaveBeenCalledWith(SID);
  });

  it('a scheduler turn that wrote a NEW offer marks unobserved and reaches the feed', async () => {
    const { deps, spies } = makeDeps({ offerAt: '2026-11-09T10:30:00.000Z' });
    await handleSessionIdle(SID, { needsObservation: true, offerBaseline: { at: '2026-11-09T10:00:00.000Z' } }, deps);
    expect(spies.markIdle).toHaveBeenCalledWith(SID);
    expect(spies.notifyExternalIdle).toHaveBeenCalledWith(SID);
  });

  it('a scheduler turn whose first-ever offer appears (baseline null) marks unobserved', async () => {
    const { deps, spies } = makeDeps({ offerAt: '2026-11-09T10:30:00.000Z' });
    await handleSessionIdle(SID, { needsObservation: true, offerBaseline: { at: null } }, deps);
    expect(spies.markIdle).toHaveBeenCalledWith(SID);
  });

  it('a quiet scheduler turn (stamp unchanged, or still no offer) stays silent but runs herd + quota', async () => {
    const same = makeDeps({ offerAt: '2026-11-09T10:00:00.000Z' });
    await handleSessionIdle(SID, { needsObservation: true, offerBaseline: { at: '2026-11-09T10:00:00.000Z' } }, same.deps);
    expect(same.spies.markIdle).not.toHaveBeenCalled();
    expect(same.spies.notifyExternalIdle).not.toHaveBeenCalled();
    expect(same.spies.herdOnSessionIdle).toHaveBeenCalledWith(SID);
    expect(same.spies.pollQuota).toHaveBeenCalled();

    const none = makeDeps({ offerAt: undefined });
    await handleSessionIdle(SID, { needsObservation: true, offerBaseline: { at: null } }, none.deps);
    expect(none.spies.markIdle).not.toHaveBeenCalled();
    expect(none.spies.notifyExternalIdle).not.toHaveBeenCalled();
  });

  it('a scheduler wake that reveals tools is judged at the continuation\'s idle, gate intact', async () => {
    const ctx = { needsObservation: true, offerBaseline: { at: '2026-11-09T10:00:00.000Z' } };
    const reveal = makeDeps({ willFire: true, pending: 1, started: true, offerAt: '2026-11-09T10:00:00.000Z' });
    await handleSessionIdle(SID, ctx, reveal.deps);
    expect(reveal.spies.runAutoContinue).toHaveBeenCalledWith(SID, ctx);
    expect(reveal.spies.markIdle).not.toHaveBeenCalled();

    const real = makeDeps({ offerAt: '2026-11-09T10:45:00.000Z' });
    await handleSessionIdle(SID, ctx, real.deps);
    expect(real.spies.markIdle).toHaveBeenCalledWith(SID);
  });

  it('needsObservation:false still never marks, whatever the offer did', async () => {
    const { deps, spies } = makeDeps({ offerAt: '2026-11-09T10:30:00.000Z' });
    await handleSessionIdle(SID, { needsObservation: false, offerBaseline: { at: null } }, deps);
    expect(spies.markIdle).not.toHaveBeenCalled();
    expect(spies.currentOfferAt).not.toHaveBeenCalled();
  });
});
