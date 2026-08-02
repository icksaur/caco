import { describe, it, expect, beforeEach } from 'vitest';
import {
  rebuildHerdIndex,
  registerHerdBond,
  clearHerdBond,
  getHerdChildren,
  isHerdParent,
  herdSignature,
  buildHerdSummary,
  decideHerdWake,
  wakeParentIfNeeded,
  deriveChildStatus,
  shouldParkOnDisown,
  herdParentActionError,
  herdAcquireError,
  herdMemberError,
  buildHerdStatePayload,
  childIdleDecision,
  type HerdChild,
} from '../../src/herd.js';

function child(over: Partial<HerdChild> & { sessionId: string }): HerdChild {
  return { name: over.sessionId, status: 'idle', lastIdleAt: '2026-07-08T00:00:00.000Z', ...over };
}

describe('herd membership index', () => {
  beforeEach(() => rebuildHerdIndex([]));

  it('rebuilds parent→children from a set of bonds', () => {
    rebuildHerdIndex([
      { childId: 'c1', parentId: 'p1' },
      { childId: 'c2', parentId: 'p1' },
      { childId: 'c3', parentId: 'p2' },
    ]);
    expect(getHerdChildren('p1').sort()).toEqual(['c1', 'c2']);
    expect(getHerdChildren('p2')).toEqual(['c3']);
    expect(getHerdChildren('nobody')).toEqual([]);
    expect(isHerdParent('p1')).toBe(true);
    expect(isHerdParent('c1')).toBe(false);
  });

  it('registerHerdBond adds a child and makes the parent a parent', () => {
    registerHerdBond('c1', 'p1');
    expect(getHerdChildren('p1')).toEqual(['c1']);
    expect(isHerdParent('p1')).toBe(true);
  });

  it('re-registering a child to a new parent moves it (one parent per child)', () => {
    registerHerdBond('c1', 'p1');
    registerHerdBond('c1', 'p2');
    expect(getHerdChildren('p1')).toEqual([]);
    expect(getHerdChildren('p2')).toEqual(['c1']);
    expect(isHerdParent('p1')).toBe(false);
  });

  it('clearHerdBond removes the child; parent stops being a parent when empty', () => {
    registerHerdBond('c1', 'p1');
    clearHerdBond('c1');
    expect(getHerdChildren('p1')).toEqual([]);
    expect(isHerdParent('p1')).toBe(false);
  });

  it('clearing a deleted child leaves no ghost in the parent (regression: delete a child directly)', () => {
    // A child deleted directly (not disowned) must have its bond cleared, or it
    // lingers as a ghost that reads inactive→ready and re-wakes the parent forever.
    registerHerdBond('c1', 'p1');
    registerHerdBond('c2', 'p1');
    clearHerdBond('c1'); // simulates onSessionDeleted('c1')
    expect(getHerdChildren('p1')).toEqual(['c2']);
    expect(isHerdParent('p1')).toBe(true); // still has c2
    clearHerdBond('c2');
    expect(isHerdParent('p1')).toBe(false); // no ghosts remain
  });
});

describe('herdSignature', () => {
  it('is stable regardless of child order', () => {
    const a = [child({ sessionId: 'a' }), child({ sessionId: 'b' })];
    const b = [child({ sessionId: 'b' }), child({ sessionId: 'a' })];
    expect(herdSignature(a)).toBe(herdSignature(b));
  });

  it('changes when a child re-idles (new lastIdleAt)', () => {
    const before = [child({ sessionId: 'a', lastIdleAt: '2026-07-08T00:00:00.000Z' })];
    const after = [child({ sessionId: 'a', lastIdleAt: '2026-07-08T01:00:00.000Z' })];
    expect(herdSignature(before)).not.toBe(herdSignature(after));
  });

  it('changes when a child changes status', () => {
    const idle = [child({ sessionId: 'a', status: 'idle' })];
    const busy = [child({ sessionId: 'a', status: 'busy' })];
    expect(herdSignature(idle)).not.toBe(herdSignature(busy));
  });

  it('changes when the child set changes', () => {
    const one = [child({ sessionId: 'a' })];
    const two = [child({ sessionId: 'a' }), child({ sessionId: 'b' })];
    expect(herdSignature(one)).not.toBe(herdSignature(two));
  });
});

describe('decideHerdWake', () => {
  it('does not wake when there are no children', () => {
    expect(decideHerdWake([], false).wake).toBe(false);
  });

  it('does not wake when all children are busy (parent rests)', () => {
    const all = [child({ sessionId: 'a', status: 'busy' }), child({ sessionId: 'b', status: 'busy' })];
    expect(decideHerdWake(all, false).wake).toBe(false);
  });

  it('wakes with the count of non-active children when the parent is idle', () => {
    const kids = [child({ sessionId: 'a', status: 'busy' }), child({ sessionId: 'b', status: 'idle' }), child({ sessionId: 'c', status: 'inactive' })];
    const d = decideHerdWake(kids, false);
    expect(d.wake).toBe(true);
    expect(d.readyCount).toBe(2);
  });

  it('does not wake a busy parent even with ready children', () => {
    const kids = [child({ sessionId: 'a', status: 'idle' })];
    expect(decideHerdWake(kids, true).wake).toBe(false);
  });
});

