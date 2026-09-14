"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { isOpenFileShortcut, isSettingsShortcut } from "../lib/keyboard-shortcuts";

type OpenFileContextValue = {
  openFile: () => void;
  pendingFile: File | null;
  consumeFile: () => void;
};
const OpenFileContext = createContext<OpenFileContextValue | null>(null);

export function useOpenFile() {
  const context = useContext(OpenFileContext);
  if (!context) throw new Error("useOpenFile must be used inside AppShortcuts.");
  return context;
}

export function AppShortcuts({ children }: { children: ReactNode }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const openFile = useCallback(() => fileInput.current?.click(), []);
  const consumeFile = useCallback(() => setPendingFile(null), []);
  const value = useMemo(() => ({ openFile, pendingFile, consumeFile }), [openFile, pendingFile, consumeFile]);

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
  }, [openFile, router]);

  return <OpenFileContext.Provider value={value}>
    {children}
    <input ref={fileInput} data-open-file-input type="file" accept="application/pdf" hidden onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file) return;
      // Retain the selected file only until the reader consumes it after navigation.
      setPendingFile(file);
      if (window.location.pathname !== "/") router.push("/");
    }} />
  </OpenFileContext.Provider>;
}
