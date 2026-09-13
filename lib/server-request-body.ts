export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the size limit.");
    this.name = "RequestBodyTooLargeError";
  }
}

export async function readLimitedRequestBody(request: Request, maxBytes: number): Promise<Buffer> {
  const reader = request.body?.getReader();
  let complete = false;
  try {
    if (Number(request.headers.get("content-length")) > maxBytes) throw new RequestBodyTooLargeError();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        complete = true;
        return Buffer.concat(chunks, bytes);
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new RequestBodyTooLargeError();
      chunks.push(value);
    }
  } finally {
    if (reader) {
      if (!complete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
