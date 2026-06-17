import { describe, expect, it, vi } from 'vitest';
import { retryWithFreshClient } from '../../src/dispatch-retry.js';

describe('retryWithFreshClient', () => {
  it('runs beforeSend after resume and before retry send', async () => {
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
      dropStaleSession: vi.fn(() => calls.push('drop')),
      ensureClientHealthy: vi.fn(async () => { calls.push('healthy'); }),
      resume: vi.fn(async () => { calls.push('resume'); }),
      getSession: vi.fn(() => retrySession),
      beforeSend: vi.fn(async () => { calls.push('beforeSend'); }),
      resetWatchdog: vi.fn(() => calls.push('resetWatchdog')),
      unsubscribe,
    });

    expect(result).toBe(retryUnsubscribe);
    expect(calls).toEqual([
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
});
