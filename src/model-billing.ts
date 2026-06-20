import { SDKModelInfo } from './session-manager.js';
import type { ModelTokenLimits } from './context-budget.js';

export interface ModelCostSummary {
  priceCategory?: 'low' | 'medium' | 'high' | 'very_high';
  category?: 'lightweight' | 'versatile' | 'powerful';
  inputPerMtok?: number;
  outputPerMtok?: number;
  cachePerMtok?: number;
  contextWindow?: number;
  multiplier: number;
}

function toPerMtok(price: number | undefined, batchSize: number | undefined): number | undefined {
  if (typeof price !== 'number' || typeof batchSize !== 'number' || batchSize === 0) return undefined;
  return price / batchSize * 1_000_000;
}

interface TierPrices {
  inputPrice?: number;
  outputPrice?: number;
  cachePrice?: number;
  contextMax?: number;
}

function pricesEqual(a: TierPrices, b: TierPrices): boolean {
  return a.inputPrice === b.inputPrice && a.outputPrice === b.outputPrice && a.cachePrice === b.cachePrice;
}

/**
 * The context tier Caco pins for a model. `long_context` ONLY when the model
 * offers it at a price equal to the default tier (a free window upgrade);
 * otherwise `default`, so we never silently multiply token cost on models whose
 * long-context tier is pricier (e.g. gpt-5.x, gemini-pro).
 *
 * Single source of truth: billing display (modelCostSummary), the
 * /session-context-window denominator (modelTokenLimits), and session
 * create/resume/model-switch pinning all derive the tier from here.
 */
export function effectiveContextTier(m: SDKModelInfo): 'default' | 'long_context' {
  const tp = m.billing?.tokenPrices;
  const lc = tp?.longContext;
  if (!tp || !lc) return 'default';
  return pricesEqual(lc, tp) ? 'long_context' : 'default';
}

/** Prices + window of the tier Caco actually pins (see effectiveContextTier). */
function effectiveTierPrices(m: SDKModelInfo): TierPrices {
  const tp = m.billing?.tokenPrices;
  if (!tp) return {};
  if (effectiveContextTier(m) === 'long_context' && tp.longContext) {
    const lc = tp.longContext;
    return {
      inputPrice: lc.inputPrice ?? tp.inputPrice,
      outputPrice: lc.outputPrice ?? tp.outputPrice,
      cachePrice: lc.cachePrice ?? tp.cachePrice,
      contextMax: lc.contextMax ?? tp.contextMax,
    };
  }
  return { inputPrice: tp.inputPrice, outputPrice: tp.outputPrice, cachePrice: tp.cachePrice, contextMax: tp.contextMax };
}

/**
 * The effective prompt-token window for the pinned tier, or undefined when the
 * model carries no tier/billing context_max (caller falls back to flat
 * capabilities). Used by the /session-context-window budget denominator so it
 * matches what the SDK enforces.
 */
export function effectiveContextMax(m: SDKModelInfo): number | undefined {
  return effectiveTierPrices(m).contextMax;
}

/**
 * Prompt-token limits for the /session-context-window budget math. Prefers the
 * pinned tier's context_max (so the denominator matches what the SDK enforces),
 * falling back to flat capability limits when the model has no tier/billing
 * context_max. Tiering is NOT a capability concept, so correctness must not
 * depend on the flat ceiling happening to equal a tier's context_max.
 */
export function tokenLimitsForModel(m: SDKModelInfo): ModelTokenLimits {
  const tierMax = effectiveContextMax(m);
  return {
    maxPromptTokens: tierMax ?? m.capabilities?.limits?.max_prompt_tokens,
    maxContextWindowTokens: m.capabilities?.limits?.max_context_window_tokens,
  };
}

export function modelCostSummary(m: SDKModelInfo): ModelCostSummary {
  const batchSize = m.billing?.tokenPrices?.batchSize;
  const tier = effectiveTierPrices(m);
  const contextWindow = tier.contextMax ?? m.capabilities?.limits?.max_context_window_tokens;
  return {
    multiplier: m.billing?.multiplier ?? 1,
    priceCategory: m.modelPickerPriceCategory,
    category: m.modelPickerCategory,
    inputPerMtok: toPerMtok(tier.inputPrice, batchSize),
    outputPerMtok: toPerMtok(tier.outputPrice, batchSize),
    cachePerMtok: toPerMtok(tier.cachePrice, batchSize),
    contextWindow,
  };
}
