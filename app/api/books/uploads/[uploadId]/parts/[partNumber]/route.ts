import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolveUploadDirectory } from "../../../../../../../db/books";
import { readLimitedRequestBody, RequestBodyTooLargeError } from "../../../../../../../lib/server-request-body";

export const runtime = "nodejs";

const MAX_UPLOAD_PART_BYTES = 8 * 1024 * 1024;

type RouteContext = { params: Promise<{ uploadId: string; partNumber: string }> };

export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    const { uploadId, partNumber: rawPartNumber } = await context.params;
    const objectKey = request.headers.get("x-object-key");
    const partNumber = Number(rawPartNumber);
    if (!/^books\/[a-z0-9-]+\.pdf$/.test(objectKey || "") || !Number.isInteger(partNumber) || partNumber < 1 || !request.body) {
      return NextResponse.json({ error: "Invalid upload part." }, { status: 400 });
    }
    const uploadDirectory = resolveUploadDirectory(uploadId);
    const body = await readLimitedRequestBody(request, MAX_UPLOAD_PART_BYTES);
    if (body.byteLength === 0) {
      return NextResponse.json({ error: "Invalid upload part size." }, { status: 400 });
    }
    await mkdir(uploadDirectory, { recursive: true });
    await writeFile(`${uploadDirectory}/${partNumber}.part`, body, { flag: "wx" });
    const etag = createHash("sha256").update(body).digest("hex");
    return NextResponse.json({ partNumber, etag });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Invalid upload part size." }, { status: 413 });
    }
    const message = error instanceof Error ? error.message : "Unable to write local book part.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
