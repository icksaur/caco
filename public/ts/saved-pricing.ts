/** Pure credit pricing for the footer savings headline. Kept dependency-free so
 *  the headline math is unit-testable without model lookup or DOM. */

export interface Rates {
  input: number;
  cache: number;
  output: number;
}

export interface SavedTokens {
  fresh: number;
  shaping: number;
  compound: number;
  replay: number;
  outputDelta: number;
}

/** Net credits saved = input class (fresh + shaping) + cache class (replay +
 *  compound) − output class (script delta), all per-MTOK. May be negative. */
export function computeNetCreditsSaved(rates: Rates, t: SavedTokens): number {
  return (
    (t.fresh + t.shaping) * rates.input +
    (t.replay + t.compound) * rates.cache -
    t.outputDelta * rates.output
  ) / 1_000_000;
}
