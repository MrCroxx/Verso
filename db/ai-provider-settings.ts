import type { AiProviderSettings } from "../lib/ai-provider-settings";
import { ensureStorageSchema, getStorage, hardenStoragePermissions } from "./books";

type AiProviderSettingsRow = {
  provider: string;
  endpoint: string;
  api_key: string;
  model: string;
  reasoning_effort: string;
  updated_at: number;
};

export async function getAiProviderSettings(): Promise<AiProviderSettings | null> {
  const { db } = getStorage();
  await ensureStorageSchema(db);
  const row = await db.prepare(`SELECT provider, endpoint, api_key, model, reasoning_effort, updated_at
    FROM ai_provider_settings
    WHERE id = 1`)
    .first<AiProviderSettingsRow>();
  if (!row) return null;
  return {
    provider: row.provider as AiProviderSettings["provider"],
    endpoint: row.endpoint,
    apiKey: row.api_key,
    model: row.model,
    reasoningEffort: row.reasoning_effort as AiProviderSettings["reasoningEffort"],
    updatedAt: Number(row.updated_at),
  };
}

export async function setAiProviderSettings(settings: AiProviderSettings) {
  const { db } = getStorage();
  await ensureStorageSchema(db);
  await db.prepare(`INSERT INTO ai_provider_settings
      (id, provider, endpoint, api_key, model, reasoning_effort, updated_at)
    VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      endpoint = excluded.endpoint,
      api_key = excluded.api_key,
      model = excluded.model,
      reasoning_effort = excluded.reasoning_effort,
      updated_at = excluded.updated_at`)
    .bind(
      settings.provider,
      settings.endpoint,
      settings.apiKey,
      settings.model,
      settings.reasoningEffort,
      settings.updatedAt,
    )
    .run();
  hardenStoragePermissions();
}
