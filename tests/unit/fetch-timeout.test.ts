import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithTimeout } from '../../public/ts/fetch-timeout.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchWithTimeout', () => {
  it('resolves with the response when fetch completes in time, passing an abort signal', async () => {
    const resp = { ok: true } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(resp);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithTimeout('/x', { method: 'GET' }, 1000)).resolves.toBe(resp);
    expect(fetchMock).toHaveBeenCalledWith('/x', expect.objectContaining({
      method: 'GET',
      signal: expect.any(AbortSignal),
    }));
  });

  it('rejects with a descriptive timeout error (rounded seconds) when fetch is too slow', async () => {
    vi.useFakeTimers();
    // A fetch that only settles when its signal is aborted.
    const fetchMock = vi.fn().mockImplementation((_url: string, opts: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const p = fetchWithTimeout('/slow', {}, 2000);
    const assertion = expect(p).rejects.toThrow('Request timed out after 2s');
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    // The timer aborts the in-flight request.
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('propagates a fetch rejection (network error) unchanged', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network fail'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWithTimeout('/x', {}, 1000)).rejects.toThrow('network fail');
  });
});
