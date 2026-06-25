import { describe, it, expect } from 'vitest';
import { getSessionRuntime, disposeSessionRuntime } from '../../src/session-runtime.js';
import { recordUsage, getThroughput } from '../../src/session-throughput.js';
import { setSessionUsage, getSessionUsage } from '../../src/session-usage-cache.js';

describe('SessionRuntime', () => {
  it('returns a stable runtime for a session id', () => {
    const id = 'rt-stable-' + Date.now();
    const a = getSessionRuntime(id);
    const b = getSessionRuntime(id);
    expect(a).toBe(b);
    disposeSessionRuntime(id);
  });

  it('dispose drops throughput and usage for the session', () => {
    const id = 'rt-dispose-' + Date.now();
    const runtime = getSessionRuntime(id);
    recordUsage(id, { inputTokens: 100, outputTokens: 20 });
    setSessionUsage(id, { tokenLimit: 1000, currentTokens: 120 });

    expect(getThroughput(id)).toBeDefined();
    expect(getSessionUsage(id)).toBeDefined();

    disposeSessionRuntime(id);

    expect(getThroughput(id)).toBeUndefined();
    expect(getSessionUsage(id)).toBeUndefined();
    // A new runtime is a fresh instance (old one discarded).
    const fresh = getSessionRuntime(id);
    expect(fresh).not.toBe(runtime);
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
