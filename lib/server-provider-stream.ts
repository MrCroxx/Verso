import { readEventStream } from "./event-stream.ts";

export async function readProviderStream(response: Response, isResponses: boolean, handlers: {
  event: () => void; text: (delta: string) => void; reasoning: (delta: string) => void; usage?: (usage: unknown) => void;
}): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("Provider stream is unavailable.");
  let text = "";
  let usage: unknown;
  let completed = false;
  const append = (delta: unknown) => {
    if (typeof delta !== "string" || !delta) return;
    text += delta;
    if (text.length > 16 * 1024 * 1024) throw new Error("Provider translation exceeds the size limit.");
    handlers.text(delta);
  };
  for await (const event of readEventStream(response.body)) {
    if (event.data === "[DONE]") { if (!isResponses) completed = true; break; }
    const data = JSON.parse(event.data);
    handlers.event();
    if (data.error || data.type === "error" || data.type === "response.failed" || data.type === "response.incomplete") {
      throw new Error("The provider could not complete the translation stream.");
    }
    if (isResponses) {
      if (data.type === "response.output_text.delta") append(data.delta);
      if (data.type === "response.refusal.delta") throw new Error("The provider declined to translate this page.");
      if (data.type === "response.reasoning_text.delta" || data.type === "response.reasoning_summary_text.delta") {
        if (typeof data.delta === "string" && data.delta) handlers.reasoning(data.delta);
      }
      if (data.type === "response.completed") {
        if (data.response?.status && data.response.status !== "completed") throw new Error("The provider returned an incomplete translation.");
        usage = data.response?.usage;
        if (!text) {
          const output = data.response?.output;
          const finalText = data.response?.output_text ?? (Array.isArray(output)
            ? output.flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content ?? []).filter((part: { type?: string }) => part.type === "output_text").map((part: { text?: string }) => part.text ?? "").join("") : "");
          append(finalText);
        }
        handlers.usage?.(usage);
        completed = true;
        break;
      }
    } else {
      const choice = data.choices?.find((item: { index?: number }) => item.index === 0 || item.index === undefined);
      if (choice?.finish_reason && choice.finish_reason !== "stop") throw new Error(`Provider translation stopped: ${choice.finish_reason}.`);
      if (choice?.delta?.refusal) throw new Error("The provider declined to translate this page.");
      if (typeof choice?.delta?.reasoning_content === "string" && choice.delta.reasoning_content) handlers.reasoning(choice.delta.reasoning_content);
      append(choice?.delta?.content);
      if (data.usage) { usage = data.usage; handlers.usage?.(usage); }
    }
  }
  if (!completed) throw new Error("Provider stream ended before completion.");
  if (!text) throw new Error("The model returned no translation text.");
  return isResponses ? { output_text: text, usage } : { choices: [{ message: { content: text } }], usage };
}
