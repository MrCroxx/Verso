import { readEventStream } from "./event-stream.ts";

export type TranslationProgress = {
  phase: "queued" | "preparing" | "waiting" | "thinking" | "generating" | "aligning";
  lastLine?: string;
  characters?: number;
};

// The model writes structured JSON. Preview only text values, never layout syntax.
export function createTranslationPreview() {
  let inString = false, escaped = false, unicode = "", token = "", key = "", afterString = false;
  let capturing = false, line = "", previousLine = "";
  const append = (value: string) => {
    for (const character of value) {
      if (character === "\n" || character === "\r") { if (line.trim()) previousLine = line; line = ""; }
      else line = (line + character).slice(-240);
    }
  };
  return (delta: string) => {
    for (const character of delta) {
      if (inString) {
        let decoded = character;
        if (unicode) {
          unicode += character;
          if (unicode.length < 5) continue;
          decoded = /^[u][\da-f]{4}$/i.test(unicode) ? String.fromCharCode(parseInt(unicode.slice(1), 16)) : "";
          unicode = "";
        } else if (escaped) {
          escaped = false;
          if (character === "u") { unicode = "u"; continue; }
          decoded = ({ n: "\n", r: "\r", t: "\t", b: "", f: "" } as Record<string, string>)[character] ?? character;
        } else if (character === "\\") { escaped = true; continue; }
        else if (character === '"') { inString = false; afterString = true; capturing = false; continue; }
        token = (token + decoded).slice(-80);
        if (capturing) append(decoded);
      } else if (character === '"') {
        inString = true; token = ""; afterString = false; capturing = key === "text";
        if (capturing) { if (line.trim()) previousLine = line; line = ""; }
        key = "";
      } else if (character === ":" && afterString) { key = token; afterString = false; }
      else if (!/\s/.test(character)) { key = ""; afterString = false; }
    }
    return line.trim() || previousLine.trim();
  };
}

export async function readTranslationResponse<T>(response: Response, onProgress: (progress: TranslationProgress) => void): Promise<T> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return response.json() as Promise<T>;
  if (!response.body) throw new Error("Translation stream is unavailable.");
  for await (const event of readEventStream(response.body)) {
    const data = JSON.parse(event.data);
    if (event.event === "progress") onProgress(data);
    if (event.event === "result") return data as T;
    if (event.event === "error") return data as T;
  }
  throw new Error("Translation stream ended before the result arrived.");
}
