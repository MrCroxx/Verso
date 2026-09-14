"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isSettingsShortcut } from "../lib/keyboard-shortcuts";

export function AppShortcuts() {
  const router = useRouter();

  useEffect(() => {
    function openSettings() {
      if (window.location.pathname === "/settings") return;
      // Use the reader's entry point so its current book and page are retained.
      const trigger = document.querySelector<HTMLElement>("[data-settings-trigger]");
      if (trigger) trigger.click();
      else router.push("/settings");
    }
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || !isSettingsShortcut(event)) return;
      event.preventDefault();
      openSettings();
    }
    window.addEventListener("keydown", keydown);
    window.addEventListener("verso:open-settings", openSettings);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("verso:open-settings", openSettings);
    };
  }, [router]);

  return null;
}
