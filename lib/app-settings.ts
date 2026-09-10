import { DEFAULT_AI_PROVIDER_SETTINGS, type PublicAiProviderSettings } from "./ai-provider-settings";
import { DEFAULT_TYPEWRITER_CHARACTERS_PER_SECOND } from "./translation-typewriter";

export type TranslationSettings = {
  targetLanguage: string;
  translationConcurrency: number;
};

export type AppSettings = TranslationSettings & {
  schemaVersion: number;
  nearbyPages: number;
  smoothScrolling: boolean;
  translationAnimation: boolean;
  translationAnimationSpeed: number;
};

export type TranslationService = PublicAiProviderSettings & {
  loaded: boolean;
};

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 2,
  targetLanguage: "Simplified Chinese",
  nearbyPages: 2,
  translationConcurrency: 4,
  smoothScrolling: true,
  translationAnimation: true,
  translationAnimationSpeed: DEFAULT_TYPEWRITER_CHARACTERS_PER_SECOND,
};

export const EMPTY_TRANSLATION_SERVICE: TranslationService = {
  ...DEFAULT_AI_PROVIDER_SETTINGS,
  loaded: false,
  configured: false,
  apiKeyConfigured: false,
  apiKeyHint: "",
  updatedAt: 0,
};
