/** Pure credit pricing for the footer savings headline. Kept dependency-free so
 *  the headline math is unit-testable without model lookup or DOM. */

import type { ModelInfo } from './types.js';

export interface Rates {
  input: number;
  cache: number;
  output: number;
}

/** Resolve the active model's per-MTOK rates, or null when unknown (Auto / a model
 *  with no pricing). Handles context-window VARIANT ids the model list omits (e.g.
 *  `claude-opus-4.6-1m`, `claude-opus-4.7-1m-internal`) by falling back to the
 *  longest base id that is a segment-boundary prefix of the variant. Shared by the
 *  spent and saved figures so they never disagree about priced-vs-unpriced. */
export function resolveModelRates(models: readonly ModelInfo[], id: string | null): Rates | null {
  if (!id) return null;
  let model = models.find(m => m.id === id);
  if (!model) {
    // Variant id (base + "-<suffix>"): match the longest base id at a segment boundary.
    for (const m of models) {
      if (id.startsWith(m.id + '-') && (!model || m.id.length > model.id.length)) model = m;
    }
  }
  if (!model || model.inputPerMtok === undefined || model.outputPerMtok === undefined) return null;
  return { input: model.inputPerMtok, cache: model.cachePerMtok ?? 0, output: model.outputPerMtok ?? 0 };
}

export interface SavedTokens {
  fresh: number;
  shaping: number;
  compound: number;
  replay: number;
  outputDelta: number;
  /** Accrued omitted tool-definition estimate (spec-deferred-savings S9). Priced in
   *  the cache class: tool defs sit in the cacheable prefix, so deferring them saves
   *  cache-rate tokens each warm turn. An estimate, not a measured saving. */
  deferredDefs: number;
}

/** Net credits saved = input class (fresh + shaping) + cache class (replay +
 *  compound + deferred defs) − output class (script delta), all per-MTOK. May be
 *  negative. */
export function computeNetCreditsSaved(rates: Rates, t: SavedTokens): number {
  return (
    (t.fresh + t.shaping) * rates.input +
    (t.replay + t.compound + t.deferredDefs) * rates.cache -
    t.outputDelta * rates.output
  ) / 1_000_000;
}

/** Credit cost of the cache-miss input tokens (spec-footer-cache-miss): the slice of
 *  input spend billed fresh because those turns read zero cache. Returns null when
 *  rates are unknown (Auto) or there are no miss tokens, so the red footer figure
 *  hides in lockstep with the yellow spend. */
export function cacheMissCredits(rates: Rates | null, coldMissInputTokens: number): number | null {
  if (!rates || coldMissInputTokens <= 0) return null;
  return coldMissInputTokens * rates.input / 1_000_000;
}
