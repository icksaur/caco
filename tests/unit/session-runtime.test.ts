import { describe, it, expect } from 'vitest';
import { getSessionRuntime, disposeSessionRuntime } from '../../src/session-runtime.js';
import { recordUsage, getThroughput } from '../../src/session-throughput.js';
import { setSessionUsage, getSessionUsage } from '../../src/session-usage-cache.js';

describe('SessionRuntime', () => {
  it('returns a stable runtime + queue for a session id', () => {
    const id = 'rt-stable-' + Date.now();
    const a = getSessionRuntime(id);
    const b = getSessionRuntime(id);
    expect(a).toBe(b);
    expect(a.queue).toBe(b.queue);
    disposeSessionRuntime(id);
  });

  it('dispose drops the queue, throughput, and usage for the session', () => {
    const id = 'rt-dispose-' + Date.now();
    const runtime = getSessionRuntime(id);
    runtime.queue.queue({ type: 'caco.embed', data: { html: '<b>x</b>' } } as never);
    recordUsage(id, { inputTokens: 100, outputTokens: 20 });
    setSessionUsage(id, { tokenLimit: 1000, currentTokens: 120 });

    expect(runtime.queue.hasPending()).toBe(true);
    expect(getThroughput(id)).toBeDefined();
    expect(getSessionUsage(id)).toBeDefined();

    disposeSessionRuntime(id);

    expect(getThroughput(id)).toBeUndefined();
    expect(getSessionUsage(id)).toBeUndefined();
    // A new runtime is a fresh instance with an empty queue (old one discarded).
    const fresh = getSessionRuntime(id);
    expect(fresh).not.toBe(runtime);
    expect(fresh.queue.hasPending()).toBe(false);
    disposeSessionRuntime(id);
  });

  it('dispose is idempotent under repeated calls', () => {
    const id = 'rt-idempotent-' + Date.now();
    getSessionRuntime(id);
    expect(() => {
      disposeSessionRuntime(id);
      disposeSessionRuntime(id);
    }).not.toThrow();
  });
});
