import { NextRequest, NextResponse } from "next/server";
import { getStorage } from "../../../../../../../db/books";

export const runtime = "edge";

type RouteContext = { params: Promise<{ uploadId: string; partNumber: string }> };

export async function PUT(request: NextRequest, context: RouteContext) {
  try {
    const { uploadId, partNumber: rawPartNumber } = await context.params;
    const objectKey = request.headers.get("x-object-key");
    const partNumber = Number(rawPartNumber);
    if (!objectKey?.startsWith("books/") || !Number.isInteger(partNumber) || partNumber < 1 || !request.body) {
      return NextResponse.json({ error: "Invalid upload part." }, { status: 400 });
    }
    const { bucket } = getStorage();
    const upload = bucket.resumeMultipartUpload(objectKey, uploadId);
    const part = await upload.uploadPart(partNumber, request.body);
    return NextResponse.json({ partNumber: part.partNumber, etag: part.etag });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to upload book part.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
