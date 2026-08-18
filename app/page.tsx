"use client";
/* eslint-disable @next/next/no-img-element */

import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Cloud,
  CloudUpload,
  FileText,
  Globe2,
  Languages,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  Moon,
  PanelLeftClose,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Sun,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createConcurrencyLimiter } from "../lib/concurrency-limiter";
import { deduplicatePageBoundary, normalizeTranslationPayload } from "../lib/translation-layout";

type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;
type PdfWorker = import("pdfjs-dist").PDFWorker;

let pdfJsPromise: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;
let pdfWorkerPromise: Promise<PdfWorker> | undefined;

function loadPdfJs() {
  pdfJsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
    return pdfjs;
  });
  return pdfJsPromise;
}

async function loadPdfRuntime() {
  const pdfjs = await loadPdfJs();
  if (!pdfWorkerPromise) {
    const worker = new pdfjs.PDFWorker({ name: "verso-reader" });
    pdfWorkerPromise = worker.promise.then(() => worker).catch((error) => {
      worker.destroy();
      pdfWorkerPromise = undefined;
      throw error;
    });
  }
  return { pdfjs, worker: await pdfWorkerPromise };
}

type ProviderSettings = {
  provider: "openai" | "compatible";
  endpoint: string;
  apiKey: string;
  model: string;
  reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  targetLanguage: string;
  nearbyPages: number;
  translationConcurrency: number;
};

type CloudBook = {
  id: string;
  fingerprint: string;
  name: string;
  size: number;
  pageCount: number;
  contentType: string;
  uploadedAt: number;
};

type TranslationBlock = {
  kind: "heading" | "paragraph" | "list_item" | "caption" | "spacer" | "page_number";
  text: string;
  marker: string;
  trailing: string;
  align: "left" | "center" | "right" | "justify";
  indent: number;
  spaceBefore: "none" | "xs" | "sm" | "md" | "lg" | "xl";
  size: "xs" | "sm" | "md" | "lg" | "xl";
};

type Translation = {
  page: number;
  markdown: string;
  blocks?: TranslationBlock[];
  isBlank?: boolean;
  boundaryDeduplicated?: boolean;
  sourceSummary?: string;
  revised?: boolean;
  cacheVersion?: number;
  cachedAt: number;
};

type TranslationResponse = {
  page: number;
  blocks: TranslationBlock[];
  isBlank: boolean;
  sourceSummary?: string;
  previousPageRevision?: { page: number; blocks: TranslationBlock[] } | null;
};

