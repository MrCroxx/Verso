"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, LoaderCircle, X } from "lucide-react";
import type { SourceWord } from "../lib/source-alignment";
import type { UiMessages } from "../lib/ui-messages";

type WordLookupResult = {
  word: string;
  lemma: string;
  phonetic: string;
  meanings: Array<{ pos: string; text: string }>;
  note?: string;
};

type LookupAnchor = { left: number; top: number; width: number; height: number };

const CARD_WIDTH = 288;
const lookupCache = new Map<string, WordLookupResult>();

function displayWord(text: string) {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || text;
}

export function SourceWordLookup({ anchor, word, notice, context = "", targetLanguage, messages, onClose }: {
  anchor: LookupAnchor;
  word?: SourceWord;
  notice?: "unavailable" | "noWord";
  context?: string;
  targetLanguage: string;
  messages: UiMessages;
  onClose: () => void;
}) {
  const wordText = word ? displayWord(word.text) : "";
  const key = word ? [wordText, targetLanguage].join("\u0000") : "";
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; result?: WordLookupResult; error?: string; notConfigured?: boolean }>(() => {
    const cached = lookupCache.get(key);
    return cached ? { status: "ready", result: cached } : { status: "loading" };
  });
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!word || lookupCache.has(key)) return;
    const controller = new AbortController();
    void fetch("/api/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word: wordText, context, targetLanguage }),
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json().catch(() => ({})) as WordLookupResult & { error?: string };
      if (!response.ok) {
        throw Object.assign(new Error(body.error || messages.lookupFailed), { status: response.status });
      }
      lookupCache.set(key, body);
      setState({ status: "ready", result: body });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setState({
        status: "error",
        error: error instanceof Error ? error.message : messages.lookupFailed,
        notConfigured: (error as { status?: number }).status === 503,
      });
    });
    return () => controller.abort();
  }, [context, key, messages.lookupFailed, targetLanguage, word, wordText]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const closeOutside = (event: PointerEvent) => {
      if (cardRef.current && !cardRef.current.contains(event.target as Node)) onClose();
    };
    const closeOnMove = (event: Event) => {
      if (cardRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    // Keep the opening click from immediately closing the card.
    const timer = window.setTimeout(() => document.addEventListener("pointerdown", closeOutside), 0);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", closeOnMove, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", closeOnMove, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const style = useMemo(() => {
    const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
    const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
    const width = Math.min(CARD_WIDTH, viewportWidth - 24);
    const left = Math.min(Math.max(12, anchor.left + anchor.width / 2 - width / 2), viewportWidth - width - 12);
    const below = anchor.top + anchor.height + 10;
    const above = anchor.top - 10;
    const placeAbove = below > viewportHeight - 260 && above > 260;
    return {
      left,
      top: placeAbove ? above : below,
      width,
      ...(placeAbove ? { transform: "translateY(-100%)" } : {}),
    };
  }, [anchor]);

  const copy = () => {
    if (!word) return;
    void navigator.clipboard?.writeText(wordText).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };

  const result = state.result;
  return createPortal(
    <div ref={cardRef} className="word-lookup-card" style={style} role="dialog" aria-label={wordText || (notice ? messages.lookupTitle : messages.lookupLoading)}>
      <div className="word-lookup-head">
        <div className="word-lookup-title">
          <strong className="word-lookup-word">{wordText || (notice ? messages.lookupTitle : messages.lookupLoading)}</strong>
          {result?.phonetic && <span className="word-lookup-phonetic">{result.phonetic}</span>}
          {result && result.lemma && result.lemma.toLocaleLowerCase() !== wordText.toLocaleLowerCase() && (
            <span className="word-lookup-lemma">{result.lemma}</span>
          )}
        </div>
        <div className="word-lookup-actions">
          {word && (
            <button className="icon-button subtle" onClick={copy} title={messages.lookupCopy} aria-label={messages.lookupCopy}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          )}
          <button className="icon-button subtle" onClick={onClose} title={messages.lookupClose} aria-label={messages.lookupClose}>
            <X size={15} />
          </button>
        </div>
      </div>
      {notice ? (
        <p className="word-lookup-status">{notice === "unavailable" ? messages.lookupUnavailable : messages.lookupNoWord}</p>
      ) : !word ? (
        <p className="word-lookup-status"><LoaderCircle className="spin" size={14} /> {messages.lookupLoading}</p>
      ) : state.status === "loading" ? (
        <p className="word-lookup-status"><LoaderCircle className="spin" size={14} /> {messages.lookupLoading}</p>
      ) : state.status === "error" ? (
        <p className="word-lookup-status error">{state.notConfigured ? messages.lookupNotConfigured : state.error}</p>
      ) : result ? (
        <>
          {copied && <p className="word-lookup-status">{messages.lookupCopied}</p>}
          <ul className="word-lookup-meanings">
            {result.meanings.map((meaning, index) => (
              <li key={index}>
                <span className="word-lookup-pos">{meaning.pos}</span>
                <span>{meaning.text}</span>
              </li>
            ))}
          </ul>
          {result.note && <p className="word-lookup-note">{result.note}</p>}
        </>
      ) : null}
    </div>,
    document.body,
  );
}
