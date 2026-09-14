"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Keyboard } from "lucide-react";
import { useRouter } from "next/navigation";
import { historyShortcutDirection, isEditableShortcutTarget, isOpenFileShortcut, isSettingsShortcut, isShortcutHelpShortcut } from "../lib/keyboard-shortcuts";
import { UI_MESSAGES } from "../lib/ui-messages";
import { useUiLocale } from "./ui-locale";
import styles from "./shortcut-help.module.css";

type AppShortcutContextValue = {
  openFile: () => void;
  pendingFile: File | null;
  consumeFile: () => void;
  showShortcuts: () => void;
  shortcutsVisible: boolean;
  shortcutModifier: string;
  back: () => void;
  forward: () => void;
};
const AppShortcutContext = createContext<AppShortcutContextValue | null>(null);

export function useAppShortcuts() {
  const context = useContext(AppShortcutContext);
  if (!context) throw new Error("useAppShortcuts must be used inside AppShortcuts.");
  return context;
}

export function AppShortcuts({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { locale } = useUiLocale();
  const messages = UI_MESSAGES[locale];
  const helpVisible = useRef(false);
  const [shortcutsVisible, setShortcutsVisible] = useState(false);
  const showShortcuts = useCallback(() => {
    helpVisible.current = true;
    setShortcutsVisible(true);
  }, []);
  const [shortcutModifier, setShortcutModifier] = useState("Ctrl+");
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const openFile = useCallback(() => fileInput.current?.click(), []);
  const consumeFile = useCallback(() => setPendingFile(null), []);
  const back = useCallback(() => {
    window.dispatchEvent(new Event("verso:before-history-navigation"));
    router.back();
  }, [router]);
  const forward = useCallback(() => {
    window.dispatchEvent(new Event("verso:before-history-navigation"));
    router.forward();
  }, [router]);
  const value = useMemo(() => ({ openFile, pendingFile, consumeFile, showShortcuts, shortcutsVisible, shortcutModifier, back, forward }),
    [openFile, pendingFile, consumeFile, showShortcuts, shortcutsVisible, shortcutModifier, back, forward]);

  useEffect(() => {
    const timer = window.setTimeout(() => setShortcutModifier(/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    function openSettings() {
      if (window.location.pathname === "/settings") return;
      // Use the reader's entry point so its current book and page are retained.
      const trigger = document.querySelector<HTMLElement>("[data-settings-trigger]");
      if (trigger) trigger.click();
      else router.push("/settings");
    }
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (!isEditableShortcutTarget(event.target)) {
        if (isShortcutHelpShortcut(event)) {
          event.preventDefault();
          if (!event.repeat) showShortcuts();
          return;
        }
        const direction = historyShortcutDirection(event);
        if (direction) {
          event.preventDefault();
          if (event.repeat) return;
          if (direction === "back") back();
          else forward();
          return;
        }
      }
      if (isOpenFileShortcut(event)) {
        event.preventDefault();
        openFile();
        return;
      }
      if (!isSettingsShortcut(event)) return;
      event.preventDefault();
      openSettings();
    }
    function hideHelp() {
      helpVisible.current = false;
      setShortcutsVisible(false);
    }
    function dismissHelp(event: KeyboardEvent) {
      if (!helpVisible.current) return;
      // Consume dismissal before focused controls or other shortcuts handle it.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) hideHelp();
    }
    function visibilityChanged() { if (document.hidden) hideHelp(); }
    window.addEventListener("keydown", dismissHelp, true);
    window.addEventListener("keydown", keydown);
    window.addEventListener("verso:open-settings", openSettings);
    window.addEventListener("blur", hideHelp);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      window.removeEventListener("keydown", dismissHelp, true);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("verso:open-settings", openSettings);
      window.removeEventListener("blur", hideHelp);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [back, forward, openFile, router, showShortcuts]);

  const shortcutGroups = [
    { label: messages.shortcutGeneral, rows: [
      [messages.openPdf, [`${shortcutModifier}O`]],
      [messages.settings, [`${shortcutModifier},`]],
      [messages.historyBack, [`${shortcutModifier}[`]],
      [messages.historyForward, [`${shortcutModifier}]`]],
    ] as [string, string[]][] },
    { label: messages.shortcutReading, rows: [
      [messages.toggleSidebar, [`${shortcutModifier}B`]],
      [messages.searchPages, [`${shortcutModifier}F`]],
      [messages.shortcutZoom, [`${shortcutModifier}+`, `${shortcutModifier}−`]],
      [messages.fitWidth, [`${shortcutModifier}0`]],
    ] as [string, string[]][] },
  ];
  return <AppShortcutContext.Provider value={value}>
    {children}
    {shortcutsVisible && <aside className={styles.panel} id="shortcut-help-panel" role="tooltip" aria-labelledby="shortcut-help-title">
      <div className={styles.heading}>
        <span className={styles.icon}><Keyboard size={18} aria-hidden="true" /></span>
        <h2 id="shortcut-help-title">{messages.keyboardShortcuts}</h2>
        <kbd className={styles.triggerKey}>?</kbd>
      </div>
      <div className={styles.groups}>
        {shortcutGroups.map((group) => <section className={styles.group} key={group.label}>
          <h3>{group.label}</h3>
          <dl>{group.rows.map(([label, keys]) => <div className={styles.row} key={label}>
            <dt>{label}</dt><dd>{keys.map((key) => <kbd key={key}>{key}</kbd>)}</dd>
          </div>)}</dl>
        </section>)}
      </div>
      <p className={styles.hint}>{messages.keyboardShortcutsHelp}</p>
    </aside>}
    <input ref={fileInput} data-open-file-input type="file" accept="application/pdf" hidden onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file) return;
      // Retain the selected file only until the reader consumes it after navigation.
      setPendingFile(file);
      if (window.location.pathname !== "/") router.push("/");
    }} />
  </AppShortcutContext.Provider>;
}

export function ShortcutHelpButton({ menu = false }: { menu?: boolean }) {
  const { showShortcuts, shortcutsVisible } = useAppShortcuts();
  const { locale } = useUiLocale();
  const label = UI_MESSAGES[locale].keyboardShortcuts;
  return <button type="button" className={menu ? "shortcut-help-button" : "icon-button shortcut-help-button"}
    role={menu ? "menuitem" : undefined} aria-label={label} title={`${label} (?)`} aria-keyshortcuts="?"
    aria-describedby={shortcutsVisible ? "shortcut-help-panel" : undefined}
    onClick={showShortcuts}><Keyboard size={17} />{menu && <span>{label}</span>}</button>;
}

export function NavigationHistoryControls() {
  const { back, forward, shortcutModifier } = useAppShortcuts();
  const { locale } = useUiLocale();
  const messages = UI_MESSAGES[locale];
  return <div className="navigation-history-controls">
    <button type="button" className="icon-button history-back-button" onClick={back}
      aria-label={messages.historyBack} title={`${messages.historyBack} (${shortcutModifier}[)`} aria-keyshortcuts="Meta+[ Control+["><ArrowLeft size={17} /></button>
    <button type="button" className="icon-button history-forward-button" onClick={forward}
      aria-label={messages.historyForward} title={`${messages.historyForward} (${shortcutModifier}])`} aria-keyshortcuts="Meta+] Control+]"><ArrowRight size={17} /></button>
  </div>;
}
