"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, CircleAlert, Copy } from "lucide-react";
import { copyText } from "../lib/clipboard";
import type { UiMessages } from "../lib/ui-messages";

export function SourceCodeBlock({ text, language, className, style, messages }: {
  text: string;
  language: string;
  className: string;
  style?: CSSProperties;
  messages: Pick<UiMessages, "copyCode" | "codeCopied" | "codeCopyFailed">;
}) {
  const [feedback, setFeedback] = useState<{ text: string; status: "copying" | "copied" | "failed" } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);
  const status = feedback?.text === text ? feedback.status : undefined;
  const label = status === "copied" ? messages.codeCopied : status === "failed" ? messages.codeCopyFailed : messages.copyCode;
  const Icon = status === "copied" ? Check : status === "failed" ? CircleAlert : Copy;
  const copy = async () => {
    if (timer.current) clearTimeout(timer.current);
    setFeedback({ text, status: "copying" });
    let status: "copied" | "failed" = "copied";
    try { await copyText(text); } catch { status = "failed"; }
    if (!mounted.current) return;
    setFeedback({ text, status });
    timer.current = setTimeout(() => setFeedback(null), 2500);
  };
  return <div className={`${className} source-code-block`} style={style}>
    <div className="source-code-toolbar">
      <span className="source-code-language">{language}</span>
      <button type="button" className="source-code-copy" title={label} aria-label={label} onClick={() => void copy()} disabled={status === "copying"}>
        <Icon size={16} aria-hidden="true" />
      </button>
      <span className="source-code-status" role="status">{status === "copied" || status === "failed" ? label : ""}</span>
    </div>
    <pre tabIndex={0}><code>{text}</code></pre>
  </div>;
}
