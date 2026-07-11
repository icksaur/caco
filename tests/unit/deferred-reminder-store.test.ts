import { describe, it, expect } from 'vitest';
import { computeDeferredReminder, clearDeferredReminder } from '../../src/deferred-reminder-store.js';
import { cacoKey } from '../../src/tool-key.js';
import type { ToolKey } from '../../src/tool-key.js';

const S = 'session-1';
const keys = (...ns: string[]): ToolKey[] => ns.map(n => cacoKey(n));

/** Compute + commit in one step (the common path once a send is in flight). */
function emit(sessionId: string, ks: ToolKey[]): string | null {
  const r = computeDeferredReminder(sessionId, ks);
  r.commit();
  return r.text;
}

describe('deferred-reminder-store — change-triggered emission', () => {
  it('emits on first dispatch (no prior signature)', () => {
    clearDeferredReminder(S);
    const out = emit(S, keys('caco_docs', 'get_applet_state'));
    expect(out).toContain('<deferred_tools>');
    expect(out).toContain('caco_docs, get_applet_state');
  });

  it('suppresses an unchanged set on the next dispatch', () => {
    clearDeferredReminder(S);
    expect(emit(S, keys('a', 'b'))).not.toBeNull();
    expect(emit(S, keys('a', 'b'))).toBeNull();
  });

  it('re-emits when the set changes (order-insensitive signature)', () => {
    clearDeferredReminder(S);
    expect(emit(S, keys('a', 'b'))).not.toBeNull();
    expect(emit(S, keys('b', 'a'))).toBeNull();       // same set, reordered
    expect(emit(S, keys('a'))).not.toBeNull();        // shrank → re-emit
  });

  it('emits nothing for an empty deferred set and re-emits once it repopulates', () => {
    clearDeferredReminder(S);
    expect(emit(S, keys('a'))).not.toBeNull();
    expect(emit(S, [])).toBeNull();
    expect(emit(S, keys('a'))).not.toBeNull();        // empty cleared the sig
  });

  it('clearDeferredReminder forces a re-emit of the same set (compaction boundary)', () => {
    clearDeferredReminder(S);
    expect(emit(S, keys('a', 'b'))).not.toBeNull();
    expect(emit(S, keys('a', 'b'))).toBeNull();
    clearDeferredReminder(S);
    expect(emit(S, keys('a', 'b'))).not.toBeNull();   // re-emitted after boundary
  });

  it('tracks sessions independently', () => {
    clearDeferredReminder('x');
    clearDeferredReminder('y');
    expect(emit('x', keys('a'))).not.toBeNull();
    expect(emit('y', keys('a'))).not.toBeNull();      // different session, own sig
    expect(emit('x', keys('a'))).toBeNull();
  });

  // MUST invariant-4: a computed-but-uncommitted reminder (pre-send failure) must NOT
  // advance the signature, so the same set re-emits on the next dispatch.
  it('does not advance the signature until commit() is called', () => {
    clearDeferredReminder(S);
    expect(computeDeferredReminder(S, keys('a', 'b')).text).not.toBeNull(); // computed, NOT committed
    const second = computeDeferredReminder(S, keys('a', 'b'));
    expect(second.text).not.toBeNull();                                     // still re-emits
    second.commit();
    expect(computeDeferredReminder(S, keys('a', 'b')).text).toBeNull();     // now suppressed
  });
});
