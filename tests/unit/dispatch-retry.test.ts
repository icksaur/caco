import { describe, expect, it, vi } from 'vitest';
import { retryWithFreshClient } from '../../src/dispatch-retry.js';

describe('retryWithFreshClient', () => {
  it('aborts the original generation, then runs beforeSend after resume and before retry send', async () => {
    const calls: string[] = [];
    const unsubscribe = vi.fn(() => calls.push('unsubscribe-original'));
    const retryUnsubscribe = vi.fn();
    const retrySession = {
      on: vi.fn(() => {
        calls.push('subscribe');
        return retryUnsubscribe;
      }),
      send: vi.fn(async () => {
        calls.push('send');
      }),
    };

    const result = await retryWithFreshClient({
      sessionId: 's1',
      messageOptions: { prompt: 'hello' },
      handleEvent: vi.fn(),
      abortOriginal: vi.fn(async () => { calls.push('abort-original'); return true; }),
      dropStaleSession: vi.fn(() => calls.push('drop')),
      ensureClientHealthy: vi.fn(async () => { calls.push('healthy'); }),
      resume: vi.fn(async () => { calls.push('resume'); }),
      getSession: vi.fn(() => retrySession),
      beforeSend: vi.fn(async () => { calls.push('beforeSend'); }),
      resetWatchdog: vi.fn(() => calls.push('resetWatchdog')),
      unsubscribe,
    });

    expect(result).toBe(retryUnsubscribe);
    // The original generation is aborted BEFORE dropping it, so it stops
    // writing to events.jsonl and cannot double the persisted transcript.
    expect(calls).toEqual([
      'abort-original',
      'unsubscribe-original',
      'drop',
      'healthy',
      'resume',
      'subscribe',
      'beforeSend',
      'send',
      'resetWatchdog',
    ]);
  });

  it('does NOT resend when the original could not be confirmed stopped (abort returns false)', async () => {
    const unsubscribe = vi.fn();
    const send = vi.fn();
    const result = await retryWithFreshClient({
      sessionId: 's1',
      messageOptions: { prompt: 'hello' },
      handleEvent: vi.fn(),
      abortOriginal: vi.fn(async () => false),
      dropStaleSession: vi.fn(),
      ensureClientHealthy: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      getSession: vi.fn(() => ({ on: vi.fn(), send })),
      resetWatchdog: vi.fn(),
      unsubscribe,
    });
    // Bailed: no resend (no second writer), original left in place (not unsubscribed).
    expect(result).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('does NOT resend when the dispatch already completed during the abort', async () => {
    const send = vi.fn();
    const result = await retryWithFreshClient({
      sessionId: 's1',
      messageOptions: { prompt: 'hello' },
      handleEvent: vi.fn(),
      abortOriginal: vi.fn(async () => true),
      isCompleted: vi.fn(() => true),
      dropStaleSession: vi.fn(),
      ensureClientHealthy: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      getSession: vi.fn(() => ({ on: vi.fn(), send })),
      resetWatchdog: vi.fn(),
      unsubscribe: vi.fn(),
    });
    expect(result).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('proceeds with the retry when abortOriginal throws (treated as unsafe → bail)', async () => {
    const send = vi.fn();
    const result = await retryWithFreshClient({
      sessionId: 's1',
      messageOptions: { prompt: 'hello' },
      handleEvent: vi.fn(),
      abortOriginal: vi.fn(async () => { throw new Error('abort failed'); }),
      dropStaleSession: vi.fn(),
      ensureClientHealthy: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      getSession: vi.fn(() => ({ on: vi.fn(), send })),
      resetWatchdog: vi.fn(),
      unsubscribe: vi.fn(),
    });
    // A thrown abort is unsafe → bail, do not add a second writer.
    expect(result).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('tears down the retry listener if send fails after subscribing', async () => {
    const retryUnsubscribe = vi.fn();
    const retrySession = {
      on: vi.fn(() => retryUnsubscribe),
      send: vi.fn(async () => { throw new Error('Session not found'); }),
    };

    const result = await retryWithFreshClient({
      sessionId: 's1',
      messageOptions: { prompt: 'hello' },
      handleEvent: vi.fn(),
      dropStaleSession: vi.fn(),
      ensureClientHealthy: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      getSession: vi.fn(() => retrySession),
      resetWatchdog: vi.fn(),
      unsubscribe: vi.fn(),
    });

    expect(result).toBeNull();
    // The leaked-listener regression: the new subscription must be removed.
    expect(retryUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not call a listener teardown when resume fails before subscribing', async () => {
    const retryUnsubscribe = vi.fn();
    const result = await retryWithFreshClient({
      sessionId: 's1',
      messageOptions: { prompt: 'hello' },
      handleEvent: vi.fn(),
      dropStaleSession: vi.fn(),
      ensureClientHealthy: vi.fn(async () => {}),
      resume: vi.fn(async () => { throw new Error('resume failed'); }),
      getSession: vi.fn(() => ({ on: vi.fn(() => retryUnsubscribe), send: vi.fn() })),
      resetWatchdog: vi.fn(),
      unsubscribe: vi.fn(),
    });

    expect(result).toBeNull();
    expect(retryUnsubscribe).not.toHaveBeenCalled();
  });
});
