/**
 * Context-budget math for the /session-context-window feature.
 *
 * A per-session budget is stored as an ABSOLUTE token count. The SDK's
 * infiniteSessions.backgroundCompactionThreshold is a FRACTION (0-1) of the
 * model's prompt-token limit. This module converts between them, matching the
 * runtime's denominator choice (max_prompt_tokens ?? max_context_window_tokens
 * ?? 128_000, per @github/copilot/app.js).
 */

export const DEFAULT_PROMPT_TOKEN_LIMIT = 128_000;

/** SDK default background-compaction threshold; clearing the override = this. */
export const SDK_DEFAULT_BACKGROUND_THRESHOLD = 0.80;

/** Strictly below the SDK's default bufferExhaustionThreshold (0.95) so the two
 *  never invert (which would disable background compaction). */
const MAX_BACKGROUND_THRESHOLD = 0.94;
const MIN_BACKGROUND_THRESHOLD = 0.05;

/** At or above this T/W ratio there is no meaningful cap → clear the override. */
const CLEAR_AT_RATIO = 0.95;

export interface ModelTokenLimits {
  maxPromptTokens?: number;
  maxContextWindowTokens?: number;
}

/**
 * The denominator the runtime uses for utilization. Returns 0 when unknown
 * (caller must reject — the fraction is undefined).
 */
export function promptTokenDenominator(limits: ModelTokenLimits | undefined): number {
  if (!limits) return 0;
  const w = limits.maxPromptTokens ?? limits.maxContextWindowTokens ?? 0;
  return w > 0 ? w : 0;
}

/**
 * Convert an absolute token budget to a backgroundCompactionThreshold fraction.
 *
 * Returns null when the budget should NOT be applied:
 *  - no budget (undefined/<=0),
 *  - W unknown (0),
 *  - T/W >= 0.95 (no meaningful cap — let the SDK default stand).
 *
 * Otherwise returns the fraction clamped to [0.05, 0.94].
 */
export function thresholdForBudget(
  budgetTokens: number | undefined,
  limits: ModelTokenLimits | undefined,
): number | null {
  if (!budgetTokens || !Number.isFinite(budgetTokens) || budgetTokens <= 0) return null;
  const w = promptTokenDenominator(limits);
  if (w === 0) return null;
  const ratio = budgetTokens / w;
  if (ratio >= CLEAR_AT_RATIO) return null;
  return Math.min(MAX_BACKGROUND_THRESHOLD, Math.max(MIN_BACKGROUND_THRESHOLD, ratio));
}
