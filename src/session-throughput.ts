/**
 * Per-session throughput accumulator.
 *
 * "Request" = one user send through its full multi-turn lifetime
 * (send -> idle). Request counters are reset by resetRequest() at the
 * start of a fresh dispatch (see dispatchMessage); they accumulate
 * across every assistant turn + subagent call within the request and
 * persist after the session goes idle, until the next send. Steering
 * (sendStream, not dispatchMessage) does NOT reset -- it adds to the
 * ongoing request.
 *
 * Token classes match the model billing JSON (in / out / cache):
 *  - `in`    = fresh (non-cached) input  = inputTokens - cacheReadTokens
 *  - `cache` = cached input read         = cacheReadTokens
 *  - `out`   = output                    = outputTokens
 * `inputTokens` from the SDK is the TOTAL prompt; cacheReadTokens is a
 * subset of it (verified: cacheRead + cacheWrite ~= inputTokens). So the
 * billing-correct split charges (input - cacheRead) at the input rate and
 * cacheRead at the cache rate.
 *
 * `total*` counters accumulate for the session's whole server lifetime
 * (footer tooltip). Nothing is persisted across restart.
 */

interface SessionThroughput {
  requestIn: number;
  requestCache: number;
  requestOut: number;
  totalIn: number;
  totalCache: number;
  totalOut: number;
  rateLimitCount: number;
  lastRateLimitAt?: string;
  /** Session-lifetime estimate of context tokens saved by caco_run_workflow runs. */
  workflowSavedTokens: number;
  /** Number of workflow runs that contributed savings this session. */
  workflowRuns: number;
  /** Session-lifetime tokens saved by output shaping (exact bytes trimmed / 4). */
  shapingSavedTokens: number;
  /** Number of tool outputs the shaper trimmed this session. */
  shapingShapeCount: number;
  updatedAt: string;
}

export interface ThroughputSnapshot extends SessionThroughput {
  known: boolean;
}

const sessions = new Map<string, SessionThroughput>();

function now(): string {
  return new Date().toISOString();
}

function safeInt(value: unknown): number {
  return typeof value === 'number' && isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Approximate chars per token, used to convert saved bytes into a token
 *  estimate for both the workflow estimate and the exact shaping measurement. */
export const BYTES_PER_TOKEN = 4;

function blank(): SessionThroughput {
  return {
    requestIn: 0,
    requestCache: 0,
    requestOut: 0,
    totalIn: 0,
    totalCache: 0,
    totalOut: 0,
    rateLimitCount: 0,
    workflowSavedTokens: 0,
    workflowRuns: 0,
    shapingSavedTokens: 0,
    shapingShapeCount: 0,
    updatedAt: now(),
  };
}

function getOrCreate(sessionId: string): SessionThroughput {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = blank();
    sessions.set(sessionId, entry);
  }
  return entry;
}

export function recordUsage(
  sessionId: string,
  tokens: { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown },
): void {
  const entry = getOrCreate(sessionId);
  const input = safeInt(tokens.inputTokens);
  const cache = safeInt(tokens.cacheReadTokens);
  const out = safeInt(tokens.outputTokens);
  const fresh = Math.max(0, input - cache);
  entry.requestIn += fresh;
  entry.requestCache += cache;
  entry.requestOut += out;
  entry.totalIn += fresh;
  entry.totalCache += cache;
  entry.totalOut += out;
  entry.updatedAt = now();
}

export function recordRateLimit(sessionId: string): void {
  const entry = getOrCreate(sessionId);
  entry.rateLimitCount += 1;
  entry.lastRateLimitAt = now();
  entry.updatedAt = now();
}

/**
 * Record an estimate of context tokens a single workflow run avoided. These are
 * session-lifetime (like total*) and are NOT cleared by resetRequest, since the
 * saving describes work that already happened.
 */
export function recordWorkflowSavings(sessionId: string, savedTokens: number): void {
  const tokens = safeInt(savedTokens);
  if (tokens <= 0) return;
  const entry = getOrCreate(sessionId);
  entry.workflowSavedTokens += tokens;
  entry.workflowRuns += 1;
  entry.updatedAt = now();
}

/**
 * Record context tokens trimmed by the output-shaping hook on one tool result.
 * Unlike the workflow estimate this is an EXACT measurement (raw minus shaped
 * bytes / 4), accumulating on ordinary bash/test/build output. Session-lifetime
 * like total*; NOT cleared by resetRequest.
 */
export function recordShapingSavings(sessionId: string, savedTokens: number): void {
  const tokens = safeInt(savedTokens);
  if (tokens <= 0) return;
  const entry = getOrCreate(sessionId);
  entry.shapingSavedTokens += tokens;
  entry.shapingShapeCount += 1;
  entry.updatedAt = now();
}

/**
 * Reset request-scoped counters at the start of a fresh user send.
 * Clears request in/cache/out + the 429 count (these describe "the
 * current request"); preserves session-lifetime totals.
 */
export function resetRequest(sessionId: string): void {
  const entry = getOrCreate(sessionId);
  entry.requestIn = 0;
  entry.requestCache = 0;
  entry.requestOut = 0;
  entry.rateLimitCount = 0;
  entry.lastRateLimitAt = undefined;
  entry.updatedAt = now();
}

export function getThroughput(sessionId: string): SessionThroughput | undefined {
  return sessions.get(sessionId);
}

export function snapshot(sessionId: string): ThroughputSnapshot {
  const entry = sessions.get(sessionId);
  if (!entry) {
    return { ...blank(), known: false };
  }
  return { ...entry, known: true };
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}
