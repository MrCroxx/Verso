"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { parseTheme } from "../lib/theme";
import { UI_MESSAGES } from "../lib/ui-messages";
import { useAppSettings } from "./app-settings";
import { useUiLocale } from "./ui-locale";

export function ThemeSelect({ compact = false, id }: { compact?: boolean; id?: string }) {
  const { theme, setTheme } = useAppSettings();
  const { locale } = useUiLocale();
  const messages = UI_MESSAGES[locale];
  const Icon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  const label = `${messages.theme}: ${messages.themeOptions[theme]}`;
  const select = (
    <select id={id} value={theme} aria-label={messages.theme} title={label} onChange={(event) => setTheme(parseTheme(event.target.value))}>
      {(["system", "light", "dark"] as const).map((mode) => <option key={mode} value={mode}>{messages.themeOptions[mode]}</option>)}
    </select>
  );
  return compact ? <div className="icon-button theme-select"><Icon size={17} aria-hidden="true" />{select}</div> : select;
}
