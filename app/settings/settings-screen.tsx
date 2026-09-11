"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, HardDrive, Sparkles } from "lucide-react";
import clsx from "clsx";
import { DEFAULT_AI_PROVIDER_SETTINGS, type AiProviderSettingsUpdate, type ReasoningEffort } from "../../lib/ai-provider-settings";
import type { AppSettings, TranslationService } from "../../lib/app-settings";
import { UI_MESSAGES, targetLanguageLabel, type UiMessages } from "../../lib/ui-messages";
import { useAppSettings } from "../app-settings";
import { useUiLocale } from "../ui-locale";
import { Brand } from "../brand";
import { ThemeSelect } from "../theme-select";

const COPY = {
  "zh-CN": {
    back: "返回阅读", library: "返回书库", appearance: "界面", reading: "阅读体验", translation: "翻译",
    language: "界面语言", languageHelp: "界面语言与翻译目标语言独立设置。",
    autosave: "阅读、翻译和界面偏好修改后自动保存。AI 服务配置也会自动保存。",
    loading: "正在读取 AI 配置…", loadFailed: "无法读取 AI 配置，请重试。", retry: "重试",
  },
  "en-US": {
    back: "Back to reading", library: "Back to library", appearance: "Interface", reading: "Reading", translation: "Translation",
    language: "Interface language", languageHelp: "Interface language is independent of the translation target.",
    autosave: "Reading, translation, and interface preferences save automatically. AI provider changes also save automatically.",
    loading: "Loading AI settings…", loadFailed: "Unable to load AI settings. Please retry.", retry: "Retry",
  },
} as const;

export function SettingsScreen({ backHref }: { backHref: string }) {
  const { locale, setLocale } = useUiLocale();
  const { settings, setSettings, translationService, providerError, reloadProvider } = useAppSettings();
  const messages = UI_MESSAGES[locale];
  const copy = COPY[locale];
  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings({ ...settings, [key]: value });
  }
  return (
    <main className="app-shell settings-shell">
      <header className="topbar library-topbar">
        <Link href="/" className="brand"><Brand /></Link>
        <Link href={backHref} className="secondary-button"><ArrowLeft size={16} />{backHref === "/" ? copy.library : copy.back}</Link>
      </header>
      <div className="settings-page">
        <div className="settings-heading"><h1>{messages.settings}</h1><p>{messages.settingsSubtitle}</p><p>{copy.autosave}</p></div>
        <div className="settings-sections">
          <section id="ai-provider" className="settings-card" aria-labelledby="ai-heading">
            <h2 id="ai-heading">{messages.serverProvider}</h2>
            {providerError ? <div role="alert"><p>{copy.loadFailed}</p><button className="secondary-button" onClick={() => void reloadProvider()}>{copy.retry}</button></div>
              : !translationService.loaded ? <p role="status">{copy.loading}</p>
              : <ProviderForm translationService={translationService} messages={messages} />}
          </section>
          <section id="translation" className="settings-card" aria-labelledby="translation-heading">
            <h2 id="translation-heading">{copy.translation}</h2>
            <Link className="secondary-button" href="/traces">{locale === "zh-CN" ? "查看翻译耗时" : "View translation traces"}</Link>
            <label className="field-label" htmlFor="language">{messages.targetLanguage}</label>
            <select id="language" value={settings.targetLanguage} onChange={(event) => update("targetLanguage", event.target.value)}>
              {Object.keys({
                "Simplified Chinese": true,
                "Traditional Chinese": true,
                English: true,
                Japanese: true,
                Spanish: true,
              }).map((language) => <option key={language} value={language}>{targetLanguageLabel(language, locale)}</option>)}
            </select>

            <label className="field-label" htmlFor="nearby">{messages.prefetchRange(settings.nearbyPages)}</label>
            <input id="nearby" className="range" type="range" min="1" max="4" value={settings.nearbyPages} onChange={(event) => update("nearbyPages", Number(event.target.value))} />

            <label className="field-label" htmlFor="concurrency">{messages.parallelTranslation(settings.translationConcurrency)}</label>
            <input id="concurrency" className="range" type="range" min="1" max="10" value={settings.translationConcurrency} onChange={(event) => update("translationConcurrency", Number(event.target.value))} />
            <p className="field-help">{messages.concurrencyHelp}</p>

            <div className="context-note">
              <Sparkles size={16} />
              <div><strong>{messages.crossPageEnabled}</strong><p>{messages.crossPageHelp}</p></div>
            </div>
          </section>
          <section id="reading" className="settings-card" aria-labelledby="reading-heading">
            <h2 id="reading-heading">{copy.reading}</h2>
            <button
              type="button"
              className={clsx("setting-switch", settings.smoothScrolling && "active")}
              role="switch"
              aria-checked={settings.smoothScrolling}
              onClick={() => update("smoothScrolling", !settings.smoothScrolling)}
            >
              <span><strong>{messages.smoothScrolling}</strong><small>{messages.smoothScrollingHelp}</small></span>
              <i aria-hidden="true"><span /></i>
            </button>

            <button
              type="button"
              className={clsx("setting-switch", settings.translationAnimation && "active")}
              role="switch"
              aria-checked={settings.translationAnimation}
              onClick={() => update("translationAnimation", !settings.translationAnimation)}
            >
              <span><strong>{messages.translationAnimation}</strong><small>{messages.translationAnimationHelp}</small></span>
              <i aria-hidden="true"><span /></i>
            </button>

            <label className="field-label" htmlFor="translation-animation-speed">
              {messages.translationAnimationSpeed(settings.translationAnimationSpeed)}
            </label>
            <input
              id="translation-animation-speed"
              className="range"
              type="range"
              min="20"
              max="120"
              step="5"
              disabled={!settings.translationAnimation}
              value={settings.translationAnimationSpeed}
              onChange={(event) => update("translationAnimationSpeed", Number(event.target.value))}
            />

          </section>
          <section id="interface" className="settings-card" aria-labelledby="interface-heading">
            <h2 id="interface-heading">{copy.appearance}</h2>
            <label className="field-label" htmlFor="interface-language">{copy.language}</label>
            <select id="interface-language" value={locale} onChange={(event) => setLocale(event.target.value as typeof locale)}>
              <option value="zh-CN">简体中文</option><option value="en-US">English</option>
            </select>
            <p className="field-help">{copy.languageHelp}</p>
            <label className="field-label" htmlFor="theme">{messages.theme}</label>
            <ThemeSelect id="theme" />
          </section>
        </div>
      </div>
    </main>
  );
}

