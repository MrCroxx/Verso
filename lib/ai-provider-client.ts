import type { AiProviderSettings } from "./ai-provider-settings";

export function providerEndpoint(config: AiProviderSettings) {
  const raw = config.endpoint.trim().replace(/\/$/, "");
  if (config.provider === "openai") return raw || "https://api.openai.com/v1/responses";
  if (/\/(chat\/completions|responses)$/.test(raw)) return raw;
  return `${raw}/chat/completions`;
}

export function isResponsesEndpoint(config: AiProviderSettings, endpoint = providerEndpoint(config)) {
  return config.provider === "openai" || endpoint.endsWith("/responses");
}

export function providerOutputText(result: Record<string, unknown>, responsesApi: boolean) {
  if (responsesApi) {
    const direct = result.output_text as string | undefined;
    if (direct) return direct;
    if (Array.isArray(result.output)) {
      const output = result.output as Array<{ content?: Array<{ text?: string }> }>;
      return output.flatMap((item) => item.content || []).find((item) => item.text)?.text;
    }
    return undefined;
  }
  const choices = result.choices as Array<{ message?: { content?: string } }> | undefined;
  return choices?.[0]?.message?.content;
}

export function providerErrorMessage(result: Record<string, unknown>, status: number) {
  return (result.error as { message?: string } | undefined)?.message || `Provider returned ${status}.`;
}
