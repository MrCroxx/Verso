"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { DEFAULT_SETTINGS, EMPTY_TRANSLATION_SERVICE, type AppSettings, type TranslationService } from "../lib/app-settings";
import type { AiProviderSettingsUpdate, PublicAiProviderSettings } from "../lib/ai-provider-settings";

import { useAiProviderAutosave } from "./ai-provider-autosave";
import { parseTheme, watchTheme, type ThemeMode } from "../lib/theme";

type AppSettingsContextValue = {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  theme: ThemeMode;
  setTheme: Dispatch<SetStateAction<ThemeMode>>;
  translationService: TranslationService;
  providerError: boolean;
  reloadProvider: () => Promise<void>;
  providerAutosave: ReturnType<typeof useAiProviderAutosave>;
};
const AppSettingsContext = createContext<AppSettingsContextValue | null>(null);

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState(DEFAULT_SETTINGS);
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [ready, setReady] = useState(false);
  const [translationService, setTranslationService] = useState(EMPTY_TRANSLATION_SERVICE);
  const [providerError, setProviderError] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = JSON.parse(localStorage.getItem("verso-settings") || "null") as Partial<AppSettings> | null;
        if (stored) setSettingsState({
          ...DEFAULT_SETTINGS,
          targetLanguage: typeof stored.targetLanguage === "string" && stored.targetLanguage ? stored.targetLanguage : DEFAULT_SETTINGS.targetLanguage,
          nearbyPages: boundedInteger(stored.nearbyPages, 1, 4, DEFAULT_SETTINGS.nearbyPages),
          translationConcurrency: boundedInteger(stored.translationConcurrency, 1, 6, DEFAULT_SETTINGS.translationConcurrency),
          smoothScrolling: typeof stored.smoothScrolling === "boolean" ? stored.smoothScrolling : DEFAULT_SETTINGS.smoothScrolling,
          translationAnimation: typeof stored.translationAnimation === "boolean" ? stored.translationAnimation : DEFAULT_SETTINGS.translationAnimation,
          translationAnimationSpeed: stored.schemaVersion === DEFAULT_SETTINGS.schemaVersion
            ? boundedInteger(stored.translationAnimationSpeed, 20, 120, DEFAULT_SETTINGS.translationAnimationSpeed)
            : DEFAULT_SETTINGS.translationAnimationSpeed,
        });
      } catch {
        // Browser preferences are optional; document data remains on the server.
      }
      let nextTheme: ThemeMode = "system";
      try {
        nextTheme = parseTheme(localStorage.getItem("verso-theme"));
      } catch { /* Use the system theme when browser storage is unavailable. */ }
      setTheme(nextTheme);
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const setSettings = useCallback((next: AppSettings) => {
    setSettingsState(next);
    try { localStorage.setItem("verso-settings", JSON.stringify(next)); } catch { /* Keep preferences for this session. */ }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.smoothScroll = settings.smoothScrolling ? "true" : "false";
  }, [settings.smoothScrolling]);

  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem("verso-theme", theme); } catch { /* Keep the theme for this session. */ }
    return watchTheme(theme);
  }, [ready, theme]);

  const reloadProvider = useCallback(async () => {
    try {
      const response = await fetch("/api/settings/ai-provider", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load AI settings.");
      const result = await response.json() as PublicAiProviderSettings;
      setTranslationService({ ...result, loaded: true });
      setProviderError(false);
    } catch {
      setProviderError(true);
      setTranslationService((current) => ({ ...current, loaded: true }));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void reloadProvider(), 0);
    return () => window.clearTimeout(timer);
  }, [reloadProvider]);

  const saveTranslationService = useCallback(async (next: AiProviderSettingsUpdate) => {
    const response = await fetch("/api/settings/ai-provider", {
      method: "PUT",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    const result = await response.json() as PublicAiProviderSettings & { error?: string };
    if (!response.ok) throw new Error(result.error || "Unable to save AI settings.");
    setTranslationService({ ...result, loaded: true });
    setProviderError(false);
  }, []);

  const providerAutosave = useAiProviderAutosave(saveTranslationService);

  const value = useMemo(() => ({ settings, setSettings, theme, setTheme, translationService, providerError, reloadProvider, providerAutosave }),
    [settings, setSettings, theme, translationService, providerError, reloadProvider, providerAutosave]);
  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function useAppSettings() {
  const value = useContext(AppSettingsContext);
  if (!value) throw new Error("useAppSettings must be used inside AppSettingsProvider.");
  return value;
}
