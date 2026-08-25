export type AiProvider = "openai" | "compatible";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type AiProviderSettings = {
  provider: AiProvider;
  endpoint: string;
  apiKey: string;
  recognitionModel: string;
  translationModel: string;
  reasoningEffort: ReasoningEffort;
  updatedAt: number;
};

export type PublicAiProviderSettings = Omit<AiProviderSettings, "apiKey"> & {
  configured: boolean;
  apiKeyConfigured: boolean;
  apiKeyHint: string;
};

export type AiProviderSettingsUpdate = {
  provider: AiProvider;
  endpoint: string;
  apiKey?: string;
  clearApiKey?: boolean;
  recognitionModel: string;
  translationModel: string;
  reasoningEffort: ReasoningEffort;
};

export const DEFAULT_AI_PROVIDER_SETTINGS = {
  provider: "openai",
  endpoint: "https://api.openai.com/v1/responses",
  recognitionModel: "gpt-5.6-luna",
  translationModel: "gpt-5.6-luna",
  reasoningEffort: "medium",
} satisfies Omit<AiProviderSettings, "apiKey" | "updatedAt">;

export const REASONING_EFFORTS = new Set<ReasoningEffort>(["none", "low", "medium", "high", "xhigh", "max"]);

export function publicAiProviderSettings(settings: AiProviderSettings | null): PublicAiProviderSettings {
  const apiKey = settings?.apiKey || "";
  return {
    provider: settings?.provider || DEFAULT_AI_PROVIDER_SETTINGS.provider,
    endpoint: settings?.endpoint || DEFAULT_AI_PROVIDER_SETTINGS.endpoint,
    recognitionModel: settings?.recognitionModel || DEFAULT_AI_PROVIDER_SETTINGS.recognitionModel,
    translationModel: settings?.translationModel || DEFAULT_AI_PROVIDER_SETTINGS.translationModel,
    reasoningEffort: settings?.reasoningEffort || DEFAULT_AI_PROVIDER_SETTINGS.reasoningEffort,
    updatedAt: settings?.updatedAt || 0,
    configured: Boolean(
      settings?.endpoint
      && settings.recognitionModel
      && settings.translationModel
      && apiKey
    ),
    apiKeyConfigured: Boolean(apiKey),
    apiKeyHint: apiKey ? `••••${apiKey.slice(-4)}` : "",
  };
}

export function normalizeAiProviderSettingsUpdate(
  value: unknown,
  existing: AiProviderSettings | null,
): AiProviderSettings | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<AiProviderSettingsUpdate>;
  const provider = input.provider;
  const legacyModel = typeof (input as { model?: unknown }).model === "string"
    ? (input as { model: string }).model.trim()
    : "";
  const recognitionModel = typeof input.recognitionModel === "string"
    ? input.recognitionModel.trim()
    : legacyModel;
  const translationModel = typeof input.translationModel === "string"
    ? input.translationModel.trim()
    : legacyModel;
  const reasoningEffort = input.reasoningEffort;
  const suppliedApiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const apiKey = input.clearApiKey ? "" : suppliedApiKey || existing?.apiKey || "";
  let endpoint = typeof input.endpoint === "string" ? input.endpoint.trim().replace(/\/$/, "") : "";

  if (provider !== "openai" && provider !== "compatible") return null;
  if (!REASONING_EFFORTS.has(reasoningEffort as ReasoningEffort)) return null;
  if (
    !recognitionModel
    || recognitionModel.length > 200
    || !translationModel
    || translationModel.length > 200
    || apiKey.length > 8192
  ) return null;
  if (provider === "openai" && !endpoint) endpoint = DEFAULT_AI_PROVIDER_SETTINGS.endpoint;
  if (!endpoint || endpoint.length > 2048) return null;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }

  return {
    provider,
    endpoint,
    apiKey,
    recognitionModel,
    translationModel,
    reasoningEffort: reasoningEffort as ReasoningEffort,
    updatedAt: Date.now(),
  };
}
