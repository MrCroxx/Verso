"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Keyboard, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { historyShortcutDirection, isEditableShortcutTarget, isOpenFileShortcut, isSettingsShortcut, isShortcutHelpShortcut } from "../lib/keyboard-shortcuts";
import { UI_MESSAGES } from "../lib/ui-messages";
import { useUiLocale } from "./ui-locale";

type AppShortcutContextValue = {
  openFile: () => void;
  pendingFile: File | null;
  consumeFile: () => void;
  showShortcuts: () => void;
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
  const dialog = useRef<HTMLDialogElement>(null);
  const shortcutHelpOpener = useRef<HTMLElement | null>(null);
  const [shortcutModifier, setShortcutModifier] = useState("Ctrl+");
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const openFile = useCallback(() => fileInput.current?.click(), []);
  const consumeFile = useCallback(() => setPendingFile(null), []);
  const showShortcuts = useCallback(() => {
    if (dialog.current?.open) return;
    shortcutHelpOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.showModal();
  }, []);
  const back = useCallback(() => {
    window.dispatchEvent(new Event("verso:before-history-navigation"));
    router.back();
  }, [router]);
  const forward = useCallback(() => {
    window.dispatchEvent(new Event("verso:before-history-navigation"));
    router.forward();
  }, [router]);
  const value = useMemo(() => ({ openFile, pendingFile, consumeFile, showShortcuts, shortcutModifier, back, forward }),
    [openFile, pendingFile, consumeFile, showShortcuts, shortcutModifier, back, forward]);

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
      if (dialog.current?.open) return;
      if (!isEditableShortcutTarget(event.target)) {
        if (isShortcutHelpShortcut(event)) {
          event.preventDefault();
          showShortcuts();
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
    window.addEventListener("keydown", keydown);
    window.addEventListener("verso:open-settings", openSettings);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("verso:open-settings", openSettings);
    };
  }, [back, forward, openFile, router, showShortcuts]);

  const shortcutRows = [
    [messages.openPdf, `${shortcutModifier}O`],
    [messages.settings, `${shortcutModifier},`],
    [messages.historyBack, `${shortcutModifier}[`],
    [messages.historyForward, `${shortcutModifier}]`],
    [messages.toggleSidebar, `${shortcutModifier}B`],
    [messages.searchPages, `${shortcutModifier}F`],
    [messages.zoomIn, `${shortcutModifier}+`],
    [messages.zoomOut, `${shortcutModifier}-`],
    [messages.fitWidth, `${shortcutModifier}0`],
    [messages.keyboardShortcuts, "?"],
    [messages.closeShortcutHelp, "Esc"],
  ];
  return <AppShortcutContext.Provider value={value}>
    {children}
    <dialog ref={dialog} className="shortcut-dialog" aria-labelledby="shortcut-dialog-title"
      onClose={() => { if (shortcutHelpOpener.current?.isConnected) shortcutHelpOpener.current.focus({ preventScroll: true }); }}
      onKeyDown={(event) => event.stopPropagation()} onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.current?.close();
      }}>
      <div className="shortcut-dialog-heading">
        <h2 id="shortcut-dialog-title">{messages.keyboardShortcuts}</h2>
        <button type="button" className="icon-button" autoFocus aria-label={messages.closeShortcutHelp} onClick={() => dialog.current?.close()}><X size={18} /></button>
      </div>
      <p>{messages.keyboardShortcutsHelp}</p>
      <dl>{shortcutRows.map(([label, key]) => <div key={label}><dt>{label}</dt><dd><kbd>{key}</kbd></dd></div>)}</dl>
    </dialog>
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
  const { showShortcuts } = useAppShortcuts();
  const { locale } = useUiLocale();
  const label = UI_MESSAGES[locale].keyboardShortcuts;
  return <button type="button" className={menu ? "shortcut-help-button" : "icon-button shortcut-help-button"}
    role={menu ? "menuitem" : undefined} aria-label={label} title={`${label} (?)`} aria-keyshortcuts="?"
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
