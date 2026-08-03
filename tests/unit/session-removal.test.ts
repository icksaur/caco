import { describe, it, expect } from 'vitest';
import { planSessionRemoval } from '../../src/session-removal.js';

describe('planSessionRemoval', () => {
  it('archives both halves when the SDK data is present', () => {
    expect(planSessionRemoval({ hasSdkData: true, hasCacoData: true })).toEqual({ kind: 'full' });
    expect(planSessionRemoval({ hasSdkData: true, hasCacoData: false })).toEqual({ kind: 'full' });
  });

  // The bug this rule fixes: refusing here left the session in the list while
  // resume also failed for want of SDK data — un-openable AND un-removable.
  it('preserves the Caco half and removes an orphan whose SDK data is gone', () => {
    expect(planSessionRemoval({ hasSdkData: false, hasCacoData: true })).toEqual({ kind: 'orphan' });
  });

  it('drops a cache-only entry with nothing left on disk', () => {
    expect(planSessionRemoval({ hasSdkData: false, hasCacoData: false })).toEqual({ kind: 'cache-only' });
  });

  it('never refuses — every combination yields a removal plan', () => {
    for (const hasSdkData of [true, false]) {
      for (const hasCacoData of [true, false]) {
        expect(planSessionRemoval({ hasSdkData, hasCacoData }).kind).toBeTruthy();
      }
    }
  });

  it('only the full plan deletes the SDK session', () => {
    // Calling the SDK's deleteSession for a session it no longer knows about
    // would throw and re-strand the entry, so the plan must be what gates it.
    expect(planSessionRemoval({ hasSdkData: true, hasCacoData: true }).kind).toBe('full');
    expect(planSessionRemoval({ hasSdkData: false, hasCacoData: true }).kind).not.toBe('full');
    expect(planSessionRemoval({ hasSdkData: false, hasCacoData: false }).kind).not.toBe('full');
  });
});
