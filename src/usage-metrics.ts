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

/** Who initiated an LLM call. `assistant.usage` reports `initiator` only for
 *  non-user calls, so an absent/unrecognized value folds into 'root'. */
export type TurnInitiator = 'root' | 'sub-agent' | 'mcp-sampling';

/** One observed LLM call. Every `assistant.usage` carries its OWN required
 *  `model`, which is what makes Auto and mid-request switches priceable — the
 *  model captured at dispatch start prices the whole request under one model
 *  and reads 'auto' (unpriced) for an Auto selection.
 *
 *  The fresh/cached split is taken at CAPTURE time (`max(0, inputTokens −
 *  cacheReadTokens)`, mirroring session-throughput.recordUsage) so the two
 *  accumulators cannot disagree about what "input" means. */
export interface TurnUsage {
  model: string;
  freshInputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  initiator: TurnInitiator;
  /** CAPI's per-call billing figure, when the SDK reports it. NOT credits. */
  nanoAiu?: number;
}

/** Credits + tokens attributed to one model or one initiator. `credits` is null
 *  when nothing in the group resolved to rates (never 0 — that would read as
 *  "ran for free"). */
export interface UsageGroup {
  credits: number | null;
  turns: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/** One durable per-request usage record. Costs are null when the model is
 *  unpriced (Auto / missing input or output rate); token counts always persist.
 *
 *  Every field below `turns` is OPTIONAL and produced only by the per-turn path,
 *  so records written before the amendment still parse and readers must treat
 *  absence as "not measured" rather than zero. */
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
  /** Per distinct model observed across the request's turns. */
  perModelBreakdown?: Record<string, UsageGroup>;
  /** Turns whose model resolved to no rates. */
  unpricedTurns?: number;
  /** True iff every turn priced. Absent on the fallback path, which makes no
   *  completeness claim. */
  creditsComplete?: boolean;
  /** Σ per-call nano-AIU. Absent when no turn reported it. */
  sdkNanoAiu?: number;
  /** Display-only: the model Auto settled on for the session's first prompt. */
  autoResolvedTo?: string;
  /** Display-only: a root model change observed during this request. Pricing is
   *  already correct via per-turn attribution. */
  switchedDuringRequest?: { fromModel: string; toModel: string; cause?: string };
  /** Root vs sub-agent vs MCP-sampling split. Sub-agent spend is INCLUDED in
   *  requestCredits; this only surfaces the division. */
  initiatorBreakdown?: {
    root: UsageGroup;
    subAgent?: UsageGroup;
    mcpSampling?: UsageGroup;
  };
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

/** Accumulate one turn's tokens into a group, and its credits when priced. */
function addToGroup(group: UsageGroup, turn: TurnUsage, credits: number | null): void {
  group.turns += 1;
  group.inputTokens += turn.freshInputTokens;
  group.cachedTokens += turn.cachedTokens;
  group.outputTokens += turn.outputTokens;
  if (credits !== null) group.credits = (group.credits ?? 0) + credits;
}

function emptyGroup(): UsageGroup {
  return { credits: null, turns: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
}

/**
 * Build one UsageRecord.
 *
 * With `perTurn` non-empty, EVERY quantity on the record — token columns, the
 * three cost columns, and `turns` — derives from `perTurn`, priced turn by turn
 * against `models`. That single source is what keeps the two accumulators from
 * disagreeing, and it is what makes Auto and mid-request model switches priceable
 * at all: the captured `rates` price one model for the whole request.
 *
 * With `perTurn` absent or empty (pre-send abort, or a watchdog that fired before
 * the first turn), it falls back to the captured-rates path: tokens × the rates
 * captured at dispatch start, with every amendment field left absent.
 *
 * Cost per class = tokens × per-MTOK / 1e6 (the footer estimateCost formula).
 * No I/O.
 */
export function buildUsageRecord(args: {
  sessionId: string;
  model: string | null;
  tokens: UsageTokens;
  rates: UsageRates | null;
  contextWindow: number | null;
  ts?: string;
  /** Observed LLM calls, in arrival order. */
  perTurn?: readonly TurnUsage[];
  /** Rate table for resolving each turn's model. Required to price `perTurn`. */
  models?: readonly PricedModel[];
  autoResolvedTo?: string;
  switchedDuringRequest?: { fromModel: string; toModel: string; cause?: string };
}): UsageRecord {
  const { sessionId, model, tokens, rates, contextWindow, perTurn, models } = args;
  const ts = args.ts ?? new Date().toISOString();
  const price = (count: number, rate: number): number => (count * rate) / 1_000_000;

  if (perTurn && perTurn.length > 0) {
    return buildPerTurnRecord({
      sessionId, model, contextWindow, ts,
      perTurn,
      models: models ?? [],
      autoResolvedTo: args.autoResolvedTo,
      switchedDuringRequest: args.switchedDuringRequest,
    });
  }

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

/** The per-turn path. Split out so the fallback above stays readable; every
 *  derived field here is a pure function of `perTurn`, never independent state. */
function buildPerTurnRecord(args: {
  sessionId: string;
  model: string | null;
  contextWindow: number | null;
  ts: string;
  perTurn: readonly TurnUsage[];
  models: readonly PricedModel[];
  autoResolvedTo?: string;
  switchedDuringRequest?: { fromModel: string; toModel: string; cause?: string };
}): UsageRecord {
  const { sessionId, model, contextWindow, ts, perTurn, models } = args;

  let inputTokens = 0, cachedTokens = 0, outputTokens = 0;
  let inputCost = 0, cachedCost = 0, outputCost = 0;
  let pricedTurns = 0, unpricedTurns = 0;
  let nanoAiu: number | undefined;

  const perModelBreakdown: Record<string, UsageGroup> = {};
  const byInitiator: Record<TurnInitiator, UsageGroup> = {
    'root': emptyGroup(),
    'sub-agent': emptyGroup(),
    'mcp-sampling': emptyGroup(),
  };

  for (const turn of perTurn) {
    inputTokens += turn.freshInputTokens;
    cachedTokens += turn.cachedTokens;
    outputTokens += turn.outputTokens;
    if (turn.nanoAiu !== undefined) nanoAiu = (nanoAiu ?? 0) + turn.nanoAiu;

    const { rates } = resolveUsageRates(models, turn.model);
    let credits: number | null = null;
    if (rates) {
      const i = (turn.freshInputTokens * rates.input) / 1_000_000;
      const c = (turn.cachedTokens * rates.cache) / 1_000_000;
      const o = (turn.outputTokens * rates.output) / 1_000_000;
      inputCost += i; cachedCost += c; outputCost += o;
      credits = i + c + o;
      pricedTurns += 1;
    } else {
      unpricedTurns += 1;
    }

    (perModelBreakdown[turn.model] ??= emptyGroup());
    addToGroup(perModelBreakdown[turn.model], turn, credits);
    addToGroup(byInitiator[turn.initiator], turn, credits);
  }

  // No turn priced ⇒ all four cost fields null, matching the fallback path's
  // convention. Zero would claim the request ran for free.
  const anyPriced = pricedTurns > 0;
  const record: UsageRecord = {
    ts,
    sessionId,
    model,
    contextWindow,
    inputTokens,
    cachedTokens,
    outputTokens,
    inputTokenCost: anyPriced ? inputCost : null,
    cachedTokenCost: anyPriced ? cachedCost : null,
    outputTokenCost: anyPriced ? outputCost : null,
    requestCredits: anyPriced ? inputCost + cachedCost + outputCost : null,
    turns: perTurn.length,
    perModelBreakdown,
    unpricedTurns,
    creditsComplete: unpricedTurns === 0,
    initiatorBreakdown: {
      root: byInitiator.root,
      ...(byInitiator['sub-agent'].turns > 0 && { subAgent: byInitiator['sub-agent'] }),
      ...(byInitiator['mcp-sampling'].turns > 0 && { mcpSampling: byInitiator['mcp-sampling'] }),
    },
    ...(nanoAiu !== undefined && { sdkNanoAiu: nanoAiu }),
    ...(args.autoResolvedTo !== undefined && { autoResolvedTo: args.autoResolvedTo }),
    ...(args.switchedDuringRequest !== undefined && { switchedDuringRequest: args.switchedDuringRequest }),
  };
  return record;
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
