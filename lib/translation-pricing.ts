export const PRICING_CURRENCIES = Intl.supportedValuesOf("currency");

export function isPricingCurrency(value: unknown): value is string {
  return typeof value === "string" && PRICING_CURRENCIES.includes(value);
}

export type TranslationPricing = {
  currency: string;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedInputPerMillion?: number;
  schedule?: "deepseek-peak";
};

export type TranslationCost = { amount: number; currency: TranslationPricing["currency"]; period?: "peak" | "offPeak" | "mixed" };

export function deepseekPricingPeriod(requestedAt: number): "peak" | "offPeak" {
  // DeepSeek's published weekday windows: 09:00–12:00 and 14:00–18:00 UTC+8.
  // https://api-docs.deepseek.com/quick_start/pricing/ (verified 2026-09-12).
  const date = new Date(requestedAt);
  const weekday = date.getUTCDay();
  const hour = date.getUTCHours();
  return weekday >= 1 && weekday <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)) ? "peak" : "offPeak";
}

export function normalizeTranslationPricing(value: unknown): TranslationPricing | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (!isPricingCurrency(input.currency)) return undefined;
  const pricing: TranslationPricing = { currency: input.currency };
  if (input.schedule !== undefined) {
    if (input.schedule !== "deepseek-peak") return undefined;
    pricing.schedule = input.schedule;
  }
  for (const key of ["inputPerMillion", "outputPerMillion", "cachedInputPerMillion"] as const) {
    const rate = input[key];
    if (rate === undefined) continue;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1e9) return undefined;
    pricing[key] = rate;
  }
  return pricing;
}

export function formatTranslationCost(cost: TranslationCost, locale: string): string {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency: cost.currency, currencyDisplay: "code", maximumFractionDigits: 6 });
  return cost.amount > 0 && cost.amount < 0.000001 ? `<${format.format(0.000001)}` : format.format(cost.amount);
}

export function calculateTranslationCost(usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }, pricing?: TranslationPricing, requestedAt = Date.now()): TranslationCost | undefined {
  if (!pricing || pricing.inputPerMillion === undefined || pricing.outputPerMillion === undefined
    || usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  // A distinct cache rate needs an actual cache count, not an assumed zero.
  if (usage.inputTokens > 0 && cachedRate !== pricing.inputPerMillion && usage.cachedInputTokens === undefined) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  if (pricing.schedule && !Number.isFinite(requestedAt)) return undefined;
  const period = pricing.schedule === "deepseek-peak" ? deepseekPricingPeriod(requestedAt) : undefined;
  const multiplier = period === "peak" ? 2 : 1;
  const amount = ((usage.inputTokens - cached) * pricing.inputPerMillion
    + cached * cachedRate + usage.outputTokens * pricing.outputPerMillion) * multiplier / 1_000_000;
  return Number.isFinite(amount) && amount >= 0 ? { amount, currency: pricing.currency, ...(period && { period }) } : undefined;
}
