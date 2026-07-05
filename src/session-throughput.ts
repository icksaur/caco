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

import { BATCH_WARMUP_TURNS } from './config.js';
import type { ToolKey } from './tool-key.js';

interface SessionThroughput {
  requestIn: number;
  requestCache: number;
  requestOut: number;
  totalIn: number;
  totalCache: number;
  totalOut: number;
  /** Cache-WRITE tokens (fresh prefix written to cache) this request + lifetime, and
   *  the most recent turn's value. A reveal that busts the prompt-cache shows up as a
   *  spike in lastCacheWriteTokens — the cache-bust oracle for spec-tool-reveal B0/C. */
  requestCacheWrite: number;
  totalCacheWrite: number;
  lastCacheWriteTokens: number;
  /** Cache-READ tokens on the most recent turn (the warm-cache HIT). Paired with
   *  lastCacheWriteTokens it shows the last turn's hit/miss split: high read = warm,
   *  high write = cold/busted cache. */
  lastCacheReadTokens: number;
  rateLimitCount: number;
  lastRateLimitAt?: string;
  /** Session-lifetime estimate of context tokens saved by caco_run_workflow runs. */
  workflowSavedTokens: number;
  /** Number of workflow runs that contributed savings this session. */
  workflowRuns: number;
  /** Session-lifetime virtual tool calls avoided (breadth; commandCount-1 summed). */
  workflowVirtualCallsAvoided: number;
  /** Session-lifetime conservative model round trips saved (parallel-discounted). */
  workflowRoundTripsSaved: number;
  /** Session-lifetime optimistic "if sequential" window-replay tokens (cache class). */
  workflowCacheReplaySaved: number;
  /** Session-lifetime compounding cache tokens saved by absent context on later turns. */
  workflowCacheCompoundSaved: number;
  /** Session-lifetime signed net output tokens spent (script minus avoided tool args). */
  workflowOutputDelta: number;
  /** Round trips saved by workflows in the CURRENT request (reset each send). */
  requestRoundTripsSaved: number;
  /** Session-lifetime wall-clock ms saved by avoided round trips
   *  (sum over requests of (requestWall/requestTurns) * requestRoundTripsSaved). */
  workflowTimeSavedMs: number;
  /** Promoted avoided context that compounds on each later round trip (cache class). */
  avoidedContextTokens: number;
  /** Freshly-saved context awaiting promotion (deferred one turn to avoid double-count). */
  pendingAvoidedContext: number;
  /** Prompt-token size W from the most recent round trip (0 until requestTurns > 0). */
  lastInputTokens: number;
  /** Session-lifetime wall-clock ms across completed requests (for avg turn latency). */
  totalWallMs: number;
  /** Session-lifetime tokens saved by output shaping (exact bytes trimmed / 4). */
  shapingSavedTokens: number;
  /** Number of tool outputs the shaper trimmed this session. */
  shapingShapeCount: number;
  /** Model round trips (assistant.usage events) in the current request. */
  requestTurns: number;
  /** Reasoning tokens decoded in the current request. */
  requestReasoning: number;
  /** Tool calls completed in the current request. */
  requestToolCalls: number;
  /** Tool calls that failed in the current request. */
  requestToolFailures: number;
  /** Bytes of caco_run_workflow code submitted in the current request. */
  requestWorkflowCodeBytes: number;
  /** Wall-clock ms of the last completed request (set by markRequestComplete). */
  requestWallMs: number;
  /** Epoch ms the current request started (set by resetRequest). */
  requestStartedAt: number;
  /** Session-lifetime model round trips. */
  totalTurns: number;
  /** Session-lifetime reasoning tokens. */
  totalReasoning: number;
  /** Session-lifetime tool calls. */
  totalToolCalls: number;
  /** Session-lifetime failed tool calls. */
  totalToolFailures: number;
  /** Session-lifetime SUM of the per-turn omitted-definition estimate (spec
   *  -deferred-savings S8). Accrued once per model round trip in recordUsage from
   *  the injected deferredDefsProvider — an OPTIMISTIC estimate of deferred tool
   *  definition tokens omitted from each sent tool block, priced at the cache rate
   *  in the footer. Not persisted across restart; never reset by resetRequest. */
  deferredDefsTokensAccrued: number;
  updatedAt: string;
}

