import { NextResponse } from "next/server";
import { getAiProviderSettings } from "../../../../../db/ai-provider-settings";
import { aiProviderEndpoint } from "../../../../../lib/ai-provider-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, private" };

export async function POST() {
  try {
    const settings = await getAiProviderSettings();
    if (!settings?.apiKey || !settings.endpoint || !settings.model) {
      return NextResponse.json({ error: "not_configured" }, { status: 400, headers });
    }
    const endpoint = aiProviderEndpoint(settings);
    const responses = settings.provider === "openai" || endpoint.endsWith("/responses");
    const instruction = "Reply with exactly OK.";
    const body = responses
      ? { model: settings.model, input: [{ role: "user", content: [{ type: "input_text", text: instruction }] }],
          ...(settings.reasoningEffort !== "none" && { reasoning: { effort: settings.reasoningEffort } }) }
      : { model: settings.model, messages: [{ role: "user", content: instruction }],
          ...(settings.reasoningEffort !== "none" && { reasoning_effort: settings.reasoningEffort }) };
    const started = Date.now();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return NextResponse.json({ error: "provider_error", status: response.status }, { status: 502, headers });
    }
    const result = await response.json();
    const text = responses
      ? result.output_text || result.output?.flatMap((item: { content?: Array<{ text?: string }> }) => item.content || []).find((item: { text?: string }) => item.text)?.text
      : result.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim() || result.error) {
      return NextResponse.json({ error: "invalid_response" }, { status: 502, headers });
    }
    return NextResponse.json({ ok: true, latencyMs: Date.now() - started }, { headers });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return NextResponse.json({ error: timeout ? "timeout" : "connection_failed" }, { status: timeout ? 504 : 502, headers });
  }
}