const UI_MESSAGES = {
  "zh-CN": {
    blankPage: "此页没有可翻译文本",
    blankCached: "空白页已缓存到云端",
    boundaryFixed: "跨页重复已校正 · 已同步云端",
    revised: "已结合下一页修订 · 已同步云端",
    cachedLayout: "译文已缓存到云端 · 保留原页布局",
    cached: "译文已缓存到云端",
    sourcePage: (page: number) => `原文 · ${page}`,
    translatedPage: (page: number) => `译文 · ${page}`,
    scannedSourceAlt: (page: number) => `扫描原文第 ${page} 页`,
    sampleScanAlt: (page: number) => `示例扫描页第 ${page} 页`,
    pageDivider: (page: number) => `第 ${page} 页`,
    scanFailed: "扫描页渲染失败",
    retryRender: "重试渲染",
    renderingScan: "正在渲染扫描页",
    retranslate: "重新翻译本页",
    readingContext: (page: number) => `正在读取第 ${page} 页及相邻上下文`,
    retry: "重试",
    onDemand: "滚动到此页时按需生成译文",
    settingsDialog: "AI 翻译设置",
    aiSettings: "AI 设置",
    configureVision: "配置视觉翻译模型",
    closeSettings: "关闭设置",
    apiKeyHelp: "仅保存在当前浏览器，本应用不会写入服务端。",
    provider: "服务商",
    apiEndpoint: "API 地址",
    apiKey: "API 密钥",
    model: "模型",
    reasoning: "推理强度",
    targetLanguage: "目标语言",
    prefetchRange: (pages: number) => `预取范围 · 前后 ${pages} 页`,
    parallelTranslation: (pages: number) => `并行翻译 · 同时 ${pages} 页`,
    concurrencyHelp: "默认 4；如果 Provider 返回限流错误，可以适当调低。",
    crossPageEnabled: "跨页上下文已启用",
    crossPageHelp: "每次最多向模型发送连续 3 页；后页可修订上一页未闭合的段落。",
    saveSettings: "保存设置",
    libraryDialog: "云端书库",
    cloudLibrary: "云端书库",
    librarySubtitle: "选择已上传的扫描书，无需重复上传",
    closeLibrary: "关闭书库",
    uploadPdf: "上传新 PDF",
    uploadHelp: "自动按文件指纹去重并保存到云端",
    uploaded: "已上传",
    bookCount: (count: number) => `${count} 本`,
    loadingLibrary: "正在读取书库",
    bookMeta: (pages: number, size: string, date: string) => `${pages} 页 · ${size} · ${date}`,
    noBooks: "还没有云端书籍",
    noBooksHelp: "上传 PDF 后会自动出现在这里。",
    openLibrary: "打开云端书库",
    cloudProgress: (progress: number) => `云端缓存 ${progress}%`,
    cloudCached: "云端已缓存",
    openPdf: "打开 PDF",
    toggleSidebar: "切换侧栏",
    pages: "页码",
    searchPages: "搜索页码",
    scannedEdition: (pages: number) => `${pages} 页 · 扫描版`,
    readingProgress: "阅读进度",
    page: (page: number) => `第 ${page} 页`,
    previousPage: "上一页",
    nextPage: "下一页",
    sourceScan: "原文扫描",
    moreOptions: "更多选项",
    closeError: "关闭错误提示",
    pdfReady: "PDF 已加载。填写 API key 后才会开始生成译文。",
    openAiSettings: "打开 AI 设置",
    cloudIndex: (pages: number) => `已载入云端页码索引 · ${pages} 页`,
    readingIndex: "正在读取 PDF 页码索引",
    connectingRenderer: (name: string) => `已切换到《${name}》，正在连接页面渲染器`,
    rendererFailed: "页面渲染器连接失败",
    rendererFailedHelp: "请从云端书库重新选择，或重新打开本地 PDF。",
    contextWindow: "上下文窗口",
    pageRange: (start: number, end: number) => `第 ${start}–${end} 页`,
    switchLanguage: "Switch interface to English",
    switchTheme: "切换明暗模式",
    libraryReadFailed: "无法读取云端书库",
    preparingCloud: "正在准备云端缓存",
    cloudBookReused: "云端已有此书，已直接复用",
    uploadSessionMissing: "云端未返回上传会话",
    partFailed: (part: number) => `分片 ${part} 上传失败`,
    cachingParts: (completed: number, total: number) => `正在缓存到云端 · ${completed}/${total}`,
    uploadCompleteFailed: "无法完成云端缓存",
    cachedCloud: "已缓存到云端",
    uploadFailed: "云端缓存失败",
    apiKeyRequired: "请先在 AI 设置中填写 API key。",
    invalidTranslation: "模型返回了无效的译文结构。",
    translationFailed: "无法生成译文",
    cloudTranslationReadFailed: "无法读取云端译文缓存",
    cloudTranslationWriteFailed: "无法写入云端译文缓存",
    translationRequestFailed: "翻译请求失败",
    openPdfFailed: (detail: string) => `无法打开这个 PDF：${detail}`,
    openedFromCloud: "已从云端书库打开",
    openCloudFailed: (detail: string) => `无法打开云端 PDF：${detail}`,
  },
  "en-US": {
    blankPage: "No translatable text on this page",
    blankCached: "Blank page cached in the cloud",
    boundaryFixed: "Cross-page overlap fixed · Synced to cloud",
    revised: "Revised with the next page · Synced to cloud",
    cachedLayout: "Translation cached in the cloud · Source layout preserved",
    cached: "Translation cached in the cloud",
    sourcePage: (page: number) => `Source · ${page}`,
    translatedPage: (page: number) => `Translation · ${page}`,
    scannedSourceAlt: (page: number) => `Scanned source page ${page}`,
    sampleScanAlt: (page: number) => `Sample scanned page ${page}`,
    pageDivider: (page: number) => `Page ${page}`,
    scanFailed: "Failed to render scanned page",
    retryRender: "Retry rendering",
    renderingScan: "Rendering scanned page",
    retranslate: "Translate this page again",
    readingContext: (page: number) => `Reading page ${page} and adjacent context`,
    retry: "Retry",
    onDemand: "Translation is generated on demand as you scroll",
    settingsDialog: "AI translation settings",
    aiSettings: "AI Settings",
    configureVision: "Configure the vision translation model",
    closeSettings: "Close settings",
    apiKeyHelp: "Stored only in this browser and never written to the server.",
    provider: "Provider",
    apiEndpoint: "API endpoint",
    apiKey: "API key",
    model: "Model",
    reasoning: "Reasoning effort",
    targetLanguage: "Target language",
    prefetchRange: (pages: number) => `Prefetch range · ${pages} page${pages === 1 ? "" : "s"} before and after`,
    parallelTranslation: (pages: number) => `Parallel translation · ${pages} page${pages === 1 ? "" : "s"}`,
    concurrencyHelp: "Default: 4. Lower this if your provider returns rate-limit errors.",
    crossPageEnabled: "Cross-page context enabled",
    crossPageHelp: "Each request includes at most 3 consecutive pages; a later page may revise an unfinished paragraph.",
    saveSettings: "Save settings",
    libraryDialog: "Cloud library",
    cloudLibrary: "Cloud Library",
    librarySubtitle: "Open an uploaded scanned book without uploading it again",
    closeLibrary: "Close library",
    uploadPdf: "Upload a new PDF",
    uploadHelp: "Deduplicated by fingerprint and stored in the cloud",
    uploaded: "Uploaded",
    bookCount: (count: number) => `${count} book${count === 1 ? "" : "s"}`,
    loadingLibrary: "Loading library",
    bookMeta: (pages: number, size: string, date: string) => `${pages} pages · ${size} · ${date}`,
    noBooks: "No cloud books yet",
    noBooksHelp: "Uploaded PDFs will appear here.",
    openLibrary: "Open cloud library",
    cloudProgress: (progress: number) => `Cloud cache ${progress}%`,
    cloudCached: "Cached in cloud",
    openPdf: "Open PDF",
    toggleSidebar: "Toggle sidebar",
    pages: "Pages",
    searchPages: "Search pages",
    scannedEdition: (pages: number) => `${pages} pages · Scanned edition`,
    readingProgress: "Reading progress",
    page: (page: number) => `Page ${page}`,
    previousPage: "Previous page",
    nextPage: "Next page",
    sourceScan: "Source scan",
    moreOptions: "More options",
    closeError: "Dismiss error",
    pdfReady: "PDF loaded. Add an API key to start generating translations.",
    openAiSettings: "Open AI settings",
    cloudIndex: (pages: number) => `Cloud page index loaded · ${pages} pages`,
    readingIndex: "Reading PDF page index",
    connectingRenderer: (name: string) => `Switched to “${name}”; connecting the page renderer`,
    rendererFailed: "Page renderer connection failed",
    rendererFailedHelp: "Select the book again from the cloud library or reopen the local PDF.",
    contextWindow: "Context window",
    pageRange: (start: number, end: number) => `Pages ${start}–${end}`,
    switchLanguage: "切换界面为简体中文",
    switchTheme: "Toggle light or dark mode",
    libraryReadFailed: "Unable to read the cloud library",
    preparingCloud: "Preparing cloud cache",
    cloudBookReused: "This book is already in the cloud and will be reused",
    uploadSessionMissing: "The cloud did not return an upload session",
    partFailed: (part: number) => `Failed to upload part ${part}`,
    cachingParts: (completed: number, total: number) => `Caching in cloud · ${completed}/${total}`,
    uploadCompleteFailed: "Unable to complete cloud caching",
    cachedCloud: "Cached in cloud",
    uploadFailed: "Cloud caching failed",
    apiKeyRequired: "Add an API key in AI Settings first.",
    invalidTranslation: "The model returned an invalid translation structure.",
    translationFailed: "Unable to generate translation",
    cloudTranslationReadFailed: "Unable to read the cloud translation cache",
    cloudTranslationWriteFailed: "Unable to write the cloud translation cache",
    translationRequestFailed: "Translation request failed",
    openPdfFailed: (detail: string) => `Unable to open this PDF: ${detail}`,
    openedFromCloud: "Opened from cloud library",
    openCloudFailed: (detail: string) => `Unable to open cloud PDF: ${detail}`,
  },
} as const;

