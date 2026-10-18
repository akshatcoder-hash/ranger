/**
 * Documented xAI price rates for budget accounting.
 *
 * Rates are the published estimates recorded in the mission xAI findings;
 * provider usage is reconciled against them. An unknown model has NO rate:
 * cost accounting returns null and the caller must stop paid operations
 * rather than guess (fail closed on uncertain accounting).
 */

export interface ModelRates {
  inputUsdPerM: number;
  cachedInputUsdPerM: number;
  outputUsdPerM: number;
}

export const DOCUMENTED_MODEL_RATES: Record<string, ModelRates> = {
  'grok-4.3': { inputUsdPerM: 1.25, cachedInputUsdPerM: 0.2, outputUsdPerM: 2.5 },
  'grok-4.7': { inputUsdPerM: 2.0, cachedInputUsdPerM: 0.5, outputUsdPerM: 6.0 },
};

export function documentedRate(model: string): ModelRates | null {
  return DOCUMENTED_MODEL_RATES[model] ?? null;
}

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

/** Cost from observed tokens, or null when the model has no documented rate. */
export function costFromUsage(model: string, usage: UsageTokens): number | null {
  const rates = documentedRate(model);
  if (rates === null) return null;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const freshInput = usage.inputTokens - cached;
  const cost =
    (freshInput * rates.inputUsdPerM + cached * rates.cachedInputUsdPerM + usage.outputTokens * rates.outputUsdPerM) / 1_000_000;
  return round6(cost);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
