/**
 * Tests for form-state-store singleton.
 *
 * Covers the contract relied on by message-streaming.ts's updateButton
 * subscriber and the chat-input typing path. See
 * docs/chat-form-refactor.md §"Phase R1".
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  formStateStore,
  _resetFormStateForTests,
} from '../../public/ts/form-state-store.js';

describe('formStateStore', () => {
  beforeEach(() => {
    _resetFormStateForTests();
  });

  it('initial state is empty options, not busy, no text', () => {
    const s = formStateStore.get();
    expect(s.options).toEqual([]);
    expect(s.sessionBusy).toBe(false);
    expect(s.hasText).toBe(false);
  });

  it('set notifies subscribers on actual change', () => {
    const fn = vi.fn();
    formStateStore.subscribe(fn);
    formStateStore.set({ hasText: true });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(formStateStore.get().hasText).toBe(true);
  });

  it('set is a no-op when every field matches current state', () => {
    formStateStore.set({ hasText: true });
    const fn = vi.fn();
    formStateStore.subscribe(fn);
    formStateStore.set({ hasText: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it('options change detected element-wise (distinct arrays of equal contents do NOT notify)', () => {
    formStateStore.set({ options: ['a', 'b'] });
    const fn = vi.fn();
    formStateStore.subscribe(fn);
    formStateStore.set({ options: ['a', 'b'] });  // distinct array, same contents
    expect(fn).not.toHaveBeenCalled();
    formStateStore.set({ options: ['a', 'b', 'c'] });  // real change
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stored options are frozen — mutation throws in strict mode', () => {
    formStateStore.set({ options: ['a', 'b'] });
    const stored = formStateStore.get().options;
    expect(() => {
      (stored as string[]).push('c');
    }).toThrow();
  });

  it('multiple subscribers all receive the notification', () => {
    const a = vi.fn();
    const b = vi.fn();
    formStateStore.subscribe(a);
    formStateStore.subscribe(b);
    formStateStore.set({ sessionBusy: true });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops further notifications for that subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    const disposeA = formStateStore.subscribe(a);
    formStateStore.subscribe(b);
    disposeA();
    formStateStore.set({ sessionBusy: true });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('partial set leaves untouched fields unchanged', () => {
    formStateStore.set({ hasText: true, sessionBusy: true });
    formStateStore.set({ hasText: false });
    const s = formStateStore.get();
    expect(s.hasText).toBe(false);
    expect(s.sessionBusy).toBe(true);  // unchanged
  });
});
