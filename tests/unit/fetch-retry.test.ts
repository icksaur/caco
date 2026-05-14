/**
 * Tests for public/ts/fetch-retry.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { retryAsync, fetchWithRetry, FetchWithRetryError } from '../../public/ts/fetch-retry.js';

describe('retryAsync', () => {
  it('resolves on first attempt without retry', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await retryAsync(
      fn,
      () => true,
      { retries: 3, backoffMs: 1, maxBackoffMs: 10 },
      async () => {} // instant sleep
    );
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to N times then throws last error', async () => {
    const fn = vi.fn(async () => { throw new Error('boom'); });
    await expect(retryAsync(
      fn,
      () => true,
      { retries: 2, backoffMs: 1, maxBackoffMs: 10 },
      async () => {}
    )).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('does not retry when shouldRetry returns false', async () => {
    const fn = vi.fn(async () => { throw new Error('fatal'); });
    await expect(retryAsync(
      fn,
      () => false,
      { retries: 5, backoffMs: 1, maxBackoffMs: 10 },
      async () => {}
    )).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns the first successful attempt after transient failures', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error('flaky');
      return 'finally';
    });
    const result = await retryAsync(
      fn,
      () => true,
      { retries: 5, backoffMs: 1, maxBackoffMs: 10 },
      async () => {}
    );
    expect(result).toBe('finally');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('backs off with exponential delay capped at maxBackoffMs', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); };
    const fn = vi.fn(async () => { throw new Error('x'); });
    await expect(retryAsync(
      fn,
      () => true,
      { retries: 4, backoffMs: 100, maxBackoffMs: 500 },
      sleep
    )).rejects.toThrow();
    // 4 retries -> 4 sleeps. Base values: 100, 200, 400, 500(capped).
    expect(sleeps.length).toBe(4);
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[0]).toBeLessThan(100 * 1.25 + 1);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200);
    expect(sleeps[1]).toBeLessThan(200 * 1.25 + 1);
    expect(sleeps[2]).toBeGreaterThanOrEqual(400);
    expect(sleeps[2]).toBeLessThan(400 * 1.25 + 1);
    expect(sleeps[3]).toBeGreaterThanOrEqual(500);
    expect(sleeps[3]).toBeLessThan(500 * 1.25 + 1);
  });
});

describe('fetchWithRetry', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const mockResponse = (status: number, body: string = ''): Response =>
    new Response(body, { status });

  it('returns response on 2xx without retry', async () => {
    const stub = vi.fn(async () => mockResponse(200, 'ok'));
    globalThis.fetch = stub as unknown as typeof fetch;
    const res = await fetchWithRetry('http://x', {}, { retries: 3, backoffMs: 1, maxBackoffMs: 5 });
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 4xx (non-429)', async () => {
    const stub = vi.fn(async () => mockResponse(404));
    globalThis.fetch = stub as unknown as typeof fetch;
    const res = await fetchWithRetry('http://x', {}, { retries: 3, backoffMs: 1, maxBackoffMs: 5 });
    expect(res.status).toBe(404);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx', async () => {
    let n = 0;
    const stub = vi.fn(async () => {
      n++;
      return mockResponse(n < 3 ? 503 : 200);
    });
    globalThis.fetch = stub as unknown as typeof fetch;
    const res = await fetchWithRetry('http://x', {}, { retries: 3, backoffMs: 1, maxBackoffMs: 5 });
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledTimes(3);
  });

  it('retries on 429', async () => {
    let n = 0;
    const stub = vi.fn(async () => {
      n++;
      return mockResponse(n < 2 ? 429 : 200);
    });
    globalThis.fetch = stub as unknown as typeof fetch;
    const res = await fetchWithRetry('http://x', {}, { retries: 3, backoffMs: 1, maxBackoffMs: 5 });
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('retries on network error (fetch throws)', async () => {
    let n = 0;
    const stub = vi.fn(async () => {
      n++;
      if (n < 2) throw new TypeError('Failed to fetch');
      return mockResponse(200);
    });
    globalThis.fetch = stub as unknown as typeof fetch;
    const res = await fetchWithRetry('http://x', {}, { retries: 3, backoffMs: 1, maxBackoffMs: 5 });
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('throws FetchWithRetryError after exhausting retries', async () => {
    const stub = vi.fn(async () => mockResponse(503));
    globalThis.fetch = stub as unknown as typeof fetch;
    await expect(fetchWithRetry('http://x', {}, { retries: 2, backoffMs: 1, maxBackoffMs: 5 }))
      .rejects.toThrow(FetchWithRetryError);
    expect(stub).toHaveBeenCalledTimes(3);
  });

  it('FetchWithRetryError carries lastStatus and attempts', async () => {
    const stub = vi.fn(async () => mockResponse(503));
    globalThis.fetch = stub as unknown as typeof fetch;
    try {
      await fetchWithRetry('http://x', {}, { retries: 2, backoffMs: 1, maxBackoffMs: 5 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FetchWithRetryError);
      expect((err as FetchWithRetryError).attempts).toBe(3);
      expect((err as FetchWithRetryError).lastStatus).toBe(503);
    }
  });

  it('aborts on timeout and treats it as retriable', async () => {
    let n = 0;
    const stub = vi.fn((_url: string, init?: RequestInit) => {
      n++;
      if (n === 1) {
        // First attempt: never resolves; abort signal will fire.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return Promise.resolve(mockResponse(200));
    });
    globalThis.fetch = stub as unknown as typeof fetch;
    const res = await fetchWithRetry('http://x', {}, { retries: 2, timeoutMs: 10, backoffMs: 1, maxBackoffMs: 5 });
    expect(res.status).toBe(200);
    expect(stub).toHaveBeenCalledTimes(2);
  });
});
