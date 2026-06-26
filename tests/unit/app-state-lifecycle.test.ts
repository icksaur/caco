import { describe, it, expect, vi } from 'vitest';
import { onSessionActivate, notifySessionActivated, type SessionActivateCtx } from '../../public/ts/app-state.js';

const ctx: SessionActivateCtx = { sessionId: 's1', cwd: '/c', info: { sessionId: 's1', cwd: '/c' } };

describe('onSessionActivate / notifySessionActivated', () => {
  it('runs subscribers in registration order with the ctx', () => {
    const calls: string[] = [];
    const a = onSessionActivate(() => calls.push('a'));
    const b = onSessionActivate(() => calls.push('b'));
    notifySessionActivated(ctx);
    expect(calls).toEqual(['a', 'b']);
    a(); b();
  });

  it('passes the exact ctx to each subscriber', () => {
    const seen: SessionActivateCtx[] = [];
    const off = onSessionActivate(c => seen.push(c));
    notifySessionActivated(ctx);
    expect(seen).toEqual([ctx]);
    off();
  });

  it('isolates a throwing subscriber so later ones still run', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[] = [];
    const a = onSessionActivate(() => { throw new Error('boom'); });
    const b = onSessionActivate(() => calls.push('b'));
    expect(() => notifySessionActivated(ctx)).not.toThrow();
    expect(calls).toEqual(['b']);
    errSpy.mockRestore();
    a(); b();
  });

  it('unsubscribe stops a subscriber from firing', () => {
    let count = 0;
    const off = onSessionActivate(() => { count++; });
    notifySessionActivated(ctx);
    off();
    notifySessionActivated(ctx);
    expect(count).toBe(1);
  });
});
