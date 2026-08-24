import { NextRequest, NextResponse } from "next/server";
import { getAiProviderSettings, setAiProviderSettings } from "../../../../db/ai-provider-settings";
import {
  normalizeAiProviderSettingsUpdate,
  publicAiProviderSettings,
} from "../../../../lib/ai-provider-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_RESPONSE_HEADERS = { "Cache-Control": "no-store, private" };

export async function GET() {
  try {
    const settings = await getAiProviderSettings();
    return NextResponse.json(publicAiProviderSettings(settings), { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read AI provider settings.";
    return NextResponse.json({ error: message }, { status: 503, headers: PRIVATE_RESPONSE_HEADERS });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const existing = await getAiProviderSettings();
    const settings = normalizeAiProviderSettingsUpdate(await request.json(), existing);
    if (!settings) {
      return NextResponse.json({ error: "Invalid AI provider settings." }, { status: 400, headers: PRIVATE_RESPONSE_HEADERS });
    }
    await setAiProviderSettings(settings);
    return NextResponse.json(publicAiProviderSettings(settings), { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save AI provider settings.";
    return NextResponse.json({ error: message }, { status: 503, headers: PRIVATE_RESPONSE_HEADERS });
  }
}
