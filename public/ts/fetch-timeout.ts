/**
 * Fetch with timeout.
 * Rejects with a descriptive error if the request doesn't complete in time.
 */
export function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    fetch(url, { ...options, signal: controller.signal })
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}