/** The per-request metrics row captured at request completion (for the bench log). */
export interface RequestMetricsRow {
  requestIn: number;
  requestCache: number;
  requestOut: number;
  requestTurns: number;
  requestReasoning: number;
  requestToolCalls: number;
  requestToolFailures: number;
  requestWorkflowCodeBytes: number;
  requestWallMs: number;
  rateLimitCount: number;
}

export interface ThroughputSnapshot extends SessionThroughput {
  known: boolean;
  /** Gross per-turn definition tokens CURRENTLY omitted by dynamic deferral (spec
   *  -deferred-savings S6). An estimate of omitted known definitions — NOT a proven
   *  saving and deliberately NOT folded into the net-credit headline. Populated by an
   *  injected provider (session-manager owns the excluded set + size store); absent
   *  when no provider is registered. */
  deferredDefsTokens?: number;
  /** Count of the session's currently dynamically-deferred tools. */
  deferredDefsCount?: number;
  /** How many of those have no known size yet (never observed) — the honesty caveat. */
  deferredDefsUnknown?: number;
}

/** The gross deferred-definition figure for a session. Injected (not imported) so
 *  session-throughput stays free of a session-manager dependency (which imports it). */
export type DeferredDefsProvider = (sessionId: string) => {
  deferredDefsTokens: number;
  deferredDefsCount: number;
  deferredDefsUnknown: number;
};

let deferredDefsProvider: DeferredDefsProvider | null = null;

/** Register the provider that enriches each snapshot with the current-turn deferred
 *  definition figure. Called once at wiring time by the owner of the tool state. */
export function setDeferredDefsProvider(fn: DeferredDefsProvider): void {
  deferredDefsProvider = fn;
}

const sessions = new Map<string, SessionThroughput>();

// Per-session "used-here" set: the canonical ToolKeys the agent has invoked this
// session. Kept SEPARATE from the throughput accumulator (and out of the broadcast
// snapshot) because it is a Set, not a numeric metric. Consumed by the tool-reveal
// C-phase: a tool used in this session is sticky-enabled and never auto-deferred here.
// This is the per-session layer; the system-wide persistent active-seconds store is
// a separate concern (tool-usage-store, C1).
const toolsUsedBySession = new Map<string, Set<ToolKey>>();

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
    requestCacheWrite: 0,
    totalCacheWrite: 0,
    lastCacheWriteTokens: 0,
    lastCacheReadTokens: 0,
    rateLimitCount: 0,
    workflowSavedTokens: 0,
    workflowRuns: 0,
    workflowVirtualCallsAvoided: 0,
    workflowRoundTripsSaved: 0,
    workflowCacheReplaySaved: 0,
    workflowCacheCompoundSaved: 0,
    workflowOutputDelta: 0,
    requestRoundTripsSaved: 0,
    workflowTimeSavedMs: 0,
    avoidedContextTokens: 0,
    pendingAvoidedContext: 0,
    lastInputTokens: 0,
    totalWallMs: 0,
    shapingSavedTokens: 0,
    shapingShapeCount: 0,
    requestTurns: 0,
    requestReasoning: 0,
    requestToolCalls: 0,
    requestToolFailures: 0,
    requestWorkflowCodeBytes: 0,
    requestWallMs: 0,
    requestStartedAt: Date.now(),
    totalTurns: 0,
    totalReasoning: 0,
    totalToolCalls: 0,
    totalToolFailures: 0,
    deferredDefsTokensAccrued: 0,
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
  tokens: { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown; reasoningTokens?: unknown },
): void {
  const entry = getOrCreate(sessionId);
  const input = safeInt(tokens.inputTokens);
  const cache = safeInt(tokens.cacheReadTokens);
  const cacheWrite = safeInt(tokens.cacheWriteTokens);
  const out = safeInt(tokens.outputTokens);
  const reasoning = safeInt(tokens.reasoningTokens);
  const fresh = Math.max(0, input - cache);
  entry.requestIn += fresh;
  entry.requestCache += cache;
  entry.requestOut += out;
  entry.totalIn += fresh;
  entry.totalCache += cache;
  entry.totalOut += out;
  entry.requestCacheWrite += cacheWrite;
  entry.totalCacheWrite += cacheWrite;
  entry.lastCacheWriteTokens = cacheWrite;
  entry.lastCacheReadTokens = cache;
  // Each assistant.usage event is one model round trip on the critical path.
  entry.requestTurns += 1;
  entry.totalTurns += 1;
  entry.requestReasoning += reasoning;
  entry.totalReasoning += reasoning;
  // Workflow savings: capture the window W for the next workflow's replay estimate,
  // and compound the already-promoted avoided context — but ONLY when this turn
  // actually read cache. A cold-cache turn (cacheReadTokens === 0) re-sends the
  // prompt at the input rate, not the cache rate, so the absent context saved no
  // cache tokens on it. Promotion of the pending bucket is turn-based (the deferral
  // that avoids double-counting freshInputTokensSaved), independent of cache: a cold
  // first downstream turn still "uses up" the deferral so compounding begins on the
  // first WARM turn thereafter.
  entry.lastInputTokens = input;
  if (cache > 0) entry.workflowCacheCompoundSaved += entry.avoidedContextTokens;
  if (entry.pendingAvoidedContext > 0) {
    entry.avoidedContextTokens += entry.pendingAvoidedContext;
    entry.pendingAvoidedContext = 0;
  }
  // Accrue this turn's omitted tool-definition estimate (spec-deferred-savings S8).
  // The tool block is sent every round trip, so the omitted defs save tokens every
  // turn; sum the current-turn provider figure once per usage event. Reads the
  // post-turn live excluded set (a tool revealed mid-turn has already left it and is
  // correctly not counted this turn) — an accepted one-turn approximation.
  const deferred = deferredDefsProvider?.(sessionId);
  if (deferred) entry.deferredDefsTokensAccrued += deferred.deferredDefsTokens;
  entry.updatedAt = now();
}

