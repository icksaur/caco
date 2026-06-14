import { SDKModelInfo } from './session-manager.js';

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

export function modelCostSummary(m: SDKModelInfo): ModelCostSummary {
  const tp = m.billing?.tokenPrices;
  const batchSize = tp?.batchSize;
  const contextWindow = m.capabilities?.limits?.max_context_window_tokens ?? tp?.contextMax;
  return {
    multiplier: m.billing?.multiplier ?? 1,
    priceCategory: m.modelPickerPriceCategory,
    category: m.modelPickerCategory,
    inputPerMtok: toPerMtok(tp?.inputPrice, batchSize),
    outputPerMtok: toPerMtok(tp?.outputPrice, batchSize),
    cachePerMtok: toPerMtok(tp?.cachePrice, batchSize),
    contextWindow,
  };
}
