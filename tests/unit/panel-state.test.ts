/**
 * Tests for public/ts/panel-state.ts
 *
 * The store is pure data — no DOM, no async. Tests assert invariants from
 * panel-state-architecture.md §5 as requirements.
 */

import { describe, it, expect, vi } from 'vitest';
import { createPanelStateStore, deviceClass } from '../../public/ts/panel-state.js';

describe('PanelStateStore', () => {
  it('starts with the provided initial state', () => {
    const s = createPanelStateStore({ session: false, applet: true });
    expect(s.get()).toEqual({ session: false, applet: true });
  });

  it('user toggling the applet button is the only mutation that flips applet visibility', () => {
    const s = createPanelStateStore({ session: false, applet: false });
    s.set({ applet: true }, 'user-toggle-applet');
    expect(s.get().applet).toBe(true);
    s.set({ applet: false }, 'user-toggle-applet');
    expect(s.get().applet).toBe(false);
  });

  it('selecting a session does NOT change applet visibility', () => {
    const s = createPanelStateStore({ session: true, applet: true });
    s.set({ session: false }, 'user-session-pick');
    expect(s.get().applet).toBe(true);

    const s2 = createPanelStateStore({ session: true, applet: false });
    s2.set({ session: false }, 'user-session-pick');
    expect(s2.get().applet).toBe(false);
  });

  it('toggling the session panel does NOT change applet visibility', () => {
    const s = createPanelStateStore({ session: false, applet: true });
    s.set({ session: true }, 'user-toggle-session');
    expect(s.get().applet).toBe(true);
    s.set({ session: false }, 'user-toggle-session');
    expect(s.get().applet).toBe(true);
  });

  it('toggling the applet panel does NOT change session visibility', () => {
    const s = createPanelStateStore({ session: true, applet: false });
    s.set({ applet: true }, 'user-toggle-applet');
    expect(s.get().session).toBe(true);
    s.set({ applet: false }, 'user-toggle-applet');
    expect(s.get().session).toBe(true);
  });

  it('rapid session selections never re-show a closed applet panel', () => {
    // Whatever sequence of user-session-pick events fire, applet stays at
    // its last user-set value.
    const s = createPanelStateStore({ session: false, applet: false });
    for (let i = 0; i < 50; i++) {
      s.set({ session: false }, 'user-session-pick');
    }
    expect(s.get().applet).toBe(false);
  });

  it('the deep-link rule shows the applet panel exactly once', () => {
    const s = createPanelStateStore({ session: false, applet: false });
    s.set({ applet: true }, 'deep-link');
    expect(s.get().applet).toBe(true);
    // After that, only user toggles change it. Even another deep-link is ignored
    // by convention (deep-link is a startup-only signal) — but the store doesn't
    // enforce this; callers do. The store just records.
    s.set({ applet: false }, 'user-toggle-applet');
    expect(s.get().applet).toBe(false);
  });

  it('subscribers receive next, previous, and reason on every transition', () => {
    const s = createPanelStateStore({ session: false, applet: false });
    const calls: Array<{ next: unknown; prev: unknown; reason: string }> = [];
    s.subscribe((next, prev, reason) => {
      calls.push({ next: { ...next }, prev: { ...prev }, reason });
    });
    s.set({ session: true }, 'user-toggle-session');
    s.set({ applet: true }, 'user-toggle-applet');
    expect(calls).toEqual([
      { next: { session: true, applet: false }, prev: { session: false, applet: false }, reason: 'user-toggle-session' },
      { next: { session: true, applet: true }, prev: { session: true, applet: false }, reason: 'user-toggle-applet' },
    ]);
  });

  it('subscribers are NOT called when set is a no-op', () => {
    const s = createPanelStateStore({ session: true, applet: false });
    const fn = vi.fn();
    s.subscribe(fn);
    s.set({ session: true }, 'user-toggle-session');
    s.set({ session: true, applet: false }, 'user-toggle-session');
    expect(fn).not.toHaveBeenCalled();
  });

  it('subscribers can unsubscribe', () => {
    const s = createPanelStateStore({ session: false, applet: false });
    const fn = vi.fn();
    const unsub = s.subscribe(fn);
    s.set({ session: true }, 'user-toggle-session');
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    s.set({ applet: true }, 'user-toggle-applet');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not prevent other subscribers from running', () => {
    const s = createPanelStateStore({ session: false, applet: false });
    const fn1 = vi.fn(() => { throw new Error('boom'); });
    const fn2 = vi.fn();
    s.subscribe(fn1);
    s.subscribe(fn2);
    s.set({ session: true }, 'user-toggle-session');
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('partial patches do not stomp the unspecified field', () => {
    const s = createPanelStateStore({ session: true, applet: true });
    s.set({ session: false }, 'user-toggle-session');
    expect(s.get()).toEqual({ session: false, applet: true });
    s.set({ applet: false }, 'user-toggle-applet');
    expect(s.get()).toEqual({ session: false, applet: false });
  });
});

describe('deviceClass', () => {
  it('returns "desktop" when window.matchMedia is unavailable (node env)', () => {
    expect(deviceClass()).toBe('desktop');
  });
});
