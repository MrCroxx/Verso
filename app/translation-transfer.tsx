"use client";

import { FileDown, FileUp, LoaderCircle, X } from "lucide-react";
import { useRef, useState } from "react";
import type { UiMessages } from "../lib/ui-messages";
import { MAX_TRANSLATION_ARCHIVE_BYTES, type TranslationImportResult } from "../lib/translation-archive";

export function TranslationTransfer({ documentId, messages, disabled = false, menu = false, onImported }: {
  documentId?: string;
  messages: UiMessages;
  disabled?: boolean;
  menu?: boolean;
  onImported?: () => void | Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  const endpoint = `/api/translations/archive${documentId ? `?${new URLSearchParams({ documentId })}` : ""}`;
  const importLabel = documentId ? messages.importTranslations : messages.importLibraryTranslations;
  const exportLabel = documentId ? messages.exportTranslations : messages.exportLibraryTranslations;

  async function transfer(file?: File) {
    if (active.current || disabled) return;
    active.current = true;
    setBusy(true);
    setNotice("");
    setFailed(false);
    try {
      if (file && file.size > MAX_TRANSLATION_ARCHIVE_BYTES) throw new Error("ARCHIVE_TOO_LARGE");
      const response = await fetch(endpoint, file
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: file }
        : { cache: "no-store" });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error);
      }
      if (file) {
        const result = await response.json() as TranslationImportResult;
        await onImported?.();
        if (result.missingBooks) {
          setNotice(messages.translationArchiveMissing(result.missingBooks));
          setFailed(true);
        }
      } else {
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || `verso-translations-${Date.now()}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (error) {
      const errors: Record<string, string> = {
        INVALID_ARCHIVE: messages.translationArchiveInvalid,
        BOOK_MISMATCH: messages.translationArchiveMismatch,
        BOOK_NOT_FOUND: messages.translationArchiveBookMissing,
        ARCHIVE_TOO_LARGE: messages.translationArchiveTooLarge,
      };
      setNotice(errors[error instanceof Error ? error.message : ""] || messages.translationArchiveFailed);
      setFailed(true);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  return (
    <div className={`translation-transfer${menu ? " translation-transfer-menu" : ""}`} aria-busy={busy}>
      <div className="translation-transfer-actions">
        <button type="button" role={menu ? "menuitem" : undefined} className={menu ? undefined : "secondary-button"}
          title={messages.translationArchiveHelp} disabled={disabled || busy} onClick={() => input.current?.click()}>
          <FileUp size={menu ? 17 : 15} /><span>{importLabel}</span>
        </button>
        <button type="button" role={menu ? "menuitem" : undefined} className={menu ? undefined : "secondary-button"}
          title={messages.translationArchiveHelp} disabled={disabled || busy} onClick={() => void transfer()}>
          <FileDown size={menu ? 17 : 15} /><span>{exportLabel}</span>
        </button>
        {busy && <span role="status"><LoaderCircle size={15} className="spin" />{messages.translationArchiveBusy}</span>}
      </div>
      {!menu && <p className="translation-transfer-help">{messages.translationArchiveHelp}</p>}
      <input ref={input} type="file" accept=".json,application/json" aria-label={importLabel} hidden disabled={disabled || busy} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void transfer(file);
      }} />
      {notice && <div className={`translation-transfer-notice${failed ? " failed" : ""}`}>
        <span role={failed ? "alert" : "status"}>{notice}</span>
        <button type="button" className="icon-button" aria-label={messages.closeError} onClick={() => setNotice("")}><X size={15} /></button>
      </div>}
    </div>
  );
}
