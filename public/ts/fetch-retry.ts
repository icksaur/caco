/**
 * fetchWithRetry — generic wrapper for flaky external HTTP calls.
 *
 * Use from applet customScript when polling APIs that occasionally fail
 * (Azure DevOps, internal services with cold-starts, third-party rate limits).
 *
 * Retries on:
 *   - Network errors (fetch throws — usually offline or DNS)
 *   - Server errors (HTTP 5xx)
 *   - Rate limits (HTTP 429)
 *   - Timeout (per-attempt timeoutMs, AbortController)
 *
 * Does NOT retry on:
 *   - Other 4xx (client error — bug or auth, retrying won't help)
 *
 * Exponential backoff with a small jitter to avoid thundering herd.
 */

export interface FetchWithRetryOptions {
  /** Number of retry attempts after the first try. Default: 3. Total attempts = retries + 1. */
  retries?: number;
  /** Per-attempt timeout in milliseconds. Default: 15000. */
  timeoutMs?: number;
  /** Base backoff in milliseconds; doubles each retry. Default: 500. */
  backoffMs?: number;
  /** Maximum backoff between retries. Default: 8000. */
  maxBackoffMs?: number;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_BACKOFF = 500;
const DEFAULT_MAX_BACKOFF = 8_000;

const isRetriableStatus = (status: number): boolean =>
  status === 429 || (status >= 500 && status <= 599);

/**
 * Run an async function with retry semantics. Decoupled from fetch so callers
 * can test backoff logic in isolation; fetchWithRetry uses this internally.
 */
export async function retryAsync<T>(
  fn: (attempt: number) => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  options: Required<Omit<FetchWithRetryOptions, 'timeoutMs'>>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms))
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === options.retries || !shouldRetry(err)) throw err;
      const base = Math.min(options.backoffMs * 2 ** attempt, options.maxBackoffMs);
      const jitter = base * 0.25 * Math.random();
      await sleep(base + jitter);
    }
  }
  throw lastErr;
}

/** Thrown when fetchWithRetry exhausts all attempts. */
export class FetchWithRetryError extends Error {
  constructor(message: string, public readonly attempts: number, public readonly lastStatus?: number) {
    super(message);
    this.name = 'FetchWithRetryError';
  }
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF;

  const attemptOnce = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (isRetriableStatus(res.status)) {
        const err: Error & { _status?: number } = new Error(`HTTP ${res.status}`);
        err._status = res.status;
        throw err;
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  };

  const shouldRetry = (err: unknown): boolean => {
    if (err instanceof Error) {
      if ((err as Error & { _status?: number })._status !== undefined) return true;
      if (err.name === 'AbortError') return true;
      // Fetch network errors throw TypeError in browsers, generic Error in Node fetch.
      return true;
    }
    return false;
  };

  try {
    return await retryAsync(
      attemptOnce,
      shouldRetry,
      { retries, backoffMs, maxBackoffMs }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as Error & { _status?: number })?._status;
    throw new FetchWithRetryError(
      `fetchWithRetry failed after ${retries + 1} attempt(s): ${message}`,
      retries + 1,
      status
    );
  }
}
