"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ListOrdered, LoaderCircle, RotateCcw, Square, X } from "lucide-react";
import { DEFAULT_QUEUE_CONCURRENCY, QUEUE_CONCURRENCY_OPTIONS, isTranslationActive, type BookTranslationJob } from "../../lib/translation-queue";
import { UI_MESSAGES, targetLanguageLabel } from "../../lib/ui-messages";
import { useUiLocale } from "../ui-locale";
import { useQueueFeedback } from "../queue-feedback";
import { Brand } from "../brand";

export default function QueuePage() {
  const { locale } = useUiLocale();
  const messages = UI_MESSAGES[locale];
  const { notice, setNotice } = useQueueFeedback();
  const [jobs, setJobs] = useState<BookTranslationJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Set<string>>(new Set());
  const revision = useRef(0);
  const [concurrency, setConcurrency] = useState(DEFAULT_QUEUE_CONCURRENCY);
  const [savingConcurrency, setSavingConcurrency] = useState(false);
  const savingConcurrencyRef = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const current = ++revision.current;
    const response = await fetch("/api/translation-queue", { cache: "no-store", signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || messages.queueReadFailed);
    if (signal?.aborted || current !== revision.current) return;
    setJobs(result.jobs);
    if (!savingConcurrencyRef.current) setConcurrency(result.settings.concurrency);
    setError("");
    setLoading(false);
  }, [messages.queueReadFailed]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(controller.signal); }
      catch (error) {
        if (!controller.signal.aborted) {
          setError(error instanceof Error ? error.message : messages.queueReadFailed);
          setLoading(false);
        }
      } finally { if (!controller.signal.aborted) timer = setTimeout(poll, 2000); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh, messages.queueReadFailed]);
  const configureConcurrency = async (value: number) => {
    if (savingConcurrencyRef.current) return;
    savingConcurrencyRef.current = true;
    setSavingConcurrency(true);
    ++revision.current;
    try {
      const response = await fetch("/api/translation-queue", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "configure", concurrency: value }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || messages.queueReadFailed);
      setConcurrency(result.settings.concurrency);
    } catch (error) {
      setNotice({ bookName: messages.queueConcurrency, error: error instanceof Error ? error.message : messages.queueReadFailed });
    } finally {
      ++revision.current;
      savingConcurrencyRef.current = false;
      setSavingConcurrency(false);
    }
  };
  const act = async (job: BookTranslationJob, stop: boolean) => {
    const id = `${job.documentId}::${job.targetLanguage}`;
    if (pending.has(id)) return;
    setPending((value) => new Set(value).add(id));
    setNotice(null);
    ++revision.current;
    try {
      const response = await fetch("/api/translation-queue", {
        method: stop ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId: job.bookId, targetLanguage: job.targetLanguage,
          ...(stop ? { action: "stop" } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || messages.queueFailed);
      await refresh();
    } catch (error) {
      setNotice({ bookName: job.bookName, error: error instanceof Error ? error.message : messages.queueFailed });
    } finally {
      setPending((value) => { const next = new Set(value); next.delete(id); return next; });
    }
  };
  return <main className="app-shell settings-shell">
    <header className="topbar library-topbar">
      <Link className="brand" href="/"><Brand /></Link>
      <Link className="secondary-button" href="/"><ArrowLeft size={16} />{messages.queueBack}</Link>
    </header>
    <section className="settings-page queue-page" aria-labelledby="queue-title">
      <div className="settings-heading">
        <h1 id="queue-title"><ListOrdered size={28} />{messages.queueTitle}</h1>
        <p>{messages.queueDescription}</p>
        <p>{messages.queueRetryHelp}</p>
      </div>
      <div className="settings-card queue-concurrency">
        <div><label htmlFor="queue-concurrency">{messages.queueConcurrency}</label>
          <p id="queue-concurrency-help">{messages.queueConcurrencyHelp}</p></div>
        <select id="queue-concurrency" aria-describedby="queue-concurrency-help" value={concurrency}
          disabled={loading || savingConcurrency} onChange={(event) => void configureConcurrency(Number(event.target.value))}>
          {QUEUE_CONCURRENCY_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        {savingConcurrency && <small role="status">{messages.queueConcurrencySaving}</small>}
      </div>
      {notice && <div className="queue-notice" role="alert">
        <div><strong>{notice.bookName}</strong><p className="queue-error">{notice.error}</p></div>
        <button className="icon-button" aria-label={messages.queueDismiss} onClick={() => setNotice(null)}><X size={16} /></button>
      </div>}
      {error && <p className="queue-error queue-notice" role="alert">{error}</p>}
      {loading ? <p className="queue-empty" role="status"><LoaderCircle size={18} className="spin" />{messages.queueLoading}</p>
        : !jobs.length && !error ? <p className="queue-empty">{messages.queueEmpty}</p> : null}
      <div className="settings-sections">{jobs.map((job) => {
        const id = `${job.documentId}::${job.targetLanguage}`;
        const active = isTranslationActive(job.status);
        return <article className="settings-card queue-card" key={id}>
          <div className="queue-card-heading">
            <div><h2>{job.bookName.replace(/\.pdf$/i, "")}</h2><p>{targetLanguageLabel(job.targetLanguage, locale)}</p></div>
            <span className={`queue-status queue-status-${job.status}`}>{messages.queueStatuses[job.status]}</span>
          </div>
          <div className="queue-progress-copy"><span>{job.completedPages} / {job.totalPages}</span>
            {job.status !== "completed" && <span>{messages.queueCurrentPage(Math.min(job.nextPage, job.totalPages))}</span>}</div>
          <progress value={job.completedPages} max={job.totalPages} aria-label={messages.queueProgress(job.completedPages, job.totalPages)} />
          <div className="queue-card-actions"><small>{messages.queueFailedPages(job.failedPages, job.failedPageLimit)} · {messages.queueActivePages(job.activePages)}</small>
            {(active || job.status === "failed" || job.status === "stopped" || job.status === "partial") && <button className="secondary-button" disabled={pending.has(id)} onClick={() => void act(job, active)}>
              {pending.has(id) ? <LoaderCircle size={15} className="spin" /> : active ? <Square size={15} /> : <RotateCcw size={15} />}
              {active ? messages.queueStop : job.status === "stopped" ? messages.queueResume : messages.retryBookAction}
            </button>}
          </div>
          {job.pageErrors.length > 0 && <ul className="queue-page-errors">{job.pageErrors.map((page) => <li key={page.page}>
            <strong>{messages.queuePageRetries(page.page, page.retryCount, job.maxRetriesPerPage)}{page.status === "failed" ? ` · ${messages.queuePageExhausted}` : ""}</strong>
            <p className="queue-error">{page.error}</p>
          </li>)}</ul>}
        </article>;
      })}</div>
    </section>
  </main>;
}
