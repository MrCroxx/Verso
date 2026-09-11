"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeAiProviderSettingsUpdate, type AiProviderSettingsUpdate } from "../lib/ai-provider-settings";

export type ProviderSaveStatus = "idle" | "pending" | "saving" | "saved" | "invalid" | "error";

export function useAiProviderAutosave(save: (settings: AiProviderSettingsUpdate) => Promise<void>) {
  const [draft, setDraft] = useState<AiProviderSettingsUpdate | null>(null);
  const [status, setStatus] = useState<ProviderSaveStatus>("idle");
  const pending = useRef<AiProviderSettingsUpdate | null>(null);
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const queuedRevision = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback((): Promise<void> => {
    clearTimeout(timer.current);
    const next = pending.current;
    const version = revision.current;
    if (!next || savedRevision.current === version) return Promise.resolve();
    if (queuedRevision.current === version) return queue.current;
    if (!normalizeAiProviderSettingsUpdate(next, null)) {
      setStatus("invalid");
      return Promise.reject(new Error("Invalid AI provider settings."));
    }
    queuedRevision.current = version;
    const request = queue.current.catch(() => undefined).then(async () => {
      if (revision.current === version) setStatus("saving");
      try {
        await save(next);
        savedRevision.current = version;
        if (revision.current === version) {
          // Keep the masked draft intact so a pause while typing cannot truncate the key.
          setStatus("saved");
        }
      } catch (error) {
        if (queuedRevision.current === version) queuedRevision.current = 0;
        if (revision.current === version) setStatus("error");
        throw error;
      }
    });
    queue.current = request;
    return request;
  }, [save]);

  const update = useCallback((next: AiProviderSettingsUpdate) => {
    pending.current = next;
    revision.current += 1;
    setDraft(next);
    setStatus("pending");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush().catch(() => undefined), 600);
  }, [flush]);

  useEffect(() => {
    const flushOnLeave = () => { void flush().catch(() => undefined); };
    window.addEventListener("pagehide", flushOnLeave);
    return () => {
      window.removeEventListener("pagehide", flushOnLeave);
      clearTimeout(timer.current);
    };
  }, [flush]);

  return { draft, status, update, flush };
}
