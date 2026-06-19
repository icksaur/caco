import type { Shaper, ShaperContext } from './types.js';
import { genericShaper } from './shapers/generic.js';
import { tsTestBuildShaper } from './shapers/ts-test-build.js';

/**
 * Format shapers, in no particular order — selection is by `detect` score.
 * `generic` is the implicit fallback and is not listed here. Adding a shaper =
 * append one module here + a golden fixture; no other change.
 */
const FORMAT_SHAPERS: Shaper[] = [tsTestBuildShaper];

/** Highest-scoring format shaper, or `generic` when none match. */
export function selectShaper(raw: string, ctx: ShaperContext): Shaper {
  let best = genericShaper;
  let bestScore = 0;
  for (const shaper of FORMAT_SHAPERS) {
    const score = shaper.detect(raw, ctx);
    if (score > bestScore) {
      best = shaper;
      bestScore = score;
    }
  }
  return best;
}

export { genericShaper };
