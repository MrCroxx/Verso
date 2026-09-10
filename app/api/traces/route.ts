import { NextRequest, NextResponse } from "next/server";
import { listTranslationTraces } from "../../../lib/server-translation-trace";
import { chromeTrace } from "../../../lib/translation-trace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const traces = await listTranslationTraces();
  const id = request.nextUrl.searchParams.get("id");
  const selected = id ? traces.filter((trace) => trace.id === id) : traces;
  const download = request.nextUrl.searchParams.get("format") === "chrome";
  return NextResponse.json(download ? chromeTrace(selected) : { traces: selected }, { headers: {
    "Cache-Control": "no-store", ...(download ? { "Content-Disposition": 'attachment; filename="verso-trace.json"' } : {}),
  } });
}