/** Record one completed tool call (and whether it failed) for round-trip metrics. */
export function recordToolCall(sessionId: string, failed: boolean): void {
  const entry = getOrCreate(sessionId);
  entry.requestToolCalls += 1;
  entry.totalToolCalls += 1;
  if (failed) {
    entry.requestToolFailures += 1;
    entry.totalToolFailures += 1;
  }
  entry.updatedAt = now();
}

/** Stamp that a tool was invoked this session, keyed by its canonical ToolKey (the
 *  SAME key `excludedTools` uses). The per-session "used-here" set — the reveal
 *  C-phase reads it so a tool used here is never auto-deferred out from under the
 *  agent. Idempotent per key. */
export function recordToolUse(sessionId: string, key: ToolKey): void {
  let used = toolsUsedBySession.get(sessionId);
  if (!used) {
    used = new Set<ToolKey>();
    toolsUsedBySession.set(sessionId, used);
  }
  used.add(key);
}

/** The set of ToolKeys used this session (empty for an unknown session). */
export function getToolsUsed(sessionId: string): ReadonlySet<ToolKey> {
  return toolsUsedBySession.get(sessionId) ?? new Set<ToolKey>();
}

/** Record bytes of caco_run_workflow code submitted this request (an output-token cost). */
export function recordWorkflowCode(sessionId: string, codeBytes: number): void {
  const bytes = safeInt(codeBytes);
  if (bytes <= 0) return;
  const entry = getOrCreate(sessionId);
  entry.requestWorkflowCodeBytes += bytes;
  entry.updatedAt = now();
}

/**
 * Finalize the current request: stamp its wall-clock duration and return a
 * compact metrics row for the benchmark log. Returns null for unknown sessions.
 */
export function markRequestComplete(sessionId: string): RequestMetricsRow | null {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  entry.requestWallMs = Math.max(0, Date.now() - entry.requestStartedAt);
  entry.totalWallMs += entry.requestWallMs;
  // Time saved this request: estimate per-round-trip latency from THIS request
  // (requestWall / requestTurns) and multiply by the round trips the request's
  // workflows collapsed. Accumulated session-lifetime. Pairs each request's
  // measured RTT with its own saved trips rather than a session-wide average.
  if (entry.requestTurns > 0 && entry.requestRoundTripsSaved > 0) {
    entry.workflowTimeSavedMs += (entry.requestWallMs / entry.requestTurns) * entry.requestRoundTripsSaved;
  }
  entry.updatedAt = now();
  return {
    requestIn: entry.requestIn,
    requestCache: entry.requestCache,
    requestOut: entry.requestOut,
    requestTurns: entry.requestTurns,
    requestReasoning: entry.requestReasoning,
    requestToolCalls: entry.requestToolCalls,
    requestToolFailures: entry.requestToolFailures,
    requestWorkflowCodeBytes: entry.requestWorkflowCodeBytes,
    requestWallMs: entry.requestWallMs,
    rateLimitCount: entry.rateLimitCount,
  };
}

