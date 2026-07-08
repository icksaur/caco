/**
 * Usage metrics core: the pure record builder + rate resolver + a best-effort
 * sink registry. One `UsageRecord` is built per completed request (in
 * completeDispatch) and fanned out to durable consumers via emitUsageRecord.
 *
 * Pure by design (no I/O, no session/model lookup) so pricing is ref-impl
 * testable and mirrors the footer's per-class arithmetic
 * (public/ts/context-footer.ts estimateCost + public/ts/saved-pricing.ts
 * resolveModelRates). The two runtimes are separate builds, so this is a
 * deliberate server-side twin of that math, pinned by usage-metrics.test.ts.
 */

/** Per-MTOK credit rates for the three billing classes. */
export interface UsageRates {
  input: number;
  cache: number;
  output: number;
}

/** A model with its resolved per-MTOK rates (the shape of modelCostSummary + id). */
export interface PricedModel {
  id: string;
  inputPerMtok?: number;
  outputPerMtok?: number;
  cachePerMtok?: number;
  contextWindow?: number;
}

/** Request-scoped token counts sourced from the throughput snapshot. */
export interface UsageTokens {
  /** Fresh (non-cached) input = requestIn. */
  inputTokens: number;
  /** Cached input read = requestCache. */
  cachedTokens: number;
  /** Output = requestOut. */
  outputTokens: number;
  /** Model round trips = requestTurns. */
  turns: number;
}

/** One durable per-request usage record. Costs are null when the model is
 *  unpriced (Auto / missing input or output rate); token counts always persist. */
export interface UsageRecord {
  ts: string;
  sessionId: string;
  model: string | null;
  contextWindow: number | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  inputTokenCost: number | null;
  cachedTokenCost: number | null;
  outputTokenCost: number | null;
  requestCredits: number | null;
  turns: number;
}

/**
 * Resolve a model id to its per-MTOK rates + context window, mirroring the
 * footer's resolveModelRates: exact id first, then the longest base id that is a
 * segment-boundary prefix of a variant id (e.g. `claude-opus-4.6-1m` →
 * `claude-opus-4.6`). Rates are null when the model is unknown or omits the
 * input/output rate; the cache rate defaults to 0 (a model may not price cache).
 */
export function resolveUsageRates(
  models: readonly PricedModel[],
  id: string | null,
): { rates: UsageRates | null; contextWindow: number | null; model: string | null } {
  if (!id) return { rates: null, contextWindow: null, model: null };
  let model = models.find(m => m.id === id);
  if (!model) {
    for (const m of models) {
      if (id.startsWith(m.id + '-') && (!model || m.id.length > model.id.length)) model = m;
    }
  }
  if (!model) return { rates: null, contextWindow: null, model: id };
  const contextWindow = model.contextWindow ?? null;
  if (model.inputPerMtok === undefined || model.outputPerMtok === undefined) {
    return { rates: null, contextWindow, model: model.id };
  }
  return {
    rates: { input: model.inputPerMtok, cache: model.cachePerMtok ?? 0, output: model.outputPerMtok },
    contextWindow,
    model: model.id,
  };
}

/**
 * Build one UsageRecord from request-scoped tokens + the (captured) rates. Cost
 * per class = tokens × per-MTOK / 1e6 (the footer estimateCost formula); rates
 * null → all cost fields null. No I/O.
 */
export function buildUsageRecord(args: {
  sessionId: string;
  model: string | null;
  tokens: UsageTokens;
  rates: UsageRates | null;
  contextWindow: number | null;
  ts?: string;
}): UsageRecord {
  const { sessionId, model, tokens, rates, contextWindow } = args;
  const ts = args.ts ?? new Date().toISOString();
  const price = (count: number, rate: number): number => (count * rate) / 1_000_000;
  const inputTokenCost = rates ? price(tokens.inputTokens, rates.input) : null;
  const cachedTokenCost = rates ? price(tokens.cachedTokens, rates.cache) : null;
  const outputTokenCost = rates ? price(tokens.outputTokens, rates.output) : null;
  const requestCredits =
    inputTokenCost === null || cachedTokenCost === null || outputTokenCost === null
      ? null
      : inputTokenCost + cachedTokenCost + outputTokenCost;
  return {
    ts,
    sessionId,
    model,
    contextWindow,
    inputTokens: tokens.inputTokens,
    cachedTokens: tokens.cachedTokens,
    outputTokens: tokens.outputTokens,
    inputTokenCost,
    cachedTokenCost,
    outputTokenCost,
    requestCredits,
    turns: tokens.turns,
  };
}

/** A durable/side-effecting consumer of usage records. */
export interface UsageSink {
  emit(record: UsageRecord): void;
}

const sinks: UsageSink[] = [];

/** Register a sink to receive every emitted record (called once at boot). */
export function registerUsageSink(sink: UsageSink): void {
  sinks.push(sink);
}

/** Drop all sinks (test isolation). */
export function clearUsageSinks(): void {
  sinks.length = 0;
}

/** Fan a record to every sink, best-effort — a throwing sink never disturbs
 *  the caller (the dispatch path) or the other sinks. */
export function emitUsageRecord(record: UsageRecord): void {
  for (const sink of sinks) {
    try {
      sink.emit(record);
    } catch {
      /* best-effort telemetry; never disturb dispatch */
    }
  }
}