type UiLocale = keyof typeof UI_MESSAGES;
type UiMessages = (typeof UI_MESSAGES)[UiLocale];
type ThemeMode = "light" | "dark";

function targetLanguageLabel(value: string, locale: UiLocale) {
  const labels: Record<UiLocale, Record<string, string>> = {
    "zh-CN": {
      "Simplified Chinese": "简体中文",
      "Traditional Chinese": "繁體中文",
      English: "English",
      Japanese: "日本語",
      Spanish: "Español",
    },
    "en-US": {
      "Simplified Chinese": "Simplified Chinese",
      "Traditional Chinese": "Traditional Chinese",
      English: "English",
      Japanese: "Japanese",
      Spanish: "Spanish",
    },
  };
  return labels[locale][value] || value;
}

const DEFAULT_SETTINGS: ProviderSettings = {
  provider: "openai",
  endpoint: "https://api.openai.com/v1/responses",
  apiKey: "",
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  targetLanguage: "Simplified Chinese",
  nearbyPages: 2,
  translationConcurrency: 4,
};

const translationLimiter = createConcurrencyLimiter();
let latestTranslationVersion = Date.now() * 1000;

function nextTranslationVersion() {
  latestTranslationVersion = Math.max(latestTranslationVersion + 1, Date.now() * 1000);
  return latestTranslationVersion;
}

const DEMO_TRANSLATIONS: Record<number, Translation> = {
  1: {
    page: 1,
    markdown:
      "我们把阅读想象成一种专注的形式：不是从页面上提取信息，而是让另一种思想的节奏逐渐改变自己的思考。一本书需要的不是速度，而是耐心。",
    sourceSummary: "Reading as a patient form of attention.",
    cachedAt: Date.now(),
  },
  2: {
    page: 2,
    markdown:
      "翻译尤其如此。句子的意义很少恰好止于纸张的边缘；它会越过装订线，在下一页找到结尾。因此，好的译文必须保留足够的上下文，同时克制地控制回看的范围。",
    sourceSummary: "Translation must preserve bounded cross-page context.",
    cachedAt: Date.now(),
  },
};

const SAMPLE_PAGES = [
  {
    kicker: "A NOTE ON READING",
    title: "The patient reader",
    body: [
      "We imagine reading as a form of attention—not the extraction of information from a page, but the gradual alteration of one mind by the rhythm of another.",
      "A book asks for something increasingly rare: time without interruption, and the patience to let an argument arrive at its own destination.",
    ],
    page: 1,
  },
  {
    kicker: "ON TRANSLATION",
    title: "Across the binding",
    body: [
      "Translation is especially dependent on this patience. The meaning of a sentence rarely agrees to stop at the physical edge of the paper.",
      "It crosses the binding and finds its conclusion on the following page. A faithful translation must therefore remember, but only within useful bounds.",
    ],
    page: 2,
  },
];

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function cacheKey(documentId: string, page: number, settings: ProviderSettings) {
  return ["layout-v3", documentId, page, settings.provider, settings.endpoint, settings.model, settings.reasoningEffort, settings.targetLanguage].join("::");
}

async function readCloudCache(key: string, fallbackMessage: string): Promise<Translation | undefined> {
  const response = await fetch(`/api/translations?key=${encodeURIComponent(key)}`, { cache: "no-store" });
  const result = await response.json() as { translation?: Translation | null; error?: string };
  if (!response.ok) throw new Error(result.error || fallbackMessage);
  return result.translation ? normalizeTranslationPayload(result.translation) as Translation : undefined;
}

async function writeCloudCache(key: string, documentId: string, page: number, translation: Translation, fallbackMessage: string) {
  const response = await fetch("/api/translations", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, documentId, page, translation }),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error || fallbackMessage);
}

function translationMarkdown(blocks: TranslationBlock[]) {
  return blocks.filter((block) => block.text).map((block) => block.text).join("\n\n");
}

function boundaryTail(translation?: Translation) {
  return translation?.blocks
    ?.findLast((block) => (block.kind === "paragraph" || block.kind === "caption") && block.text.trim())
    ?.text.trimEnd()
    .slice(-160) || "";
}

function reconcilePageBoundary(previous: Translation | undefined, current: Translation) {
  if (!previous?.blocks?.length || !current.blocks?.length) return current;
  const result = deduplicatePageBoundary(previous.blocks, current.blocks);
  if (!result.removedText) return current;
  return {
    ...current,
    blocks: result.blocks,
    markdown: translationMarkdown(result.blocks),
    isBlank: !result.blocks.some((block) => block.kind !== "spacer" && block.text.trim()),
    boundaryDeduplicated: true,
  };
}