function ProviderForm({ translationService, messages }: {
  translationService: TranslationService;
  messages: UiMessages;
}) {
  const { providerAutosave } = useAppSettings();
  const { draft, status, update: updateDraft, flush } = providerAutosave;
  const values: AiProviderSettingsUpdate = draft || {
    provider: translationService.provider,
    endpoint: translationService.endpoint,
    apiKey: "",
    model: translationService.model,
    reasoningEffort: translationService.reasoningEffort,
  };
  const { provider, endpoint, apiKey, model, reasoningEffort } = values;
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState("");
  const [testFailed, setTestFailed] = useState(false);

  function update(next: Partial<AiProviderSettingsUpdate>) {
    setTestMessage("");
    updateDraft({ ...values, ...next });
  }

  async function testConnection() {
    setTesting(true);
    setTestMessage("");
    setTestFailed(false);
    try {
      await flush();
    } catch {
      setTestFailed(true);
      setTestMessage(messages.providerSaveFailed);
      setTesting(false);
      return;
    }
    try {
      const response = await fetch("/api/settings/ai-provider/test", { method: "POST" });
      const result = await response.json() as { error?: string; status?: number; latencyMs?: number };
      if (!response.ok) {
        setTestFailed(true);
        setTestMessage(result.error === "timeout" ? messages.connectionTimeout
          : result.error === "not_configured" ? messages.connectionNotConfigured
          : result.status ? messages.connectionHttpError(result.status) : messages.connectionFailed);
      } else {
        setTestMessage(messages.connectionSucceeded(result.latencyMs || 0));
      }
    } catch {
      setTestFailed(true);
      setTestMessage(messages.connectionFailed);
    } finally {
      setTesting(false);
    }
  }

  const saveMessage = status === "pending" || status === "saving" ? messages.savingProvider
    : status === "saved" ? messages.providerSaved
    : status === "invalid" ? messages.providerInvalid
    : status === "error" ? messages.providerSaveFailed : "";

  return <form onBlur={() => { void flush().catch(() => undefined); }} onSubmit={(event) => { event.preventDefault(); if (!testing) void testConnection(); }}>
    <fieldset disabled={testing}>
        <div className={clsx("server-provider-status", translationService.configured ? "ready" : "missing")}>
          <HardDrive size={17} />
          <div>
            <strong>{messages.serverProvider}</strong>
            <p>
              {translationService.configured
                ? messages.serverProviderReady(translationService.model)
                : messages.serverProviderMissing}
            </p>
          </div>
        </div>

        <label className="field-label">{messages.provider}</label>
        <div className="segmented">
          {(["openai", "compatible"] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={clsx(provider === value && "active")}
              aria-pressed={provider === value}
              onClick={() => {
                update({ provider: value, endpoint: value === "openai" && !endpoint.trim() ? DEFAULT_AI_PROVIDER_SETTINGS.endpoint : endpoint });
              }}
            >
              {value === "openai" ? messages.openaiProvider : messages.compatibleProvider}
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="api-endpoint">{messages.apiEndpoint}</label>
        <input id="api-endpoint" type="url" value={endpoint} onChange={(event) => update({ endpoint: event.target.value })} />

        <label className="field-label" htmlFor="api-key">{messages.apiKey}</label>
        <input
          id="api-key"
          type="password"
          autoComplete="new-password"
          value={apiKey}
          placeholder={translationService.apiKeyHint || messages.apiKeyPlaceholder}
          onChange={(event) => update({ apiKey: event.target.value })}
        />
        <p className="field-help">{messages.apiKeyHelp}</p>

        <div className="field-grid">
          <div>
            <label className="field-label" htmlFor="ai-model">{messages.model}</label>
            <input id="ai-model" value={model} onChange={(event) => update({ model: event.target.value })} />
          </div>
          <div>
            <label className="field-label" htmlFor="reasoning-effort">{messages.reasoningEffort}</label>
            <select
              id="reasoning-effort"
              value={reasoningEffort}
              onChange={(event) => update({ reasoningEffort: event.target.value as ReasoningEffort })}
            >
              {(["none", "low", "medium", "high", "xhigh", "max"] as const).map((effort) => (
                <option key={effort} value={effort}>{effort}</option>
              ))}
            </select>
          </div>
        </div>
        <button
          type="submit"
          className="secondary-button full provider-save-button"
          disabled={testing}
        >
          {testing ? messages.testingConnection : messages.testConnection}
        </button>
        {saveMessage && (
          <p role="status" className={clsx("provider-save-message", (status === "error" || status === "invalid") && "error")}>{saveMessage}</p>
        )}
        {testMessage && (
          <p role="status" className={clsx("provider-save-message", testFailed && "error")}>{testMessage}</p>
        )}

    </fieldset>
  </form>;
}
