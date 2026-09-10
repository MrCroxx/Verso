"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { TranslationTrace } from "../../lib/translation-trace";
import { useUiLocale } from "../ui-locale";

const seconds = (ms: number) => ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(2)} s`;
const labels: Record<string, string> = {
  "storage.prepare": "准备存储", "cache.lookup": "查询译文缓存", "cache.recheck": "复查译文缓存", "cache.previous": "读取上一页",
  "queue.wait": "排队", "queue.shared_wait": "等待已有翻译任务", "settings.load": "读取配置", "images.prepare": "准备页面图片",
  "images.page": "读取或渲染图片", "request.encode": "编码模型请求", "provider.wait_headers": "等待模型响应头", "provider.read_body": "接收模型响应",
  "provider.first_event": "请求至首个流事件", "provider.first_text": "请求至首段正文", "provider.stream": "接收模型输出流",
  "response.normalize": "解析翻译结果", "alignment.current": "当前页原文对齐", "alignment.previous": "上一页原文对齐",
  "source.cache": "读取原文位置缓存", "source.queue": "原文提取排队", "source.shared_wait": "等待已有原文提取",
  "source.pdf_text": "提取 PDF 文本", "source.ocr": "本地 OCR", "storage.persist": "保存译文和索引", "source.prepare": "准备原文位置",
};

export default function TracesPage() {
  const { locale } = useUiLocale();
  const zh = locale === "zh-CN";
  const [traces, setTraces] = useState<TranslationTrace[]>([]);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch("/api/traces", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error();
        const result = await response.json();
        setTraces(result.traces); setError(false);
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { if (!controller.signal.aborted) timer = setTimeout(refresh, 2000); }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  const trace = traces.find((item) => item.id === selected) ?? traces[0];
  return <main className="app-shell settings-shell">
    <header className="topbar library-topbar"><Link href="/" className="brand">Verso</Link><Link href="/settings" className="secondary-button">{zh ? "返回设置" : "Back to settings"}</Link></header>
    <div className="settings-page trace-page">
      <h1>{zh ? "翻译耗时" : "Translation traces"}</h1>
      <p>{zh ? "每 2 秒刷新；最近 200 条记录保存在本地。点击一页查看各阶段耗时。" : "Refreshes every 2 seconds. The latest 200 completed traces are stored locally. Select a page to inspect its stages."}</p>
      <p>{zh ? "流式请求分别记录响应头、首个事件、首段正文和完整输出。等待响应头不等于首段正文延迟；并行阶段不可直接相加。旧记录可能为非流式请求。" : "Streaming traces separate headers, first event, first text, and full output. Header latency is not time to first text. Overlapping stages must not be added together. Older traces may be non-streaming."}</p>
      <a className="secondary-button" href="/api/traces?format=chrome">{zh ? "导出全部 Chrome / Perfetto trace" : "Export all Chrome / Perfetto traces"}</a>
      {error && <p role="alert">{zh ? "无法刷新记录，将自动重试。" : "Unable to refresh traces. Retrying automatically."}</p>}
      {!trace ? <p>{zh ? "还没有记录；开始翻译后会自动显示。" : "No traces yet. Start a translation to see its timings."}</p> : <div className="trace-grid">
        <nav className="trace-list" aria-label={zh ? "翻译记录" : "Translation records"}>{traces.map((item) => <button key={item.id} aria-pressed={item.id === trace.id} onClick={() => setSelected(item.id)}>
          <strong>{zh ? "第 " : "Page "}{item.page}{zh ? " 页" : ""} · {seconds(item.durationMs)}</strong>
          <span>{new Date(item.startedAt).toLocaleTimeString(locale)} · {item.background ? (zh ? "后台" : "Background") : (zh ? "阅读" : "Reader")} · {zh ? ({ running: "进行中", ok: "完成", error: "失败" }[item.status]) : item.status}</span>
        </button>)}</nav>
        <section className="settings-card trace-detail">
          <h2>{zh ? "第 " : "Page "}{trace.page}{zh ? " 页" : ""} · {seconds(trace.durationMs)}</h2>
          <p className="trace-id">{trace.bookId} · {trace.id}</p>
          <a href={`/api/traces?format=chrome&id=${trace.id}`}>{zh ? "导出此页" : "Export this page"}</a>
          <dl className="trace-attributes">{Object.entries(trace.attributes).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>
          <div className="trace-axis"><span>0 s</span><span>{seconds(trace.durationMs)}</span></div>
          {trace.spans.map((span,index) => <div key={index} className="trace-span">
            <div><span>{zh ? labels[span.name] ?? span.name : span.name}{span.attributes.page ? ` · ${span.attributes.page}` : ""}</span><strong>{seconds(span.durationMs ?? trace.durationMs - span.startMs)}{span.status === "running" ? " …" : span.status === "error" ? " !" : ""}</strong></div>
            <div className="trace-track" title={JSON.stringify(span.attributes)}><i className={span.status === "error" ? "trace-failed" : span.name.startsWith("provider") ? "trace-provider" : ""} style={{ left: `${100 * span.startMs / Math.max(1,trace.durationMs)}%`, width: `${Math.max(.3,100 * (span.durationMs ?? trace.durationMs-span.startMs) / Math.max(1,trace.durationMs))}%` }} /></div>
          </div>)}
        </section>
      </div>}
    </div>
  </main>;
}