describe('buildHerdSummary', () => {
  it('mentions the ready count and instructs caco_herd_state', () => {
    const s = buildHerdSummary([child({ sessionId: 'a', status: 'idle' }), child({ sessionId: 'b', status: 'busy' })]);
    expect(s).toMatch(/caco_herd_state/);
    expect(s).toMatch(/resume|disown/);
  });
});

describe('herd tool validation (pure)', () => {
  it('deriveChildStatus maps live flags to a status', () => {
    expect(deriveChildStatus(true, true)).toBe('busy');
    expect(deriveChildStatus(false, true)).toBe('idle');
    expect(deriveChildStatus(false, false)).toBe('inactive');
  });

  it('Guardrail 1: a child caller cannot create/acquire children', () => {
    expect(herdParentActionError('parent-123')).toMatch(/flat|cannot create/i);
    expect(herdParentActionError(undefined)).toBeNull();
  });

  it('herdAcquireError rejects self, missing, and other-owned targets', () => {
    const base = { callerId: 'p1', targetId: 't1', targetExists: true };
    expect(herdAcquireError({ ...base, targetId: 'p1' })).toMatch(/yourself/i);
    expect(herdAcquireError({ ...base, targetExists: false })).toMatch(/does not exist/i);
    expect(herdAcquireError({ ...base, targetOrchestratedBy: 'other' })).toMatch(/already a herd child/i);
    expect(herdAcquireError({ ...base })).toBeNull();
    expect(herdAcquireError({ ...base, targetOrchestratedBy: 'p1' })).toBeNull();
  });

  it("herdMemberError requires the target to be this herd's child", () => {
    expect(herdMemberError({ action: 'resume', callerId: 'p1', targetOrchestratedBy: 'p2' })).toMatch(/not a child/i);
    expect(herdMemberError({ action: 'disown', callerId: 'p1', targetOrchestratedBy: undefined })).toMatch(/not a child/i);
    expect(herdMemberError({ action: 'resume', callerId: 'p1', targetOrchestratedBy: 'p1' })).toBeNull();
  });

  it('buildHerdStatePayload wraps entries with a count', () => {
    const payload = buildHerdStatePayload([
      { sessionId: 'a', name: 'A', status: 'idle', lastIdleAt: null, lastResponse: 'done' },
    ]);
    expect(payload.count).toBe(1);
    expect(payload.children[0].lastResponse).toBe('done');
  });

  it('childIdleDecision branches on bond + parent read', () => {
    expect(childIdleDecision(undefined, 'ok')).toBe('skip');
    expect(childIdleDecision('p1', 'missing')).toBe('self-heal');
    expect(childIdleDecision('p1', 'corrupt')).toBe('skip');
    expect(childIdleDecision('p1', 'ok')).toBe('wake');
  });
});

describe('wakeParentIfNeeded (trailing-edge serialization)', () => {
  it('re-evaluates after an in-flight call — a child that idles mid-eval is still woken (M1 liveness)', async () => {
    // First eval sees all-active (no wake); the child idles during it; the
    // trailing eval must see the newly-idle child and wake.
    let statuses: HerdChild[] = [child({ sessionId: 'c1', status: 'busy' })];
    const dispatched: number[] = [];
    const deps = {
      getChildren: () => statuses,
      isParentBusy: () => false,
      dispatchWake: async (_parentId: string, readyCount: number) => { dispatched.push(readyCount); },
    };

    // Kick off the first eval; while it's queued, flip the child to idle.
    const first = wakeParentIfNeeded('p1', {
      ...deps,
      getChildren: () => { statuses = [child({ sessionId: 'c1', status: 'idle' })]; return [child({ sessionId: 'c1', status: 'busy' })]; },
    });
    const second = wakeParentIfNeeded('p1', deps);
    await Promise.all([first, second]);

    // The trailing eval saw the idle child and dispatched exactly one wake.
    expect(dispatched).toEqual([1]);
  });

  it('does not wake when the parent is busy', async () => {
    const dispatched: number[] = [];
    await wakeParentIfNeeded('p2', {
      getChildren: () => [child({ sessionId: 'c', status: 'idle' })],
      isParentBusy: () => true,
      dispatchWake: async (_p, n) => { dispatched.push(n); },
    });
    expect(dispatched).toEqual([]);
  });

  it('serializes per parent (dispatches run one at a time)', async () => {
    let active = 0;
    let maxActive = 0;
    const deps = {
      getChildren: () => [child({ sessionId: 'c', status: 'idle' })],
      isParentBusy: () => false,
      dispatchWake: async () => {
        active++; maxActive = Math.max(maxActive, active);
        await new Promise(r => setTimeout(r, 5));
        active--;
      },
    };
    await Promise.all([
      wakeParentIfNeeded('p3', deps),
      wakeParentIfNeeded('p3', deps),
      wakeParentIfNeeded('p3', deps),
    ]);
    expect(maxActive).toBe(1);
  });
});

describe('shouldParkOnDisown', () => {
  it('parks a child the herd created (provenance stamp present)', () => {
    expect(shouldParkOnDisown('parent-abc')).toBe(true);
  });

  it('does not park a child the herd merely acquired (no stamp)', () => {
    expect(shouldParkOnDisown(undefined)).toBe(false);
  });

  it('treats an empty stamp as present, not as absent', () => {
    // Presence, not truthiness: '' is a (degenerate) recorded origin, and using a
    // truthiness test here would silently reclassify it as "acquired".
    expect(shouldParkOnDisown('')).toBe(true);
  });
});
