import { calculateTranslationCost, isPricingCurrency, type TranslationCost, type TranslationPricing } from "./translation-pricing.ts";

export type TranslationUsage = {
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  outputSeconds?: number;
  cost?: TranslationCost;
};

export function translationUsageCost(usage: TranslationUsage, pricing?: TranslationPricing, cachedAt?: number): TranslationCost | undefined {
  // Preserve recorded charges; estimate unpriced history at its original time.
  return usage.cost ?? calculateTranslationCost(usage, pricing, cachedAt ?? Number.NaN);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function normalizeTranslationUsage(value: unknown): TranslationUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const totalTokens = tokenCount(usage.totalTokens)
    ?? (inputTokens !== undefined && outputTokens !== undefined ? tokenCount(inputTokens + outputTokens) : undefined);
  if (totalTokens === undefined) return undefined;
  const cached = tokenCount(usage.cachedInputTokens);
  const cachedInputTokens = cached !== undefined && inputTokens !== undefined && cached <= inputTokens ? cached : undefined;
  const outputSeconds = typeof usage.outputSeconds === "number" && Number.isFinite(usage.outputSeconds) && usage.outputSeconds > 0
    ? usage.outputSeconds : undefined;
  const cost = usage.cost as Partial<TranslationCost> | null | undefined;
  const validCost = cost && isPricingCurrency(cost.currency)
    && typeof cost.amount === "number" && Number.isFinite(cost.amount) && cost.amount >= 0;
  return { totalTokens, inputTokens, outputTokens,
    ...(cachedInputTokens !== undefined && { cachedInputTokens }),
    ...(outputSeconds !== undefined && { outputSeconds }),
    ...(validCost && { cost: { amount: cost.amount!, currency: cost.currency!,
      ...((cost.period === "peak" || cost.period === "offPeak" || cost.period === "mixed") && { period: cost.period }) } }),
  };
}

export function providerTranslationUsage(value: unknown): TranslationUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const details = (usage.input_tokens_details ?? usage.prompt_tokens_details) as Record<string, unknown> | undefined;
  // Reasoning and cached tokens are already included in the provider's counts.
  return normalizeTranslationUsage({
    inputTokens: usage.input_tokens ?? usage.prompt_tokens,
    outputTokens: usage.output_tokens ?? usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cachedInputTokens: details?.cached_tokens ?? usage.prompt_cache_hit_tokens,
  });
}

export function addTranslationUsage(first?: TranslationUsage, second?: TranslationUsage): TranslationUsage | undefined {
  // An unreported attempt must not turn a partial count into an apparent total.
  if (!first || !second) return undefined;
  return normalizeTranslationUsage({
    totalTokens: first.totalTokens + second.totalTokens,
    inputTokens: first.inputTokens !== undefined && second.inputTokens !== undefined ? first.inputTokens + second.inputTokens : undefined,
    outputTokens: first.outputTokens !== undefined && second.outputTokens !== undefined ? first.outputTokens + second.outputTokens : undefined,
    cachedInputTokens: first.cachedInputTokens !== undefined && second.cachedInputTokens !== undefined ? first.cachedInputTokens + second.cachedInputTokens : undefined,
    outputSeconds: first.outputSeconds !== undefined && second.outputSeconds !== undefined ? first.outputSeconds + second.outputSeconds : undefined,
    cost: first.cost && second.cost && first.cost.currency === second.cost.currency
      ? { amount: first.cost.amount + second.cost.amount, currency: first.cost.currency,
          ...((first.cost.period || second.cost.period) && { period: first.cost.period === second.cost.period ? first.cost.period : "mixed" }) } : undefined,
  });
}

export function translationTokensPerSecond(usage: TranslationUsage): number | undefined {
  if (usage.outputTokens === undefined || !usage.outputSeconds) return undefined;
  const rate = usage.outputTokens / usage.outputSeconds;
  return Number.isFinite(rate) ? rate : undefined;
}

export function translationCacheHitRate(usage: TranslationUsage): number | undefined {
  if (usage.inputTokens === undefined || usage.cachedInputTokens === undefined) return undefined;
  return usage.inputTokens === 0 ? 0 : usage.cachedInputTokens / usage.inputTokens;
}
