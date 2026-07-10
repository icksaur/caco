import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  maybeAutoContinue,
  buildContinuationPrompt,
  _resetAutoContinueChains,
  CAP_MESSAGE,
  type AutoContinueDeps,
} from '../../src/auto-continue-runtime.js';

const SID = 'sess-1';

/** A fake session-state harness with the two auto-continue maps + a busy flag,
 *  wired into AutoContinueDeps so we exercise the real fire/reset/cap flow. */
function harness(opts?: { enabled?: boolean; cap?: number; busy?: boolean }) {
  const pending = new Map<string, Set<string>>();
  const attempts = new Map<string, number>();
  let busy = opts?.busy ?? false;
  const dispatch = vi.fn(async () => {});
  const reassert = vi.fn(async () => {});
  const emitSystem = vi.fn();
  const markContinuing = vi.fn();
  const clearContinuing = vi.fn();

  const deps: AutoContinueDeps = {
    getPendingTools: sid => [...(pending.get(sid) ?? [])],
    getAttempts: sid => attempts.get(sid) ?? 0,
    isBusy: () => busy,
    reassert,
    clearPendingTools: sid => { pending.delete(sid); },
    markContinuing,
    clearContinuing,
    bumpAttempts: sid => attempts.set(sid, (attempts.get(sid) ?? 0) + 1),
    dispatch,
    emitSystem,
    enabled: () => opts?.enabled ?? true,
    cap: opts?.cap ?? 3,
  };

  return {
    deps, dispatch, reassert, emitSystem, markContinuing, clearContinuing,
    setPending: (names: string[]) => pending.set(SID, new Set(names)),
    setAttempts: (n: number) => attempts.set(SID, n),
    setBusy: (b: boolean) => { busy = b; },
    pendingOf: (sid = SID) => [...(pending.get(sid) ?? [])],
    attemptsOf: (sid = SID) => attempts.get(sid) ?? 0,
  };
}

describe('maybeAutoContinue (spec-enable-tools-autocontinue P3/P4/P5)', () => {
  beforeEach(() => { _resetAutoContinueChains(); vi.clearAllMocks(); });

  it('fires a continuation: re-asserts, clears pending, bumps attempts, dispatches the named tools', async () => {
    const h = harness();
    h.setPending(['github-list_issues', 'caco_docs']);
    await expect(maybeAutoContinue(SID, h.deps)).resolves.toBe(true); // continuation started

    expect(h.reassert).toHaveBeenCalledWith(SID, ['github-list_issues', 'caco_docs']);
    expect(h.pendingOf()).toEqual([]);          // pending consumed
    expect(h.attemptsOf()).toBe(1);             // counter bumped
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const [, prompt] = h.dispatch.mock.calls[0] as unknown as [string, string];
    expect(prompt).toContain('github-list_issues');
    expect(prompt).toContain('caco_docs');
  });

  it('brackets the continuation with markContinuing (before clearPendingTools) / clearContinuing (after)', async () => {
    // Closes the restart sub-window: the in-flight marker must be set BEFORE the
    // pending set is cleared and released only after the fire path completes.
    const h = harness();
    h.setPending(['github-list_issues']);
    await maybeAutoContinue(SID, h.deps);

    const markOrder = h.markContinuing.mock.invocationCallOrder[0];
    const dispatchOrder = h.dispatch.mock.invocationCallOrder[0];
    const clearOrder = h.clearContinuing.mock.invocationCallOrder[0];
    expect(h.markContinuing).toHaveBeenCalledWith(SID);
    expect(h.clearContinuing).toHaveBeenCalledWith(SID);
    expect(markOrder).toBeLessThan(dispatchOrder);   // marked before the dispatch fires
    expect(clearOrder).toBeGreaterThan(dispatchOrder); // released after
  });

  it('releases the in-flight marker even when the fire fails', async () => {
    const h = harness();
    h.setPending(['github-list_issues']);
    h.dispatch.mockRejectedValueOnce(new Error('SESSION_BUSY'));
    await expect(maybeAutoContinue(SID, h.deps)).resolves.toBe(false);
    expect(h.clearContinuing).toHaveBeenCalledWith(SID);
  });

  it('does not fire when nothing is pending', async () => {
    const h = harness();
    await maybeAutoContinue(SID, h.deps);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.emitSystem).not.toHaveBeenCalled();
  });

  it('does not fire (and emits no cap message) when the session is busy', async () => {
    const h = harness({ busy: true });
    h.setPending(['github-list_issues']);
    h.setAttempts(99); // even over cap, busy ⇒ silent skip
    await maybeAutoContinue(SID, h.deps);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.emitSystem).not.toHaveBeenCalled();
    expect(h.pendingOf()).toEqual(['github-list_issues']); // preserved
  });

  it('emits the terminal cap message and does not dispatch when at the cap', async () => {
    const h = harness({ cap: 3 });
    h.setPending(['github-list_issues']);
    h.setAttempts(3);
    await maybeAutoContinue(SID, h.deps);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.emitSystem).toHaveBeenCalledWith(SID, CAP_MESSAGE);
  });

  it('does not fire when the operator preference is off', async () => {
    const h = harness({ enabled: false });
    h.setPending(['github-list_issues']);
    await maybeAutoContinue(SID, h.deps);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.emitSystem).not.toHaveBeenCalled();
  });

  it('coalesces concurrent idle evaluations into a single continuation (trailing-edge)', async () => {
    const h = harness();
    h.setPending(['github-list_issues']);
    // Fire three evaluations "simultaneously"; the chain serializes them and the
    // first consumes the pending set, so the rest are no-ops.
    await Promise.all([
      maybeAutoContinue(SID, h.deps),
      maybeAutoContinue(SID, h.deps),
      maybeAutoContinue(SID, h.deps),
    ]);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.attemptsOf()).toBe(1);
  });

  it('builds a continuation prompt that names the tools', () => {
    expect(buildContinuationPrompt(['a', 'b'])).toContain('a, b');
  });

  it('does not reject when the continuation dispatch fails (e.g. 409 SESSION_BUSY race)', async () => {
    const h = harness();
    h.setPending(['github-list_issues']);
    h.dispatch.mockRejectedValueOnce(new Error('Session is busy processing another message'));
    // Must resolve false (swallowed, continuation did NOT start), not throw — an
    // unhandled rejection could crash the server, and false lets the idle authority
    // run real-idle effects instead of dropping them.
    await expect(maybeAutoContinue(SID, h.deps)).resolves.toBe(false);
    // Pending was still consumed and the attempt counted (a concurrent dispatch resets anyway).
    expect(h.pendingOf()).toEqual([]);
    expect(h.attemptsOf()).toBe(1);
  });
});