async function fingerprint(file: File) {
  const windowSize = 64 * 1024;
  const first = await file.slice(0, windowSize).arrayBuffer();
  const last = await file.slice(Math.max(0, file.size - windowSize)).arrayBuffer();
  const metadata = new TextEncoder().encode(String(file.size));
  const input = new Uint8Array(metadata.length + first.byteLength + last.byteLength);
  input.set(metadata);
  input.set(new Uint8Array(first), metadata.length);
  input.set(new Uint8Array(last), metadata.length + first.byteLength);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // Web Crypto is unavailable on plain HTTP LAN origins. A sampled FNV-1a
  // fingerprint is sufficient for namespacing a device-local translation cache.
  let hash = 0xcbf29ce484222325n;
  for (const byte of input) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a-${hash.toString(16).padStart(16, "0")}`;
}

function useNearViewport(rootMargin = "1400px 0px") {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin });
    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin]);

  return { ref, near };
}

function SampleScan({ page, messages }: { page: number; messages: UiMessages }) {
  const sample = SAMPLE_PAGES[(page - 1) % SAMPLE_PAGES.length];
  return (
    <div className="sample-scan" aria-label={messages.sampleScanAlt(page)}>
      <div className="scan-noise" />
      <p className="sample-kicker">{sample.kicker}</p>
      <h2>{sample.title}</h2>
      <div className="sample-rule" />
      {sample.body.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      <p className="sample-page-number">{page}</p>
    </div>
  );
}

function TranslationText({ value, messages }: { value: Translation; messages: UiMessages }) {
  if (value.isBlank) {
    return (
      <article className="translation-copy blank-translation">
        <div className="blank-translation-state">
          <CircleCheck size={18} />
          <p>{messages.blankPage}</p>
        </div>
        <div className="translation-meta">
          <CircleCheck size={14} />
          {messages.blankCached}
        </div>
      </article>
    );
  }
  if (value.blocks?.length) {
    return (
      <article className="translation-copy structured-translation">
        <div className="layout-blocks">
          {value.blocks.map((block, index) => {
            const className = cn(
              "layout-block",
              `block-${block.kind}`,
              `align-${block.align}`,
              `indent-${Math.min(3, Math.max(0, block.indent))}`,
              `before-${block.spaceBefore}`,
              `size-${block.size}`,
            );
            if (block.kind === "spacer") {
              return <div key={index} className={className} aria-hidden="true" />;
            }
            if (block.kind === "heading") {
              return <h2 key={index} className={className}>{block.text}</h2>;
            }
            if (block.kind === "list_item") {
              return (
                <div key={index} className={className}>
                  <span className="block-marker">{block.marker}</span>
                  <span className="block-text">{block.text}</span>
                  <span className="block-trailing">{block.trailing}</span>
                </div>
              );
            }
            return <p key={index} className={className}>{block.text}</p>;
          })}
        </div>
        <div className="translation-meta">
          <CircleCheck size={14} />
          {value.boundaryDeduplicated
            ? messages.boundaryFixed
            : value.revised ? messages.revised : messages.cachedLayout}
        </div>
      </article>
    );
  }
  return (
    <article className="translation-copy">
      {value.markdown.split(/\n{2,}/).map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      <div className="translation-meta">
        <CircleCheck size={14} />
        {value.revised ? messages.revised : messages.cached}
      </div>
    </article>
  );
}

type PageSpreadProps = {
  page: number;
  totalPages: number;
  nearbyPages: number;
  isDemo: boolean;
  translation?: Translation;
  loading: boolean;
  error?: string;
  renderPage: (page: number) => Promise<string>;
  requestTranslation: (page: number, force?: boolean) => void;
  setCurrentPage: (page: number) => void;
  messages: UiMessages;
};

function PageSpread({
  page,
  totalPages,
  nearbyPages,
  isDemo,
  translation,
  loading,
  error,
  renderPage,
  requestTranslation,
  setCurrentPage,
  messages,
}: PageSpreadProps) {
  const { ref, near } = useNearViewport(`${Math.max(1, nearbyPages) * 720}px 0px`);
  const [image, setImage] = useState<string>();
  const [renderError, setRenderError] = useState("");

  useEffect(() => {
    if (!near) return;
    requestTranslation(page);
    if (isDemo) return;
    let active = true;
    renderPage(page)
      .then((result) => active && setImage(result))
      .catch((error) => {
        if (!active) return;
        setRenderError(error instanceof Error ? error.message : "Unknown page rendering error");
      });
    return () => {
      active = false;
      window.setTimeout(() => setImage(undefined), 500);
    };
  }, [isDemo, near, page, renderPage, requestTranslation]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => entry.isIntersecting && setCurrentPage(page),
      { rootMargin: "-18% 0px -62% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [page, ref, setCurrentPage]);

  return (
    <section className="page-spread" ref={ref} data-page={page}>
      <div className="source-page page-surface">
        <div className="page-label">{messages.sourcePage(page)}</div>
        {isDemo ? (
          <SampleScan page={page} messages={messages} />
        ) : image ? (
          <img src={image} alt={messages.scannedSourceAlt(page)} />
        ) : renderError ? (
          <div className="page-render-error">
            <strong>{messages.scanFailed}</strong>
            <p>{renderError}</p>
            <button className="secondary-button" onClick={() => {
              setRenderError("");
              renderPage(page).then(setImage).catch((renderingError) => {
                setRenderError(renderingError instanceof Error ? renderingError.message : "Unknown page rendering error");
              });
            }}>{messages.retryRender}</button>
          </div>
        ) : (
          <div className="page-loading"><LoaderCircle className="spin" size={24} /> {messages.renderingScan}</div>
        )}
      </div>
      <div className="translated-page page-surface">
        <div className="translation-heading">
          <div className="page-label">{messages.translatedPage(page)}</div>
          {translation && (
            <button className="icon-button subtle" aria-label={messages.retranslate} onClick={() => requestTranslation(page, true)}>
              <RefreshCw size={15} />
            </button>
          )}
        </div>
        {translation ? (
          <TranslationText value={translation} messages={messages} />
        ) : loading ? (
          <div className="translation-skeleton">
            <div className="ai-working"><Sparkles size={15} /> {messages.readingContext(page)}</div>
            <i /><i /><i /><i className="short" />
          </div>
        ) : error ? (
          <div className="translation-error">
            <p>{error}</p>
            <button className="secondary-button" onClick={() => requestTranslation(page, true)}>{messages.retry}</button>
          </div>
        ) : (
          <div className="empty-translation">
            <Languages size={26} />
            <p>{messages.onDemand}</p>
          </div>
        )}
      </div>
      {page < totalPages && <div className="spread-divider"><span>{messages.pageDivider(page + 1)}</span></div>}
    </section>
  );
}

function SettingsPanel({
  settings,
  locale,
  messages,
  onChange,
  onClose,
}: {
  settings: ProviderSettings;
  locale: UiLocale;
  messages: UiMessages;
  onChange: (next: ProviderSettings) => void;
  onClose: () => void;
}) {
  function update<K extends keyof ProviderSettings>(key: K, value: ProviderSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="settings-panel" role="dialog" aria-modal="true" aria-label={messages.settingsDialog} onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-title">
          <div><span>{messages.aiSettings}</span><p>{messages.configureVision}</p></div>
          <button className="icon-button" onClick={onClose} aria-label={messages.closeSettings}><X size={18} /></button>
        </div>

        <label className="field-label">{messages.provider}</label>
        <div className="segmented">
          <button className={cn(settings.provider === "openai" && "active")} onClick={() => update("provider", "openai")}>OpenAI</button>
          <button className={cn(settings.provider === "compatible" && "active")} onClick={() => update("provider", "compatible")}>OpenAI-compatible</button>
        </div>

        <label className="field-label" htmlFor="endpoint">{messages.apiEndpoint}</label>
        <input id="endpoint" value={settings.endpoint} onChange={(event) => update("endpoint", event.target.value)} />

        <label className="field-label" htmlFor="api-key">{messages.apiKey}</label>
        <input id="api-key" type="password" placeholder="sk-…" value={settings.apiKey} onChange={(event) => update("apiKey", event.target.value)} />
        <p className="field-help">{messages.apiKeyHelp}</p>

        <div className="field-grid">
          <div>
            <label className="field-label" htmlFor="model">{messages.model}</label>
            <input id="model" value={settings.model} onChange={(event) => update("model", event.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="reasoning">{messages.reasoning}</label>
            <select id="reasoning" value={settings.reasoningEffort} onChange={(event) => update("reasoningEffort", event.target.value as ProviderSettings["reasoningEffort"])}>
              <option value="none">None</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">XHigh</option>
              <option value="max">Max</option>
            </select>
          </div>
        </div>

        <label className="field-label" htmlFor="language">{messages.targetLanguage}</label>
        <select id="language" value={settings.targetLanguage} onChange={(event) => update("targetLanguage", event.target.value)}>
          {Object.keys({
            "Simplified Chinese": true,
            "Traditional Chinese": true,
            English: true,
            Japanese: true,
            Spanish: true,
          }).map((language) => <option key={language} value={language}>{targetLanguageLabel(language, locale)}</option>)}
        </select>

        <label className="field-label" htmlFor="nearby">{messages.prefetchRange(settings.nearbyPages)}</label>
        <input id="nearby" className="range" type="range" min="1" max="4" value={settings.nearbyPages} onChange={(event) => update("nearbyPages", Number(event.target.value))} />

        <label className="field-label" htmlFor="concurrency">{messages.parallelTranslation(settings.translationConcurrency)}</label>
        <input id="concurrency" className="range" type="range" min="1" max="6" value={settings.translationConcurrency} onChange={(event) => update("translationConcurrency", Number(event.target.value))} />
        <p className="field-help">{messages.concurrencyHelp}</p>

        <div className="context-note">
          <Sparkles size={16} />
          <div><strong>{messages.crossPageEnabled}</strong><p>{messages.crossPageHelp}</p></div>
        </div>
        <button className="primary-button full" onClick={onClose}>{messages.saveSettings}</button>
      </aside>
    </div>
  );
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function BookLibrary({
  books,
  locale,
  messages,
  currentDocumentId,
  loading,
  onSelect,
  onWarm,
  onUpload,
  onClose,
}: {
  books: CloudBook[];
  locale: UiLocale;
  messages: UiMessages;
  currentDocumentId: string;
  loading: boolean;
  onSelect: (book: CloudBook) => void;
  onWarm: (book: CloudBook) => void;
  onUpload: () => void;
  onClose: () => void;
}) {
  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="settings-panel library-panel" role="dialog" aria-modal="true" aria-label={messages.libraryDialog} onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-title">
          <div><span>{messages.cloudLibrary}</span><p>{messages.librarySubtitle}</p></div>
          <button className="icon-button" onClick={onClose} aria-label={messages.closeLibrary}><X size={18} /></button>
        </div>
        <button className="library-upload" onClick={onUpload}>
          <CloudUpload size={19} />
          <span><strong>{messages.uploadPdf}</strong><small>{messages.uploadHelp}</small></span>
        </button>
        <div className="library-section-title"><span>{messages.uploaded}</span><strong>{messages.bookCount(books.length)}</strong></div>
        {loading ? (
          <div className="library-empty"><LoaderCircle className="spin" size={22} /> {messages.loadingLibrary}</div>
        ) : books.length ? (
          <div className="book-list">
            {books.map((book) => (
              <button
                key={book.id}
                className={cn("cloud-book", currentDocumentId === book.fingerprint && "active")}
                onClick={() => onSelect(book)}
                onPointerEnter={() => onWarm(book)}
                onFocus={() => onWarm(book)}
              >
                <span className="cloud-book-cover"><BookOpen size={18} /></span>
                <span className="cloud-book-copy">
                  <strong>{book.name.replace(/\.pdf$/i, "")}</strong>
                  <small>{messages.bookMeta(book.pageCount, formatFileSize(book.size), new Date(book.uploadedAt).toLocaleDateString(locale))}</small>
                </span>
                {currentDocumentId === book.fingerprint ? <CircleCheck size={18} /> : <ChevronRight size={17} />}
              </button>
            ))}
          </div>
        ) : (
          <div className="library-empty"><Cloud size={25} /><strong>{messages.noBooks}</strong><p>{messages.noBooksHelp}</p></div>
        )}
      </aside>
    </div>
  );
}

export default function Home() {
  const fileInput = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<PdfDocument>();
  const imageCache = useRef(new Map<number, Promise<string>>());
  const inFlight = useRef(new Set<string>());
  const cloudBookWarmups = useRef(new Map<string, Promise<void>>());
  const documentLoadSequence = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [locale, setLocale] = useState<UiLocale>("zh-CN");
  const [theme, setTheme] = useState<ThemeMode>("light");
  const messages = UI_MESSAGES[locale];
  const [settings, setSettings] = useState<ProviderSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    const stored = localStorage.getItem("verso-settings");
    return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS;
  });
  const [documentId, setDocumentId] = useState("verso-demo");
  const [fileName, setFileName] = useState("The Shape of Attention.pdf");
  const [totalPages, setTotalPages] = useState(2);
  const [currentPage, setCurrentPage] = useState(1);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [documentReady, setDocumentReady] = useState(true);
  const [cloudIndexLoaded, setCloudIndexLoaded] = useState(false);
  const [documentError, setDocumentError] = useState("");
  const [isDemo, setIsDemo] = useState(true);
  const [translations, setTranslations] = useState<Record<number, Translation>>(DEMO_TRANSLATIONS);
  const [loadingPages, setLoadingPages] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [cloudBooks, setCloudBooks] = useState<CloudBook[]>([]);
  const [cloudBooksLoading, setCloudBooksLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [cloudMessage, setCloudMessage] = useState("");

  useEffect(() => {
    const detectPreferences = window.setTimeout(() => {
      setLocale(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US");
      setTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    }, 0);
    return () => window.clearTimeout(detectPreferences);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const warmCloudBook = useCallback((book: CloudBook) => {
    const existing = cloudBookWarmups.current.get(book.id);
    if (existing) return existing;

    const url = `/api/books/${encodeURIComponent(book.id)}/file`;
    const readByte = async (offset: number) => {
      const response = await fetch(url, {
        headers: { Range: `bytes=${offset}-${offset}` },
        cache: "no-store",
      });
      if (response.status !== 206) throw new Error(`Unable to warm PDF range: ${response.status}`);
      await response.arrayBuffer();
    };
    const warmup = Promise.all([
      readByte(0),
      readByte(Math.max(0, book.size - 1)),
    ]).then(() => undefined).catch((error) => {
      cloudBookWarmups.current.delete(book.id);
      throw error;
    });
    cloudBookWarmups.current.set(book.id, warmup);
    return warmup;
  }, []);

  const refreshBooks = useCallback(async () => {
    setCloudBooksLoading(true);
    try {
      const response = await fetch("/api/books", { cache: "no-store" });
      const result = await response.json() as { books?: CloudBook[]; error?: string };
      if (!response.ok) throw new Error(result.error || messages.libraryReadFailed);
      const books = result.books || [];
      setCloudBooks(books);
      if (books[0]) void warmCloudBook(books[0]).catch(() => undefined);
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : messages.libraryReadFailed);
    } finally {
      setCloudBooksLoading(false);
    }
  }, [messages, warmCloudBook]);

  useEffect(() => {
    void loadPdfRuntime().catch(() => undefined);
    const preload = window.setTimeout(() => void refreshBooks(), 0);
    return () => window.clearTimeout(preload);
  }, [refreshBooks]);

  useEffect(() => {
    localStorage.setItem("verso-settings", JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    indexedDB.deleteDatabase("verso-translation-cache");
  }, []);

  const openLibrary = useCallback(() => {
    setLibraryOpen(true);
    void refreshBooks();
  }, [refreshBooks]);

  const beginDocumentLoad = useCallback((id: string, name: string, pageCount: number, hasCloudIndex: boolean) => {
    const sequence = ++documentLoadSequence.current;
    const previousPdf = pdfRef.current;
    pdfRef.current = undefined;
    if (previousPdf) void previousPdf.destroy();
    imageCache.current.clear();
    setDocumentId(id);
    setFileName(name);
    setTotalPages(Math.max(1, pageCount));
    setCurrentPage(1);
    setTranslations({});
    setLoadingPages(new Set());
    setErrors({});
    setIsDemo(false);
    setCloudIndexLoaded(hasCloudIndex);
    setDocumentReady(false);
    setLoadingDocument(true);
    setDocumentError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
    return sequence;
  }, []);

  const finishDocumentLoad = useCallback((sequence: number, pdf: PdfDocument) => {
    if (sequence !== documentLoadSequence.current) {
      void pdf.destroy();
      return false;
    }
    pdfRef.current = pdf;
    setTotalPages(pdf.numPages);
    setDocumentReady(true);
    setLoadingDocument(false);
    return true;
  }, []);

  const uploadToCloud = useCallback(async (file: File, fileFingerprint: string, pageCount: number) => {
    setUploadProgress(0);
    setCloudMessage(messages.preparingCloud);
    try {
      const metadata = {
        fingerprint: fileFingerprint,
        name: file.name,
        size: file.size,
        pageCount,
        contentType: file.type || "application/pdf",
      };
      const initialize = await fetch("/api/books/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
      });
      const initialized = await initialize.json() as {
        exists?: boolean;
        uploadId?: string;
        objectKey?: string;
        error?: string;
      };
      if (!initialize.ok) throw new Error(initialized.error || messages.uploadFailed);
      if (initialized.exists) {
        setUploadProgress(100);
        setCloudMessage(messages.cloudBookReused);
        await refreshBooks();
        return;
      }
      if (!initialized.uploadId || !initialized.objectKey) throw new Error(messages.uploadSessionMissing);

      const partSize = 8 * 1024 * 1024;
      const partCount = Math.ceil(file.size / partSize);
      const parts = new Array<{ partNumber: number; etag: string }>(partCount);
      let nextPart = 1;
      let completedParts = 0;
      const uploadWorker = async () => {
        while (nextPart <= partCount) {
          const partNumber = nextPart++;
          const start = (partNumber - 1) * partSize;
          const body = file.slice(start, Math.min(file.size, start + partSize));
          const response = await fetch(`/api/books/uploads/${encodeURIComponent(initialized.uploadId!)}/parts/${partNumber}`, {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream", "x-object-key": initialized.objectKey! },
            body,
          });
          const result = await response.json() as { partNumber?: number; etag?: string; error?: string };
          if (!response.ok || !result.etag) throw new Error(result.error || messages.partFailed(partNumber));
          parts[partNumber - 1] = { partNumber, etag: result.etag };
          completedParts += 1;
          setUploadProgress(Math.round((completedParts / partCount) * 96));
          setCloudMessage(messages.cachingParts(completedParts, partCount));
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, partCount) }, () => uploadWorker()));

      const complete = await fetch(`/api/books/uploads/${encodeURIComponent(initialized.uploadId)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...metadata, objectKey: initialized.objectKey, parts }),
      });
      const completed = await complete.json() as { book?: CloudBook; error?: string };
      if (!complete.ok || !completed.book) throw new Error(completed.error || messages.uploadCompleteFailed);
      setUploadProgress(100);
      setCloudMessage(messages.cachedCloud);
      await refreshBooks();
    } catch (error) {
      setUploadProgress(null);
      setCloudMessage(error instanceof Error ? error.message : messages.uploadFailed);
    }
  }, [messages, refreshBooks]);

  const renderPage = useCallback(async (pageNumber: number) => {
    const cached = imageCache.current.get(pageNumber);
    if (cached) return cached;
    const task = (async () => {
      const pdf = pdfRef.current;
      if (!pdf) throw new Error("PDF is not ready");
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 1280 / base.width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas is unavailable");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      return canvas.toDataURL("image/jpeg", 0.82);
    })().catch((error) => {
      imageCache.current.delete(pageNumber);
      throw error;
    });
    imageCache.current.set(pageNumber, task);
    if (imageCache.current.size > 12) {
      const oldest = imageCache.current.keys().next().value as number | undefined;
      if (oldest !== undefined && oldest !== pageNumber) imageCache.current.delete(oldest);
    }
    return task;
  }, []);

  const requestTranslation = useCallback(async (page: number, force = false) => {
    if (isDemo) return;
    const flightKey = `${documentId}:${page}`;
    if (inFlight.current.has(flightKey)) return;
    const documentSequence = documentLoadSequence.current;
    const key = cacheKey(documentId, page, settings);
    const previousKey = page > 1 ? cacheKey(documentId, page - 1, settings) : "";
    const requestVersion = nextTranslationVersion();
    let previousTranslation: Translation | undefined;
    inFlight.current.add(flightKey);
    setLoadingPages((existing) => new Set(existing).add(page));
    setErrors((existing) => ({ ...existing, [page]: "" }));
    try {
      if (!force) {
        const cached = await readCloudCache(key, messages.cloudTranslationReadFailed);
        if (cached) {
          if (previousKey) previousTranslation = await readCloudCache(previousKey, messages.cloudTranslationReadFailed).catch(() => undefined);
          const reconciled = reconcilePageBoundary(previousTranslation, cached);
          if (documentSequence !== documentLoadSequence.current) return;
          setTranslations((existing) => ({ ...existing, [page]: reconciled }));
          if (reconciled !== cached) {
            void writeCloudCache(key, documentId, page, reconciled, messages.cloudTranslationWriteFailed).catch(() => undefined);
          }
          return;
        }
      }
      if (!settings.apiKey) throw new Error(messages.apiKeyRequired);
      if (previousKey) previousTranslation = await readCloudCache(previousKey, messages.cloudTranslationReadFailed).catch(() => undefined);

      const payload = await translationLimiter.run(settings.translationConcurrency, async () => {
        if (documentSequence !== documentLoadSequence.current) throw new Error("Translation request was superseded.");
        const contextPages = [page - 1, page, page + 1].filter((value) => value >= 1 && value <= totalPages);
        const images = await Promise.all(contextPages.map(async (number) => ({ page: number, dataUrl: await renderPage(number) })));
        const response = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            settings,
            page,
            totalPages,
            images,
            previousTranslationTail: boundaryTail(previousTranslation),
          }),
        });
        const result = await response.json() as TranslationResponse & { error?: string };
        if (!response.ok) throw new Error(result.error || messages.translationRequestFailed);
        if (!Array.isArray(result.blocks)) throw new Error(messages.invalidTranslation);
        return result;
      });
      const revision: Translation | undefined = payload.previousPageRevision?.page === page - 1
        && payload.previousPageRevision.blocks.length
        ? {
            page: page - 1,
            markdown: translationMarkdown(payload.previousPageRevision.blocks),
            blocks: payload.previousPageRevision.blocks,
            revised: true,
            cacheVersion: requestVersion,
            cachedAt: Date.now(),
          }
        : undefined;
      const translated = reconcilePageBoundary(revision || previousTranslation, {
        page,
        markdown: translationMarkdown(payload.blocks),
        blocks: payload.blocks,
        isBlank: payload.isBlank,
        sourceSummary: payload.sourceSummary,
        cacheVersion: requestVersion,
        cachedAt: Date.now(),
      });
      if (documentSequence !== documentLoadSequence.current) return;
      setTranslations((existing) => ({
        ...existing,
        ...(revision ? { [page - 1]: revision } : {}),
        [page]: translated,
      }));
      await Promise.all([
        writeCloudCache(key, documentId, page, translated, messages.cloudTranslationWriteFailed),
        ...(revision ? [writeCloudCache(previousKey, documentId, page - 1, revision, messages.cloudTranslationWriteFailed)] : []),
      ]);
    } catch (error) {
      if (documentSequence !== documentLoadSequence.current) return;
      const message = error instanceof Error ? error.message : messages.translationFailed;
      setErrors((existing) => ({ ...existing, [page]: message }));
    } finally {
      inFlight.current.delete(flightKey);
      if (documentSequence === documentLoadSequence.current) {
        setLoadingPages((existing) => {
          const next = new Set(existing);
          next.delete(page);
          return next;
        });
      }
    }
  }, [documentId, isDemo, messages, renderPage, settings, totalPages]);

  const handleFile = useCallback(async (file?: File) => {
    if (!file) return;
    const fileFingerprint = await fingerprint(file);
    const sequence = beginDocumentLoad(fileFingerprint, file.name, 1, false);
    try {
      const { pdfjs, worker } = await loadPdfRuntime();
      const data = new Uint8Array(await file.arrayBuffer());
      const pdf = await pdfjs.getDocument({
        data,
        worker,
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        wasmUrl: "/pdfjs/wasm/",
        iccUrl: "/pdfjs/iccs/",
      }).promise;
      if (finishDocumentLoad(sequence, pdf)) {
        void uploadToCloud(file, fileFingerprint, pdf.numPages);
      }
    } catch (error) {
      if (sequence !== documentLoadSequence.current) return;
      const detail = error instanceof Error ? error.message : "Unknown PDF error";
      setDocumentError(messages.openPdfFailed(detail));
      setLoadingDocument(false);
    }
  }, [beginDocumentLoad, finishDocumentLoad, messages, uploadToCloud]);

  const loadCloudBook = useCallback(async (book: CloudBook) => {
    setLibraryOpen(false);
    const sequence = beginDocumentLoad(book.fingerprint, book.name, book.pageCount, true);
    try {
      const [{ pdfjs, worker }] = await Promise.all([
        loadPdfRuntime(),
        warmCloudBook(book).catch(() => undefined),
      ]);
      const pdf = await pdfjs.getDocument({
        url: `/api/books/${encodeURIComponent(book.id)}/file`,
        worker,
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        wasmUrl: "/pdfjs/wasm/",
        iccUrl: "/pdfjs/iccs/",
        rangeChunkSize: 1024 * 1024,
        disableStream: true,
        disableAutoFetch: true,
      }).promise;
      if (finishDocumentLoad(sequence, pdf)) {
        setUploadProgress(100);
        setCloudMessage(messages.openedFromCloud);
      }
    } catch (error) {
      if (sequence !== documentLoadSequence.current) return;
      const detail = error instanceof Error ? error.message : "Unknown PDF error";
      setDocumentError(messages.openCloudFailed(detail));
      setLoadingDocument(false);
    }
  }, [beginDocumentLoad, finishDocumentLoad, messages, warmCloudBook]);

  const pageNumbers = useMemo(() => Array.from({ length: totalPages }, (_, index) => index + 1), [totalPages]);
  const displayedTranslations = useMemo(() => {
    const reconciled = { ...translations };
    for (const page of Object.keys(reconciled).map(Number).sort((left, right) => left - right)) {
      if (page > 1 && reconciled[page]) {
        reconciled[page] = reconcilePageBoundary(reconciled[page - 1], reconciled[page]);
      }
    }
    return reconciled;
  }, [translations]);
  const progress = Math.round((currentPage / totalPages) * 100);

  function goToPage(page: number) {
    const safePage = Math.min(totalPages, Math.max(1, page));
    document.querySelector(`[data-page="${safePage}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark">V</div><span>Verso</span><em>AI Reader</em></div>
        <button className="document-title" onClick={openLibrary} title={messages.openLibrary}><FileText size={16} /><span>{fileName}</span><ChevronDown size={14} /></button>
        <div className="top-actions">
          <div className="cache-status" title={cloudMessage}>
            {uploadProgress !== null && uploadProgress < 100 ? <LoaderCircle className="spin" size={14} /> : uploadProgress === 100 ? <Cloud size={14} /> : <span />}
            {uploadProgress !== null && uploadProgress < 100 ? messages.cloudProgress(uploadProgress) : uploadProgress === 100 ? messages.cloudCached : messages.cloudLibrary}
          </div>
          <button className="icon-button locale-button" title={messages.switchLanguage} aria-label={messages.switchLanguage} onClick={() => setLocale((value) => value === "zh-CN" ? "en-US" : "zh-CN")}><Globe2 size={16} /><span>{locale === "zh-CN" ? "EN" : "中"}</span></button>
          <button className="icon-button" title={messages.switchTheme} aria-label={messages.switchTheme} aria-pressed={theme === "dark"} onClick={() => setTheme((value) => value === "light" ? "dark" : "light")}>{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</button>
          <button className="secondary-button library-button" onClick={openLibrary}><BookOpen size={16} /> {messages.cloudLibrary}</button>
          <button className="secondary-button" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /> {messages.aiSettings}</button>
          <button className="primary-button" onClick={() => fileInput.current?.click()}><Upload size={16} /> {messages.openPdf}</button>
          <input ref={fileInput} type="file" accept="application/pdf" hidden onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            void handleFile(file);
          }} />
        </div>
      </header>

      <div className="workspace">
        <aside className={cn("sidebar", !sidebarOpen && "collapsed")}>
          <div className="sidebar-head">
            <button className="icon-button" aria-label={messages.toggleSidebar} onClick={() => setSidebarOpen((open) => !open)}>{sidebarOpen ? <PanelLeftClose size={18} /> : <Menu size={18} />}</button>
            {sidebarOpen && <><span>{messages.pages}</span><button className="icon-button" aria-label={messages.searchPages}><Search size={17} /></button></>}
          </div>
          {sidebarOpen && (
            <>
              <div className="book-card">
                <div className="mini-cover"><span>V</span></div>
                <div><strong>{fileName.replace(/\.pdf$/i, "")}</strong><p>{messages.scannedEdition(totalPages)}</p></div>
              </div>
              <div className="progress-block">
                <div><span>{messages.readingProgress}</span><strong>{progress}%</strong></div>
                <div className="progress-track"><i style={{ width: `${progress}%` }} /></div>
              </div>
              <nav className="page-nav" aria-label={messages.pages}>
                {pageNumbers.map((page) => (
                  <button key={page} className={cn(page === currentPage && "active")} onClick={() => goToPage(page)}>
                    <span className="page-thumbnail">{page <= 2 && isDemo ? <SampleScan page={page} messages={messages} /> : page}</span>
                    <span>{messages.page(page)}</span>
                    {translations[page] && <CircleCheck size={14} />}
                  </button>
                ))}
              </nav>
            </>
          )}
        </aside>

        <section className="reader">
          <div className="reader-toolbar">
            <div className="page-stepper">
              <button className="icon-button" onClick={() => goToPage(currentPage - 1)} aria-label={messages.previousPage}><ChevronLeft size={17} /></button>
              <span><strong>{currentPage}</strong> / {totalPages}</span>
              <button className="icon-button" onClick={() => goToPage(currentPage + 1)} aria-label={messages.nextPage}><ChevronRight size={17} /></button>
            </div>
            <div className="column-labels"><span>{messages.sourceScan}</span><i /><span><Languages size={15} /> {targetLanguageLabel(settings.targetLanguage, locale)}</span></div>
            <button className="icon-button" aria-label={messages.moreOptions}><MoreHorizontal size={19} /></button>
          </div>

          {documentError && (
            <div className="reader-notice error-notice">
              <span>{documentError}</span>
              <button className="icon-button" onClick={() => setDocumentError("")} aria-label={messages.closeError}><X size={16} /></button>
            </div>
          )}
          {!isDemo && !loadingDocument && !settings.apiKey && !documentError && (
            <div className="reader-notice setup-notice">
              <span><Sparkles size={15} /> {messages.pdfReady}</span>
              <button className="secondary-button" onClick={() => setSettingsOpen(true)}>{messages.openAiSettings}</button>
            </div>
          )}

          {loadingDocument ? (
            <div className="document-loading">
              <LoaderCircle className="spin" size={28} />
              <strong>{cloudIndexLoaded ? messages.cloudIndex(totalPages) : messages.readingIndex}</strong>
              <p>{messages.connectingRenderer(fileName.replace(/\.pdf$/i, ""))}</p>
            </div>
          ) : documentError && !documentReady ? (
            <div className="document-loading document-load-failed">
              <strong>{messages.rendererFailed}</strong>
              <p>{messages.rendererFailedHelp}</p>
            </div>
          ) : (
            <div className="spreads">
              {pageNumbers.map((page) => (
                <PageSpread
                  key={`${documentId}-${page}`}
                  page={page}
                  totalPages={totalPages}
                  nearbyPages={settings.nearbyPages}
                  isDemo={isDemo}
                  translation={displayedTranslations[page]}
                  loading={loadingPages.has(page)}
                  error={errors[page]}
                  renderPage={renderPage}
                  requestTranslation={requestTranslation}
                  setCurrentPage={setCurrentPage}
                  messages={messages}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="floating-status"><Sparkles size={15} /><span>{messages.contextWindow}</span><strong>{messages.pageRange(Math.max(1, currentPage - 1), Math.min(totalPages, currentPage + 1))}</strong></div>
      {settingsOpen && <SettingsPanel settings={settings} locale={locale} messages={messages} onChange={setSettings} onClose={() => setSettingsOpen(false)} />}
      {libraryOpen && (
        <BookLibrary
          books={cloudBooks}
          locale={locale}
          messages={messages}
          currentDocumentId={documentId}
          loading={cloudBooksLoading}
          onSelect={(book) => void loadCloudBook(book)}
          onWarm={(book) => void warmCloudBook(book).catch(() => undefined)}
          onUpload={() => {
            setLibraryOpen(false);
            fileInput.current?.click();
          }}
          onClose={() => setLibraryOpen(false)}
        />
      )}
    </main>
  );
}