export function recordRateLimit(sessionId: string): void {
  const entry = getOrCreate(sessionId);
  entry.rateLimitCount += 1;
  entry.lastRateLimitAt = now();
  entry.updatedAt = now();
}

/**
 * The context-window proxy W for the next workflow's replay estimate: the prompt
 * size from the most recent round trip, or 0 before any round trip this request
 * (so a fresh send never prices replay against a stale window).
 */
export function currentWindowTokens(sessionId: string): number {
  const entry = sessions.get(sessionId);
  if (!entry || entry.requestTurns <= 0) return 0;
  return entry.lastInputTokens;
}

/**
 * Record one emitted workflow run's savings breakdown. Session-lifetime (like
 * total*), NOT cleared by resetRequest, since the saving describes work that
 * already happened. `workflowSavedTokens` keeps its prior meaning (cumulative
 * fresh-input tokens) for footer back-compat. `freshInputTokensSaved` enters a
 * PENDING bucket here and only begins compounding after the next round trip (see
 * recordUsage), so it is never billed as both fresh-input and cache on the same turn.
 */
export function recordWorkflowSavingsV2(
  sessionId: string,
  breakdown: {
    virtualToolCallsAvoided: number;
    roundTripsSaved: number;
    freshInputTokensSaved: number;
    cacheReplayTokensSaved: number;
    netOutputTokensSpent: number;
  },
): void {
  const entry = getOrCreate(sessionId);
  const fresh = safeInt(breakdown.freshInputTokensSaved);
  entry.workflowSavedTokens += fresh;
  entry.pendingAvoidedContext += fresh;
  entry.workflowVirtualCallsAvoided += safeInt(breakdown.virtualToolCallsAvoided);
  entry.workflowRoundTripsSaved += safeInt(breakdown.roundTripsSaved);
  entry.requestRoundTripsSaved += safeInt(breakdown.roundTripsSaved);
  entry.workflowCacheReplaySaved += safeInt(breakdown.cacheReplayTokensSaved);
  entry.workflowOutputDelta += Math.trunc(breakdown.netOutputTokensSpent) || 0;
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
  entry.requestCacheWrite = 0;
  entry.lastCacheWriteTokens = 0;
  entry.lastCacheReadTokens = 0;
  entry.rateLimitCount = 0;
  entry.lastRateLimitAt = undefined;
  entry.requestTurns = 0;
  entry.requestReasoning = 0;
  entry.requestToolCalls = 0;
  entry.requestToolFailures = 0;
  entry.requestWorkflowCodeBytes = 0;
  entry.requestWallMs = 0;
  entry.requestRoundTripsSaved = 0;
  entry.requestStartedAt = Date.now();
  // A fresh send must not price the next workflow's window against the prior
  // request's prompt, and any un-promoted pending context is dropped (conservative).
  entry.lastInputTokens = 0;
  entry.pendingAvoidedContext = 0;
  entry.updatedAt = now();
}

export function getThroughput(sessionId: string): SessionThroughput | undefined {
  return sessions.get(sessionId);
}

export function snapshot(sessionId: string): ThroughputSnapshot {
  const entry = sessions.get(sessionId);
  const deferred = deferredDefsProvider?.(sessionId);
  if (!entry) {
    return { ...blank(), known: false, ...deferred };
  }
  return { ...entry, known: true, ...deferred };
}

/**
 * Average tool calls per round trip over the session lifetime, ≥1. A serial model
 * (~1) gets full round-trip credit; a batching model (>1) saved fewer trips. Below
 * BATCH_WARMUP_TURNS the ratio is noisy, so return 1 (full credit). Returns 1 for
 * unknown sessions.
 */
export function currentBatchFactor(sessionId: string): number {
  const entry = sessions.get(sessionId);
  if (!entry || entry.totalTurns < BATCH_WARMUP_TURNS) return 1;
  const b = entry.totalToolCalls / entry.totalTurns;
  return b > 1 ? b : 1;
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
  toolsUsedBySession.delete(sessionId);
}
