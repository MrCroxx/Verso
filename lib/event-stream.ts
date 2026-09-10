// SSE frames can span network chunks, UTF-8 code points, and CRLF boundaries.
export async function* readEventStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let size = 0;
  let event = "message";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length + size > 16 * 1024 * 1024) throw new Error("Stream event exceeds the size limit.");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (data.length) yield { event, data: data.join("\n") };
          data = []; size = 0; event = "message";
        } else if (line.startsWith("data:")) {
          const part = line.slice(5).replace(/^ /, "");
          data.push(part); size += part.length;
        } else if (line.startsWith("event:")) event = line.slice(6).trim();
      }
      // An incomplete final frame is not a successful terminal event.
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
