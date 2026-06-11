/**
 * Tests for ChatFormController.
 *
 * Each form instance has its own binding, debounce timer, and
 * suppress flag. Verifies the structural property that R3 V1 relies
 * on: typing in instance A cannot affect instance B's state. Also
 * verifies the per-form cap-warning, send-time DELETE, and
 * suppress-on-restore behaviour.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../public/ts/chat-draft-api.js', () => ({
  getDraft: vi.fn(async () => null),
  putDraft: vi.fn(async () => true),
  deleteDraft: vi.fn(async () => true),
  _resetDraftQueueForTests: vi.fn(),
}));
vi.mock('../../public/ts/toast.js', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../public/ts/chat-form-popups.js', () => ({
  FormPopups: class { constructor(_ta: unknown, _anchor: unknown) {} attach() {} handleKey() { return false; } isAnyVisible() { return false; } },
  autoResize: vi.fn(),
}));
vi.mock('../../public/ts/command-registry.js', () => ({
  findCommand: vi.fn(() => null),
}));
vi.mock('../../public/ts/chat-view-controller.js', () => ({
  chatView: { getActiveForm: () => null, getLastInput: () => '' },
}));

import { ChatFormController, type DraftCache } from '../../public/ts/chat-form-controller.js';
import * as draftApi from '../../public/ts/chat-draft-api.js';
import { showToast } from '../../public/ts/toast.js';

function makeForm(): HTMLFormElement {
  // jsdom is not configured in this suite; build a minimal stand-in
  // that exposes the surface ChatFormController uses.
  const ta = {
    value: '',
    style: {} as CSSStyleDeclaration,
    addEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    setSelectionRange: vi.fn(),
  } as unknown as HTMLTextAreaElement;
  const anchor = {} as unknown as HTMLElement;
  const form = {
    querySelector: (sel: string) => {
      if (sel === 'textarea[name="message"]') return ta;
      if (sel === '.input-bar') return anchor;
      if (sel === 'input[name="imageData"]') return { value: '' } as HTMLInputElement;
      return null;
    },
    classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn() },
    addEventListener: vi.fn(),
    requestSubmit: vi.fn(),
  } as unknown as HTMLFormElement;
  // Expose textarea so tests can read/write its value.
  (form as unknown as { _ta: HTMLTextAreaElement })._ta = ta;
  return form;
}

function makeCache(): DraftCache & { _map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    _map: map,
    getDraftCache(key) { return map.get(key); },
    setDraftCache(key, val) {
      if (val.trim()) map.set(key, val);
      else map.delete(key);
    },
  };
}

describe('ChatFormController', () => {
  beforeEach(() => {
    vi.mocked(draftApi.getDraft).mockClear();
    vi.mocked(draftApi.putDraft).mockClear();
    vi.mocked(draftApi.deleteDraft).mockClear();
    vi.mocked(showToast).mockClear();
    vi.useFakeTimers();
  });

  it('bind sets binding and triggers a one-shot disk hydrate', () => {
    const form = makeForm();
    const cache = makeCache();
    const c = new ChatFormController(form, 'chatting', cache);
    c.attach();
    c.bind('s1');
    expect(c.binding).toEqual({ sessionId: 's1', key: 's1' });
    expect(draftApi.getDraft).toHaveBeenCalledWith('s1');
  });

  it('bind to the same key twice in one page-load only hydrates once', () => {
    const form = makeForm();
    const cache = makeCache();
    const c = new ChatFormController(form, 'chatting', cache);
    c.attach();
    c.bind('s1');
    c.bind('s1');
    expect(draftApi.getDraft).toHaveBeenCalledTimes(1);
  });

  it('typing updates the cache synchronously and schedules a PUT after debounce', () => {
    const form = makeForm();
    const ta = (form as unknown as { _ta: HTMLTextAreaElement })._ta;
    const cache = makeCache();
    const c = new ChatFormController(form, 'chatting', cache);
    c.attach();
    c.bind('s1');
    ta.value = 'hello';
    // Drive the listener directly (jsdom-free; the addEventListener
    // call recorded the handler).
    const handler = vi.mocked(ta.addEventListener).mock.calls.find(c => c[0] === 'input')?.[1] as () => void;
    handler();
    expect(cache._map.get('s1')).toBe('hello');
    expect(draftApi.putDraft).not.toHaveBeenCalled();  // debounced
    vi.advanceTimersByTime(1000);
    expect(draftApi.putDraft).toHaveBeenCalledWith('s1', 'hello');
  });

  it('clearOnSend cancels the pending debounce and enqueues DELETE', () => {
    const form = makeForm();
    const ta = (form as unknown as { _ta: HTMLTextAreaElement })._ta;
    const cache = makeCache();
    const c = new ChatFormController(form, 'chatting', cache);
    c.attach();
    c.bind('s1');
    ta.value = 'pending';
    const handler = vi.mocked(ta.addEventListener).mock.calls.find(c => c[0] === 'input')?.[1] as () => void;
    handler();
    vi.mocked(draftApi.putDraft).mockClear();
    c.clearOnSend();
    expect(draftApi.deleteDraft).toHaveBeenCalledWith('s1');
    // Advance past the (cancelled) debounce: no PUT should fire.
    vi.advanceTimersByTime(2000);
    expect(draftApi.putDraft).not.toHaveBeenCalled();
  });

  it('bind to a new key flushes the prior key\'s pending debounce', () => {
    const form = makeForm();
    const ta = (form as unknown as { _ta: HTMLTextAreaElement })._ta;
    const cache = makeCache();
    const c = new ChatFormController(form, 'chatting', cache);
    c.attach();
    c.bind('s1');
    ta.value = 'first';
    const handler = vi.mocked(ta.addEventListener).mock.calls.find(c => c[0] === 'input')?.[1] as () => void;
    handler();
    // Before the 1s debounce fires, bind to a new key.
    c.bind('s2');
    // The flush should have synchronously enqueued a PUT for s1.
    expect(draftApi.putDraft).toHaveBeenCalledWith('s1', 'first');
  });

  it('over-cap input skips PUT and shows toast once', () => {
    const form = makeForm();
    const ta = (form as unknown as { _ta: HTMLTextAreaElement })._ta;
    const cache = makeCache();
    const c = new ChatFormController(form, 'chatting', cache);
    c.attach();
    c.bind('s1');
    ta.value = 'x'.repeat(1024 * 1024 + 1);
    const handler = vi.mocked(ta.addEventListener).mock.calls.find(c => c[0] === 'input')?.[1] as () => void;
    handler();
    vi.advanceTimersByTime(2000);
    expect(draftApi.putDraft).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    // A second over-cap input does NOT re-warn.
    ta.value = 'x'.repeat(1024 * 1024 + 2);
    handler();
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it('two-instance isolation: typing in instance A does not affect instance B', () => {
    const cache = makeCache();
    const formA = makeForm();
    const taA = (formA as unknown as { _ta: HTMLTextAreaElement })._ta;
    const a = new ChatFormController(formA, 'chatting', cache);
    a.attach();
    a.bind('s1');

    const formB = makeForm();
    const b = new ChatFormController(formB, 'newChat', cache);
    b.attach();
    b.bind(null);

    taA.value = 'in A';
    const handlerA = vi.mocked(taA.addEventListener).mock.calls.find(c => c[0] === 'input')?.[1] as () => void;
    handlerA();

    expect(cache._map.get('s1')).toBe('in A');
    expect(cache._map.has('__newchat__')).toBe(false);
    expect(b.binding).toEqual({ sessionId: null, key: '__newchat__' });
  });

  it('clearDraft removes in-memory cache entry, cancels timer, deletes from disk', () => {
    const form = makeForm();
    const ta = (form as unknown as { _ta: HTMLTextAreaElement })._ta;
    const cache = makeCache();
    const c = new ChatFormController(form, 'chatting', cache);
    c.attach();
    c.bind('s1');
    ta.value = 'msg';
    const handler = vi.mocked(ta.addEventListener).mock.calls.find(c => c[0] === 'input')?.[1] as () => void;
    handler();
    expect(cache._map.get('s1')).toBe('msg');

    c.clearDraft();

    expect(cache._map.has('s1')).toBe(false);
    expect(draftApi.deleteDraft).toHaveBeenCalledWith('s1');

    // Pending PUT must have been cancelled: advancing past debounce
    // must not fire a putDraft for the cleared draft.
    vi.advanceTimersByTime(2000);
    expect(draftApi.putDraft).not.toHaveBeenCalled();
  });

  it('clearDraft on newchat-bound form clears the __newchat__ key', () => {
    const form = makeForm();
    const ta = (form as unknown as { _ta: HTMLTextAreaElement })._ta;
    const cache = makeCache();
    const c = new ChatFormController(form, 'newChat', cache);
    c.attach();
    c.bind(null);
    ta.value = '/restart';
    const handler = vi.mocked(ta.addEventListener).mock.calls.find(c => c[0] === 'input')?.[1] as () => void;
    handler();
    expect(cache._map.get('__newchat__')).toBe('/restart');

    c.clearDraft();

    expect(cache._map.has('__newchat__')).toBe(false);
    expect(draftApi.deleteDraft).toHaveBeenCalledWith(null);
  });
});
