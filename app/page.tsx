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
  ListTree,
  LoaderCircle,
  Menu,
  Minus,
  MoreHorizontal,
  Moon,
  PanelLeftClose,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Sparkles,
  Sun,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CLOUD_PDF_RANGE_CHUNK_SIZE, createCloudPdfRangeTransport } from "../lib/cloud-pdf-range-transport";
import { createConcurrencyLimiter } from "../lib/concurrency-limiter";
import {
  calculatePageOffset,
  collectPageAnchors,
  collectTocEntries,
  extractNavigationObservation,
  mergeNavigationObservation,
  normalizeNavigationObservation,
  resolveTocEntryPage,
  type DocumentNavigation,
  type NavigationObservation,
  type TocEntry,
} from "../lib/document-navigation";
import { createLatestTaskRegistry } from "../lib/latest-task-registry";
import { isDocumentSearchShortcut } from "../lib/keyboard-shortcuts";
import { deduplicatePageBoundary, normalizeTranslationPayload } from "../lib/translation-layout";
import { searchTranslationPayload } from "../lib/translation-search";
import { DEFAULT_TYPEWRITER_CHARACTERS_PER_SECOND, typewriterProgress } from "../lib/translation-typewriter";
import { pageWorkWindow, isPageWorkEnabled, shouldStartTranslationRequest } from "../lib/viewport-work";

type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;
type PdfLoadingTask = import("pdfjs-dist").PDFDocumentLoadingTask;
type PdfRenderTask = import("pdfjs-dist").RenderTask;
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

type AppSettings = ProviderSettings & {
  schemaVersion: number;
  smoothScrolling: boolean;
  translationAnimation: boolean;
  translationAnimationSpeed: number;
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

type TranslationSource = "cache" | "api";

type SearchMatch = {
  page: number;
  snippet: string;
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
    restartTranslation: "停止当前任务并重新翻译本页",
    readingContext: (page: number) => `正在读取第 ${page} 页及相邻上下文`,
    loadingCachedTranslation: (page: number) => `正在载入第 ${page} 页的缓存译文`,
    retry: "重试",
    settingsDialog: "设置",
    settings: "设置",
    settingsSubtitle: "阅读体验与视觉翻译设置",
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
    smoothScrolling: "平滑滚动",
    smoothScrollingHelp: "目录跳转和翻页时播放滚动动画",
    translationAnimation: "渐变打字效果",
    translationAnimationHelp: "仅在 API 生成新译文时播放；缓存译文直接显示。",
    translationAnimationSpeed: (speed: number) => `动画速度 · ${speed} 字/秒`,
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
    contents: "目录",
    searchPages: "搜索页码",
    searchPlaceholder: "搜索译文",
    searchResults: (count: number) => `${count} 条结果`,
    searching: "正在搜索已翻译页面",
    noSearchResults: "未找到匹配内容",
    searchFailed: "无法搜索已翻译内容",
    contentsCount: (count: number) => `${count} 项`,
    contentsEmpty: "尚未检测到目录",
    contentsEmptyHelp: "阅读到目录页并生成译文后，目录会自动出现在这里。",
    pageOffset: "PDF 页码偏移",
    automaticOffset: (offset: string) => `自动 ${offset}`,
    manualOffset: (offset: string) => `手动 ${offset}`,
    offsetUncalibrated: "尚未校准",
    offsetHelp: "书内页码 + 偏移 = PDF 页码；读取带页码的正文后会自动计算。",
    offsetInput: "PDF 页码偏移量",
    decreaseOffset: "减小页码偏移",
    increaseOffset: "增大页码偏移",
    resetAutomaticOffset: "恢复自动计算",
    tocTarget: (page: number) => `跳转到 PDF 第 ${page} 页`,
    tocIndexConfirmed: "索引已校准",
    tocIndexPending: "索引待校准",
    scannedEdition: (pages: number) => `${pages} 页 · 扫描版`,
    readingProgress: "阅读进度",
    page: (page: number) => `第 ${page} 页`,
    previousPage: "上一页",
    nextPage: "下一页",
    sourceScan: "原文扫描",
    moreOptions: "更多选项",
    closeError: "关闭错误提示",
    pdfReady: "PDF 已加载。填写 API key 后才会开始生成译文。",
    openSettings: "打开设置",
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
    apiKeyRequired: "请先在设置中填写 API key。",
    invalidTranslation: "模型返回了无效的译文结构。",
    translationFailed: "无法生成译文",
    cloudTranslationReadFailed: "无法读取云端译文缓存",
    cloudTranslationWriteFailed: "无法写入云端译文缓存",
    navigationReadFailed: "无法读取云端目录",
    navigationWriteFailed: "无法写入云端目录",
    translationRequestFailed: "翻译请求失败",
    translationCacheHit: "已从云端译文缓存载入",
    translationApiSucceeded: "API 翻译成功",
    translationInProgress: "正在读取或生成译文",
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
    restartTranslation: "Stop the current task and translate this page again",
    readingContext: (page: number) => `Reading page ${page} and adjacent context`,
    loadingCachedTranslation: (page: number) => `Loading cached translation for page ${page}`,
    retry: "Retry",
    settingsDialog: "Settings",
    settings: "Settings",
    settingsSubtitle: "Reading and vision translation preferences",
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
    smoothScrolling: "Smooth scrolling",
    smoothScrollingHelp: "Animate page and contents navigation",
    translationAnimation: "Gradient typewriter effect",
    translationAnimationHelp: "Play only for new API translations; show cached translations immediately.",
    translationAnimationSpeed: (speed: number) => `Animation speed · ${speed} chars/s`,
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
    contents: "Contents",
    searchPages: "Search pages",
    searchPlaceholder: "Search translations",
    searchResults: (count: number) => `${count} result${count === 1 ? "" : "s"}`,
    searching: "Searching translated pages",
    noSearchResults: "No matching text found",
    searchFailed: "Unable to search translated content",
    contentsCount: (count: number) => `${count} item${count === 1 ? "" : "s"}`,
    contentsEmpty: "No contents detected yet",
    contentsEmptyHelp: "Contents appear here automatically after a contents page is translated.",
    pageOffset: "PDF page offset",
    automaticOffset: (offset: string) => `Auto ${offset}`,
    manualOffset: (offset: string) => `Manual ${offset}`,
    offsetUncalibrated: "Not calibrated",
    offsetHelp: "Printed page + offset = PDF page. Reading numbered body pages calibrates it automatically.",
    offsetInput: "PDF page offset",
    decreaseOffset: "Decrease page offset",
    increaseOffset: "Increase page offset",
    resetAutomaticOffset: "Restore automatic calculation",
    tocTarget: (page: number) => `Go to PDF page ${page}`,
    tocIndexConfirmed: "Index calibrated",
    tocIndexPending: "Index pending",
    scannedEdition: (pages: number) => `${pages} pages · Scanned edition`,
    readingProgress: "Reading progress",
    page: (page: number) => `Page ${page}`,
    previousPage: "Previous page",
    nextPage: "Next page",
    sourceScan: "Source scan",
    moreOptions: "More options",
    closeError: "Dismiss error",
    pdfReady: "PDF loaded. Add an API key to start generating translations.",
    openSettings: "Open settings",
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
    apiKeyRequired: "Add an API key in Settings first.",
    invalidTranslation: "The model returned an invalid translation structure.",
    translationFailed: "Unable to generate translation",
    cloudTranslationReadFailed: "Unable to read the cloud translation cache",
    cloudTranslationWriteFailed: "Unable to write the cloud translation cache",
    navigationReadFailed: "Unable to read cloud contents",
    navigationWriteFailed: "Unable to write cloud contents",
    translationRequestFailed: "Translation request failed",
    translationCacheHit: "Loaded from the cloud translation cache",
    translationApiSucceeded: "API translation succeeded",
    translationInProgress: "Loading or generating translation",
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

const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  provider: "openai",
  endpoint: "https://api.openai.com/v1/responses",
  apiKey: "",
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  targetLanguage: "Simplified Chinese",
  nearbyPages: 2,
  translationConcurrency: 4,
  smoothScrolling: true,
  translationAnimation: true,
  translationAnimationSpeed: DEFAULT_TYPEWRITER_CHARACTERS_PER_SECOND,
};

const translationLimiter = createConcurrencyLimiter();
let latestTranslationVersion = Date.now() * 1000;
const EMPTY_NAVIGATION: DocumentNavigation = { observations: [], manualOffset: null };
const BOOK_QUERY_PARAMETER = "book";

function bookIdFromUrl() {
  return new URL(window.location.href).searchParams.get(BOOK_QUERY_PARAMETER)?.trim() || null;
}

function replaceBookInUrl(bookId: string | null) {
  const url = new URL(window.location.href);
  if (bookId) url.searchParams.set(BOOK_QUERY_PARAMETER, bookId);
  else url.searchParams.delete(BOOK_QUERY_PARAMETER);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

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

function isWorkCancellation(error: unknown) {
  return error instanceof Error
    && ["AbortError", "RenderingCancelledException"].includes(error.name);
}

function cacheKey(documentId: string, page: number, settings: ProviderSettings) {
  return ["layout-v3", documentId, page, cacheKeySuffix(settings)].join("::");
}

function cacheKeySuffix(settings: ProviderSettings) {
  return [settings.provider, settings.endpoint, settings.model, settings.reasoningEffort, settings.targetLanguage].join("::");
}

async function readCloudCache(key: string, fallbackMessage: string, signal?: AbortSignal): Promise<Translation | undefined> {
  const response = await fetch(`/api/translations?key=${encodeURIComponent(key)}`, { cache: "no-store", signal });
  const result = await response.json() as { translation?: Translation | null; error?: string };
  if (!response.ok) throw new Error(result.error || fallbackMessage);
  return result.translation ? normalizeTranslationPayload(result.translation) as Translation : undefined;
}

async function readCloudTranslationIndex(
  documentId: string,
  settings: ProviderSettings,
  fallbackMessage: string,
): Promise<number[]> {
  const query = new URLSearchParams({ documentId, cacheKeySuffix: cacheKeySuffix(settings) });
  const response = await fetch(`/api/translations?${query}`, { cache: "no-store" });
  const result = await response.json() as { pages?: unknown; error?: string };
  if (!response.ok) throw new Error(result.error || fallbackMessage);
  return Array.isArray(result.pages)
    ? result.pages.map(Number).filter((page) => Number.isSafeInteger(page) && page > 0)
    : [];
}

async function readCloudBook(id: string, fallbackMessage: string): Promise<CloudBook> {
  const response = await fetch(`/api/books/${encodeURIComponent(id)}`, { cache: "no-store" });
  const result = await response.json() as { book?: CloudBook; error?: string };
  if (!response.ok || !result.book) throw new Error(result.error || fallbackMessage);
  return result.book;
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

async function readCloudNavigation(documentId: string, fallbackMessage: string): Promise<DocumentNavigation> {
  const response = await fetch(`/api/navigation?documentId=${encodeURIComponent(documentId)}`, { cache: "no-store" });
  const result = await response.json() as { navigation?: DocumentNavigation; error?: string };
  if (!response.ok) throw new Error(result.error || fallbackMessage);
  const observations = Array.isArray(result.navigation?.observations)
    ? result.navigation.observations.map(normalizeNavigationObservation).filter((observation) => observation.pdfPage > 0)
    : [];
  return {
    observations,
    manualOffset: Number.isSafeInteger(result.navigation?.manualOffset) ? Number(result.navigation?.manualOffset) : null,
  };
}

async function writeCloudNavigationObservation(
  documentId: string,
  observation: NavigationObservation,
  fallbackMessage: string,
) {
  const response = await fetch("/api/navigation", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId, observation }),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error || fallbackMessage);
}

async function writeCloudManualOffset(documentId: string, manualOffset: number | null, fallbackMessage: string) {
  const response = await fetch("/api/navigation", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId, manualOffset }),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error || fallbackMessage);
}

function signedOffset(value: number) {
  return value > 0 ? `+${value}` : String(value);
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

function HighlightedText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return text;
  const normalizedText = text.toLocaleLowerCase();
  const normalizedNeedle = needle.toLocaleLowerCase();
  const parts = [];
  let offset = 0;
  while (offset < text.length) {
    const match = normalizedText.indexOf(normalizedNeedle, offset);
    if (match < 0) {
      parts.push(text.slice(offset));
      break;
    }
    if (match > offset) parts.push(text.slice(offset, match));
    parts.push(<mark key={match}>{text.slice(match, match + needle.length)}</mark>);
    offset = match + needle.length;
  }
  return parts;
}

function TypewriterText({ text, query, offset, progress }: { text: string; query: string; offset: number; progress: number }) {
  const characters = useMemo(() => Array.from(text), [text]);
  const revealedCount = Math.min(characters.length, Math.max(0, progress - offset));
  const tailLength = revealedCount < characters.length ? Math.min(5, revealedCount) : 0;
  const stableText = characters.slice(0, revealedCount - tailLength).join("");
  const tailText = characters.slice(revealedCount - tailLength, revealedCount).join("");
  const pendingText = characters.slice(revealedCount).join("");

  return (
    <span className="typewriter-text" aria-label={text}>
      <span aria-hidden="true"><HighlightedText text={stableText} query={query} /></span>
      {tailText && <span className="typewriter-tail" aria-hidden="true">{tailText}</span>}
      {pendingText && <span className="typewriter-pending" aria-hidden="true">{pendingText}</span>}
    </span>
  );
}

function useTypewriterProgress(
  texts: string[],
  pending: boolean,
  active: boolean,
  version: number | undefined,
  charactersPerSecond: number,
  onComplete: () => void,
) {
  const animationKey = texts.join("\u0000");
  const runKey = `${version ?? "none"}\u0001${animationKey}\u0001${charactersPerSecond}`;
  const { offsets, total } = useMemo(() => {
    const characterCounts = animationKey
      ? animationKey.split("\u0000").map((text) => Array.from(text).length)
      : [];
    return {
      offsets: characterCounts.map((_, index) => characterCounts
        .slice(0, index)
        .reduce((sum, count) => sum + count, 0)),
      total: characterCounts.reduce((sum, count) => sum + count, 0),
    };
  }, [animationKey]);
  const [animation, setAnimation] = useState({ key: "", progress: 0 });
  const running = pending && (active || animation.key === runKey);

  useEffect(() => {
    if (!running) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const startedAt = performance.now();
    let frame = 0;
    const update = (now: number) => {
      const next = reducedMotion ? total : typewriterProgress(now - startedAt, total, charactersPerSecond);
      setAnimation({ key: runKey, progress: next });
      if (next < total) frame = requestAnimationFrame(update);
      else onComplete();
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [charactersPerSecond, onComplete, runKey, running, total]);

  const progress = !pending
    ? total
    : running && animation.key === runKey ? animation.progress : 0;
  return { offsets, progress };
}

function TranslationText({
  value,
  messages,
  searchQuery,
  animate,
  animationActive,
  animationSpeed,
  onAnimationComplete,
}: {
  value: Translation;
  messages: UiMessages;
  searchQuery: string;
  animate: boolean;
  animationActive: boolean;
  animationSpeed: number;
  onAnimationComplete: () => void;
}) {
  const texts = value.blocks?.length
    ? value.blocks.flatMap((block) => {
      if (block.kind === "spacer") return [];
      if (block.kind === "list_item") return [block.marker, block.text, block.trailing];
      return [block.text];
    })
    : value.markdown.split(/\n{2,}/);
  const { offsets, progress } = useTypewriterProgress(
    value.isBlank ? [] : texts,
    animate,
    animationActive,
    value.cacheVersion,
    animationSpeed,
    onAnimationComplete,
  );

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
    let segmentIndex = 0;
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
            if (block.kind === "list_item") {
              const markerIndex = segmentIndex++;
              const textIndex = segmentIndex++;
              const trailingIndex = segmentIndex++;
              return (
                <div key={index} className={className}>
                  <span className="block-marker">
                    <TypewriterText text={block.marker} query="" offset={offsets[markerIndex] ?? 0} progress={progress} />
                  </span>
                  <span className="block-text">
                    <TypewriterText text={block.text} query={searchQuery} offset={offsets[textIndex] ?? 0} progress={progress} />
                  </span>
                  <span className="block-trailing">
                    <TypewriterText text={block.trailing} query="" offset={offsets[trailingIndex] ?? 0} progress={progress} />
                  </span>
                </div>
              );
            }
            const currentTextIndex = segmentIndex++;
            const content = (
              <TypewriterText
                text={block.text}
                query={searchQuery}
                offset={offsets[currentTextIndex] ?? 0}
                progress={progress}
              />
            );
            if (block.kind === "heading") {
              return <h2 key={index} className={className}>{content}</h2>;
            }
            return <p key={index} className={className}>{content}</p>;
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
      {texts.map((paragraph, index) => (
        <p key={`${index}-${paragraph}`}>
          <TypewriterText text={paragraph} query={searchQuery} offset={offsets[index] ?? 0} progress={progress} />
        </p>
      ))}
      <div className="translation-meta">
        <CircleCheck size={14} />
        {value.revised ? messages.revised : messages.cached}
      </div>
    </article>
  );
}

function TranslationSkeleton({ page, messages, cached }: { page: number; messages: UiMessages; cached: boolean }) {
  return (
    <div className="translation-skeleton">
      <div className="ai-working">
        {cached ? <Cloud size={15} /> : <Sparkles size={15} />}
        {cached ? messages.loadingCachedTranslation(page) : messages.readingContext(page)}
      </div>
      <i /><i /><i /><i className="short" />
    </div>
  );
}

type PageSpreadProps = {
  page: number;
  totalPages: number;
  nearbyPages: number;
  workEnabled: boolean;
  workDistance: number;
  isDemo: boolean;
  translation?: Translation;
  translationSource?: TranslationSource;
  animateTranslation: boolean;
  translationAnimationSpeed: number;
  loading: boolean;
  error?: string;
  renderPage: (page: number) => Promise<string>;
  requestTranslation: (page: number, force?: boolean, cacheOnly?: boolean) => void;
  onTranslationAnimationComplete: (page: number, cacheVersion?: number) => void;
  setCurrentPage: (page: number) => void;
  messages: UiMessages;
  searchQuery: string;
};

function PageSpread({
  page,
  totalPages,
  nearbyPages,
  workEnabled,
  workDistance,
  isDemo,
  translation,
  translationSource,
  animateTranslation,
  translationAnimationSpeed,
  loading,
  error,
  renderPage,
  requestTranslation,
  onTranslationAnimationComplete,
  setCurrentPage,
  messages,
  searchQuery,
}: PageSpreadProps) {
  const { ref, near } = useNearViewport(`${Math.max(1, nearbyPages) * 720}px 0px`);
  const [image, setImage] = useState<string>();
  const [renderError, setRenderError] = useState("");
  const cachedTranslation = translationSource === "cache";
  const finishTranslationAnimation = useCallback(
    () => onTranslationAnimationComplete(page, translation?.cacheVersion),
    [onTranslationAnimationComplete, page, translation?.cacheVersion],
  );

  useEffect(() => {
    if (isDemo) return;
    if (!near) {
      const releaseImage = window.setTimeout(() => setImage(undefined), 500);
      return () => window.clearTimeout(releaseImage);
    }
    if (!workEnabled) return;

    let active = true;
    const startRender = () => {
      renderPage(page)
        .then((result) => active && setImage(result))
        .catch((error) => {
          if (!active || isWorkCancellation(error)) return;
          setRenderError(error instanceof Error ? error.message : "Unknown page rendering error");
        });
    };
    let timer: number | undefined;
    if (workDistance === 0) startRender();
    else timer = window.setTimeout(startRender, workDistance * 180);
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [isDemo, near, page, renderPage, workDistance, workEnabled]);

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
          {(translation || loading) && (
            <button
              className="icon-button subtle"
              aria-label={loading ? messages.restartTranslation : messages.retranslate}
              title={loading ? messages.restartTranslation : messages.retranslate}
              onClick={() => requestTranslation(page, true)}
            >
              <RefreshCw className={cn(loading && "spin")} size={15} />
            </button>
          )}
        </div>
        {translation ? (
          <TranslationText
            value={translation}
            messages={messages}
            searchQuery={searchQuery}
            animate={animateTranslation}
            animationActive={workDistance === 0}
            animationSpeed={translationAnimationSpeed}
            onAnimationComplete={finishTranslationAnimation}
          />
        ) : loading ? (
          <TranslationSkeleton page={page} messages={messages} cached={cachedTranslation} />
        ) : error ? (
          <div className="translation-error">
            <p>{error}</p>
            <button className="secondary-button" onClick={() => requestTranslation(page, true)}>{messages.retry}</button>
          </div>
        ) : (
          <TranslationSkeleton page={page} messages={messages} cached={cachedTranslation} />
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
  settings: AppSettings;
  locale: UiLocale;
  messages: UiMessages;
  onChange: (next: AppSettings) => void;
  onClose: () => void;
}) {
  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="settings-panel" role="dialog" aria-modal="true" aria-label={messages.settingsDialog} onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-title">
          <div><span>{messages.settings}</span><p>{messages.settingsSubtitle}</p></div>
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
            <select id="reasoning" value={settings.reasoningEffort} onChange={(event) => update("reasoningEffort", event.target.value as AppSettings["reasoningEffort"])}>
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

        <button
          type="button"
          className={cn("setting-switch", settings.smoothScrolling && "active")}
          role="switch"
          aria-checked={settings.smoothScrolling}
          onClick={() => update("smoothScrolling", !settings.smoothScrolling)}
        >
          <span><strong>{messages.smoothScrolling}</strong><small>{messages.smoothScrollingHelp}</small></span>
          <i aria-hidden="true"><span /></i>
        </button>

        <button
          type="button"
          className={cn("setting-switch", settings.translationAnimation && "active")}
          role="switch"
          aria-checked={settings.translationAnimation}
          onClick={() => update("translationAnimation", !settings.translationAnimation)}
        >
          <span><strong>{messages.translationAnimation}</strong><small>{messages.translationAnimationHelp}</small></span>
          <i aria-hidden="true"><span /></i>
        </button>

        <label className="field-label" htmlFor="translation-animation-speed">
          {messages.translationAnimationSpeed(settings.translationAnimationSpeed)}
        </label>
        <input
          id="translation-animation-speed"
          className="range"
          type="range"
          min="20"
          max="120"
          step="5"
          disabled={!settings.translationAnimation}
          value={settings.translationAnimationSpeed}
          onChange={(event) => update("translationAnimationSpeed", Number(event.target.value))}
        />

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
  onUpload,
  onClose,
}: {
  books: CloudBook[];
  locale: UiLocale;
  messages: UiMessages;
  currentDocumentId: string;
  loading: boolean;
  onSelect: (book: CloudBook) => void;
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

function ContentsNavigation({
  entries,
  anchors,
  manualOffset,
  totalPages,
  currentPage,
  loading,
  error,
  messages,
  onNavigate,
  onManualOffsetChange,
}: {
  entries: TocEntry[];
  anchors: ReturnType<typeof collectPageAnchors>;
  manualOffset: number | null;
  totalPages: number;
  currentPage: number;
  loading: boolean;
  error: string;
  messages: UiMessages;
  onNavigate: (page: number) => void;
  onManualOffsetChange: (offset: number | null) => void;
}) {
  const primaryNumbering = entries.some((entry) => entry.numbering === "arabic")
    ? "arabic"
    : entries[0]?.numbering || "arabic";
  const automaticOffset = calculatePageOffset(anchors, primaryNumbering);
  const effectiveOffset = manualOffset ?? automaticOffset ?? 0;
  const offsetStatus = manualOffset != null
    ? messages.manualOffset(signedOffset(manualOffset))
    : automaticOffset != null
      ? messages.automaticOffset(signedOffset(automaticOffset))
      : messages.offsetUncalibrated;

  function applyInput(target: HTMLInputElement) {
    const value = Number(target.value);
    if (Number.isSafeInteger(value) && Math.abs(value) <= 10000) {
      onManualOffsetChange(value);
      return;
    }
    target.value = String(effectiveOffset);
  }

  return (
    <div className="toc-panel">
      {entries.length > 0 && <div className="toc-calibration">
        <div className="toc-calibration-title">
          <span>{messages.pageOffset}</span>
          <strong>{offsetStatus}</strong>
        </div>
        <div className="offset-controls">
          <button className="icon-button" aria-label={messages.decreaseOffset} onClick={() => onManualOffsetChange(effectiveOffset - 1)}><Minus size={14} /></button>
          <input
            key={`${manualOffset ?? "auto"}-${automaticOffset ?? "none"}`}
            type="number"
            defaultValue={effectiveOffset}
            aria-label={messages.offsetInput}
            onBlur={(event) => applyInput(event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                event.currentTarget.value = String(effectiveOffset);
                event.currentTarget.blur();
              }
            }}
          />
          <button className="icon-button" aria-label={messages.increaseOffset} onClick={() => onManualOffsetChange(effectiveOffset + 1)}><Plus size={14} /></button>
          <button className="icon-button" disabled={manualOffset == null} aria-label={messages.resetAutomaticOffset} onClick={() => onManualOffsetChange(null)}><RotateCcw size={14} /></button>
        </div>
        <p>{messages.offsetHelp}</p>
        <div className="toc-status-legend">
          <span className="calibrated"><i />{messages.tocIndexConfirmed}</span>
          <span className="uncalibrated"><i />{messages.tocIndexPending}</span>
        </div>
        {error && <p className="toc-error">{error}</p>}
      </div>}

      {entries.length ? (
        <nav className="toc-list" aria-label={messages.contents}>
          {entries.map((entry) => {
            const target = resolveTocEntryPage(entry, anchors, manualOffset, totalPages);
            const calibrated = Boolean(target?.calibrated);
            const status = calibrated ? messages.tocIndexConfirmed : messages.tocIndexPending;
            return (
              <button
                key={`${entry.sourcePage}-${entry.ordinal}-${entry.title}`}
                className={cn(target?.page === currentPage && "active", calibrated ? "calibrated" : "uncalibrated")}
                title={target ? `${messages.tocTarget(target.page)} · ${status}` : status}
                onClick={() => target && onNavigate(target.page)}
              >
                <span className="toc-entry-title" style={{ paddingInlineStart: `${entry.level * 11}px` }}>{entry.title}</span>
                <span className="toc-entry-page">{entry.label}</span>
              </button>
            );
          })}
        </nav>
      ) : loading ? (
        <div className="toc-empty"><LoaderCircle className="spin" size={22} /></div>
      ) : (
        <div className="toc-empty">
          <ListTree size={24} />
          <strong>{messages.contentsEmpty}</strong>
          <p className={cn(error && "toc-error")}>{error || messages.contentsEmptyHelp}</p>
        </div>
      )}
    </div>
  );
}

type SidebarView = "pages" | "contents" | "search";

export default function Home() {
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<PdfDocument>();
  const pdfLoadingTaskRef = useRef<PdfLoadingTask>();
  const imageCache = useRef(new Map<number, string>());
  const renderJobs = useRef(new Map<number, Promise<string>>());
  const renderTasks = useRef(new Map<number, PdfRenderTask>());
  const renderEpoch = useRef(0);
  const translationRuns = useRef(createLatestTaskRegistry<string>());
  const translationRequests = useRef(new Map<string, AbortController>());
  const navigationWrites = useRef(new Set<string>());
  const manualOffsetTouched = useRef(false);
  const pageNavigationCleanup = useRef<() => void>(() => undefined);
  const viewportSettleTimer = useRef<number>();
  const viewportWorkEnabledRef = useRef(true);
  const programmaticScroll = useRef(false);
  const userScrollIntentUntil = useRef(0);
  const navigationTarget = useRef<number | null>(null);
  const documentLoadSequence = useRef(0);
  const documentIdRef = useRef("verso-demo");
  const currentPageRef = useRef(1);
  const translationAnimationEnabledRef = useRef(DEFAULT_SETTINGS.translationAnimation);
  const sourceScrollAnchor = useRef<{ page: number; top: number } | null>(null);
  const sourceAnchorReleaseFrame = useRef<number>();
  const translationsRef = useRef<Record<number, Translation>>(DEMO_TRANSLATIONS);
  const translationSourcesRef = useRef<Record<number, TranslationSource>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarView, setSidebarView] = useState<SidebarView>("pages");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [locale, setLocale] = useState<UiLocale>("zh-CN");
  const [theme, setTheme] = useState<ThemeMode>("light");
  const messages = UI_MESSAGES[locale];
  const messagesRef = useRef(messages);
  const [settings, setSettings] = useState<AppSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    const stored = localStorage.getItem("verso-settings");
    if (!stored) return DEFAULT_SETTINGS;
    const storedSettings = JSON.parse(stored) as Partial<AppSettings>;
    const restored = { ...DEFAULT_SETTINGS, ...storedSettings } as AppSettings;
    return {
      ...restored,
      schemaVersion: DEFAULT_SETTINGS.schemaVersion,
      translationAnimationSpeed: storedSettings.schemaVersion === DEFAULT_SETTINGS.schemaVersion
        && restored.translationAnimationSpeed >= 10
        ? restored.translationAnimationSpeed
        : DEFAULT_TYPEWRITER_CHARACTERS_PER_SECOND,
    };
  });
  const translationSettings = useMemo<ProviderSettings>(() => ({
    provider: settings.provider,
    endpoint: settings.endpoint,
    apiKey: settings.apiKey,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    targetLanguage: settings.targetLanguage,
    nearbyPages: settings.nearbyPages,
    translationConcurrency: settings.translationConcurrency,
  }), [
    settings.apiKey,
    settings.endpoint,
    settings.model,
    settings.nearbyPages,
    settings.provider,
    settings.reasoningEffort,
    settings.targetLanguage,
    settings.translationConcurrency,
  ]);
  const [documentId, setDocumentId] = useState("verso-demo");
  const [fileName, setFileName] = useState("The Shape of Attention.pdf");
  const [totalPages, setTotalPages] = useState(2);
  const [currentPage, setCurrentPage] = useState(1);
  const [viewportWorkEnabled, setViewportWorkEnabled] = useState(true);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [documentReady, setDocumentReady] = useState(true);
  const [cloudIndexLoaded, setCloudIndexLoaded] = useState(false);
  const [documentError, setDocumentError] = useState("");
  const [isDemo, setIsDemo] = useState(true);
  const [translations, setTranslations] = useState<Record<number, Translation>>(DEMO_TRANSLATIONS);
  const [translationSources, setTranslationSources] = useState<Record<number, TranslationSource>>({});
  const [translationAnimationVersions, setTranslationAnimationVersions] = useState<Record<number, number>>({});
  const [loadingPages, setLoadingPages] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [cloudBooks, setCloudBooks] = useState<CloudBook[]>([]);
  const [cloudBooksLoading, setCloudBooksLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [cloudMessage, setCloudMessage] = useState("");
  const [navigation, setNavigation] = useState<DocumentNavigation>(EMPTY_NAVIGATION);
  const [navigationLoading, setNavigationLoading] = useState(false);
  const [navigationError, setNavigationError] = useState("");

  useLayoutEffect(() => {
    currentPageRef.current = currentPage;
  }, [currentPage]);

  useLayoutEffect(() => {
    translationSourcesRef.current = translationSources;
  }, [translationSources]);

  useEffect(() => {
    translationAnimationEnabledRef.current = settings.translationAnimation;
  }, [settings.translationAnimation]);

  const updateSettings = useCallback((next: AppSettings) => {
    translationAnimationEnabledRef.current = next.translationAnimation;
    setSettings(next);
    if (!next.translationAnimation) setTranslationAnimationVersions({});
  }, []);

  const completeTranslationAnimation = useCallback((page: number, cacheVersion?: number) => {
    setTranslationAnimationVersions((existing) => {
      if (!(page in existing) || (cacheVersion !== undefined && existing[page] !== cacheVersion)) return existing;
      const next = { ...existing };
      delete next[page];
      return next;
    });
  }, []);

  const captureSourceScrollAnchor = useCallback(() => {
    if (sourceScrollAnchor.current) return;
    const spreads = document.querySelector<HTMLElement>(".spreads");
    if (!spreads) return;
    const preferred = spreads.querySelector<HTMLElement>(`[data-page="${currentPageRef.current}"]`);
    const pageSpreads = Array.from(spreads.querySelectorAll<HTMLElement>("[data-page]"));
    const isVisible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > 113 && rect.top < window.innerHeight;
    };
    const anchorPage = preferred && isVisible(preferred)
      ? preferred
      : pageSpreads.find(isVisible);
    const source = anchorPage?.querySelector<HTMLElement>(".source-page");
    const page = Number(anchorPage?.dataset.page);
    if (!source || !Number.isSafeInteger(page)) return;
    sourceScrollAnchor.current = { page, top: source.getBoundingClientRect().top };
  }, []);

  const updateTranslations = useCallback((
    update: (existing: Record<number, Translation>) => Record<number, Translation>,
  ) => {
    captureSourceScrollAnchor();
    setTranslations((existing) => {
      const next = update(existing);
      translationsRef.current = next;
      return next;
    });
  }, [captureSourceScrollAnchor]);

  useLayoutEffect(() => {
    const anchor = sourceScrollAnchor.current;
    sourceScrollAnchor.current = null;
    if (!anchor) return;
    const source = document.querySelector<HTMLElement>(`[data-page="${anchor.page}"] .source-page`);
    if (!source) return;
    const correction = source.getBoundingClientRect().top - anchor.top;
    if (Math.abs(correction) < 0.5) return;
    programmaticScroll.current = true;
    window.scrollBy({ top: correction, behavior: "instant" });
    if (sourceAnchorReleaseFrame.current) window.cancelAnimationFrame(sourceAnchorReleaseFrame.current);
    sourceAnchorReleaseFrame.current = window.requestAnimationFrame(() => {
      sourceAnchorReleaseFrame.current = undefined;
      if (navigationTarget.current == null) programmaticScroll.current = false;
    });
  }, [translations]);

  const cancelPageRenders = useCallback(() => {
    renderEpoch.current += 1;
    for (const task of renderTasks.current.values()) {
      try {
        task.cancel();
      } catch {
        // The task may have completed between iteration and cancellation.
      }
    }
    renderTasks.current.clear();
    renderJobs.current.clear();
  }, []);

  const cancelDocumentWork = useCallback(() => {
    cancelPageRenders();
    translationRuns.current.cancelAll();
    for (const controller of translationRequests.current.values()) controller.abort();
    translationRequests.current.clear();
    setLoadingPages(new Set());
  }, [cancelPageRenders]);

  // Scrolling pauses new viewport work, but in-flight translation runs must finish.
  const suspendViewportWork = useCallback(() => {
    if (!viewportWorkEnabledRef.current) return;
    viewportWorkEnabledRef.current = false;
    setViewportWorkEnabled(false);
  }, []);

  const scheduleViewportResume = useCallback((delay = 180) => {
    if (viewportSettleTimer.current) window.clearTimeout(viewportSettleTimer.current);
    viewportSettleTimer.current = window.setTimeout(() => {
      viewportSettleTimer.current = undefined;
      const target = navigationTarget.current;
      navigationTarget.current = null;
      if (target != null) setCurrentPage(target);
      viewportWorkEnabledRef.current = true;
      setViewportWorkEnabled(true);
    }, delay);
  }, []);

  const scrollProgrammatically = useCallback((target: HTMLElement, behavior: ScrollBehavior) => {
    programmaticScroll.current = true;
    target.scrollIntoView({ behavior, block: "start" });
  }, []);

  const observeCurrentPage = useCallback((page: number) => {
    if (navigationTarget.current == null) setCurrentPage(page);
  }, []);

  useEffect(() => {
    const detectPreferences = window.setTimeout(() => {
      setLocale(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US");
      setTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    }, 0);
    return () => window.clearTimeout(detectPreferences);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    messagesRef.current = messages;
  }, [locale, messages]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const refreshBooks = useCallback(async () => {
    const currentMessages = messagesRef.current;
    setCloudBooksLoading(true);
    try {
      const response = await fetch("/api/books", { cache: "no-store" });
      const result = await response.json() as { books?: CloudBook[]; error?: string };
      if (!response.ok) throw new Error(result.error || currentMessages.libraryReadFailed);
      setCloudBooks(result.books || []);
    } catch (error) {
      setCloudMessage(error instanceof Error ? error.message : currentMessages.libraryReadFailed);
    } finally {
      setCloudBooksLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPdfRuntime().catch(() => undefined);
    const preload = window.setTimeout(() => void refreshBooks(), 0);
    return () => window.clearTimeout(preload);
  }, [refreshBooks]);

  useEffect(() => {
    localStorage.setItem("verso-settings", JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    document.documentElement.dataset.smoothScroll = settings.smoothScrolling ? "true" : "false";
  }, [settings.smoothScrolling]);

  useEffect(() => {
    indexedDB.deleteDatabase("verso-translation-cache");
  }, []);

  useEffect(() => {
    function handleSearchShortcut(event: KeyboardEvent) {
      if (isDocumentSearchShortcut(event)) {
        event.preventDefault();
        setSettingsOpen(false);
        setLibraryOpen(false);
        setSidebarOpen(true);
        setSidebarView("search");
        window.requestAnimationFrame(() => {
          searchInput.current?.focus();
          searchInput.current?.select();
        });
        return;
      }
      if (event.key === "Escape" && sidebarView === "search" && document.activeElement === searchInput.current) {
        event.preventDefault();
        setSidebarView("pages");
        setSearchLoading(false);
        searchInput.current?.blur();
      }
    }

    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, [sidebarView]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (sidebarView !== "search" || !query) return;

    const controller = new AbortController();
    const search = window.setTimeout(async () => {
      setSearchLoading(true);
      setSearchError("");
      try {
        if (isDemo) {
          const matches = Object.entries(translations).flatMap(([page, translation]) =>
            searchTranslationPayload(translation, Number(page), query));
          setSearchMatches(matches);
          return;
        }

        const response = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentId, query, cacheKeySuffix: cacheKeySuffix(translationSettings) }),
          signal: controller.signal,
        });
        const result = await response.json() as { matches?: SearchMatch[]; error?: string };
        if (!response.ok) throw new Error(result.error || messages.searchFailed);
        setSearchMatches(result.matches || []);
      } catch (error) {
        if (controller.signal.aborted) return;
        setSearchMatches([]);
        setSearchError(error instanceof Error ? error.message : messages.searchFailed);
      } finally {
        if (!controller.signal.aborted) setSearchLoading(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(search);
      controller.abort();
    };
  }, [documentId, isDemo, messages.searchFailed, searchQuery, sidebarView, translationSettings, translations]);

  useEffect(() => {
    const beginUserScroll = () => {
      userScrollIntentUntil.current = performance.now() + 800;
      navigationTarget.current = null;
      suspendViewportWork();
      scheduleViewportResume();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        beginUserScroll();
      }
    };
    const handleScroll = () => {
      if (programmaticScroll.current) return;
      if (performance.now() > userScrollIntentUntil.current) return;
      userScrollIntentUntil.current = performance.now() + 240;
      scheduleViewportResume();
    };
    window.addEventListener("wheel", beginUserScroll, { passive: true });
    window.addEventListener("touchstart", beginUserScroll, { passive: true });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("wheel", beginUserScroll);
      window.removeEventListener("touchstart", beginUserScroll);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll);
    };
  }, [scheduleViewportResume, suspendViewportWork]);

  useEffect(() => () => {
    pageNavigationCleanup.current();
    if (viewportSettleTimer.current) window.clearTimeout(viewportSettleTimer.current);
    if (sourceAnchorReleaseFrame.current) window.cancelAnimationFrame(sourceAnchorReleaseFrame.current);
    cancelDocumentWork();
    void pdfLoadingTaskRef.current?.destroy();
  }, [cancelDocumentWork]);

  const openLibrary = useCallback(() => {
    setLibraryOpen(true);
    void refreshBooks();
  }, [refreshBooks]);

  const loadNavigation = useCallback(async (id: string, sequence: number, providerSettings: ProviderSettings) => {
    setNavigationLoading(true);
    setNavigationError("");
    try {
      const [navigationResult, translationIndexResult] = await Promise.allSettled([
        readCloudNavigation(id, messagesRef.current.navigationReadFailed),
        readCloudTranslationIndex(id, providerSettings, messagesRef.current.cloudTranslationReadFailed),
      ]);
      if (sequence !== documentLoadSequence.current) return;
      if (navigationResult.status === "fulfilled") {
        const remote = navigationResult.value;
        for (const observation of remote.observations) {
          navigationWrites.current.add(`${id}:${observation.pdfPage}:${JSON.stringify(observation)}`);
        }
        setNavigation((existing) => ({
          manualOffset: manualOffsetTouched.current ? existing.manualOffset : remote.manualOffset,
          observations: existing.observations.reduce(
            (observations, observation) => mergeNavigationObservation(observations, observation),
            remote.observations,
          ),
        }));
      } else {
        setNavigationError(
          navigationResult.reason instanceof Error
            ? navigationResult.reason.message
            : messagesRef.current.navigationReadFailed,
        );
      }
      if (translationIndexResult.status === "fulfilled") {
        setTranslationSources((existing) => {
          const indexed = Object.fromEntries(
            translationIndexResult.value.map((page) => [page, "cache" as const]),
          );
          const apiSources = Object.fromEntries(
            Object.entries(existing).filter(([, source]) => source === "api"),
          );
          return { ...indexed, ...apiSources };
        });
      }
    } finally {
      if (sequence === documentLoadSequence.current) setNavigationLoading(false);
    }
  }, []);

  const beginDocumentLoad = useCallback((id: string, name: string, pageCount: number, hasCloudIndex: boolean) => {
    const sequence = ++documentLoadSequence.current;
    const previousLoadingTask = pdfLoadingTaskRef.current;
    const previousPdf = pdfRef.current;
    pdfLoadingTaskRef.current = undefined;
    pdfRef.current = undefined;
    if (previousLoadingTask) void previousLoadingTask.destroy();
    else if (previousPdf) void previousPdf.destroy();
    pageNavigationCleanup.current();
    navigationTarget.current = null;
    suspendViewportWork();
    cancelDocumentWork();
    imageCache.current.clear();
    navigationWrites.current.clear();
    manualOffsetTouched.current = false;
    documentIdRef.current = id;
    setDocumentId(id);
    setFileName(name);
    setTotalPages(Math.max(1, pageCount));
    setCurrentPage(1);
    translationsRef.current = {};
    setTranslations({});
    setTranslationSources({});
    setTranslationAnimationVersions({});
    setSearchQuery("");
    setSearchMatches([]);
    setSearchError("");
    setSearchLoading(false);
    setLoadingPages(new Set());
    setErrors({});
    setSidebarView("pages");
    setNavigation({ observations: [], manualOffset: null });
    setNavigationLoading(false);
    setNavigationError("");
    setIsDemo(false);
    setCloudIndexLoaded(hasCloudIndex);
    setDocumentReady(false);
    setLoadingDocument(true);
    setDocumentError("");
    window.scrollTo({ top: 0, behavior: "instant" });
    return sequence;
  }, [cancelDocumentWork, suspendViewportWork]);

  const finishDocumentLoad = useCallback((sequence: number, pdf: PdfDocument) => {
    if (sequence !== documentLoadSequence.current) {
      void pdf.destroy();
      return false;
    }
    pdfRef.current = pdf;
    setTotalPages(pdf.numPages);
    setDocumentReady(true);
    setLoadingDocument(false);
    viewportWorkEnabledRef.current = true;
    setViewportWorkEnabled(true);
    return true;
  }, []);

  const recordNavigation = useCallback((page: number, translation: Translation) => {
    const observation = extractNavigationObservation(page, translation.blocks || []);
    const signature = `${documentId}:${page}:${JSON.stringify(observation)}`;
    if (navigationWrites.current.has(signature)) return;
    navigationWrites.current.add(signature);
    setNavigation((existing) => ({
      ...existing,
      observations: mergeNavigationObservation(existing.observations, observation),
    }));
    setNavigationError("");
    const sequence = documentLoadSequence.current;
    void writeCloudNavigationObservation(documentId, observation, messagesRef.current.navigationWriteFailed)
      .catch((error) => {
        navigationWrites.current.delete(signature);
        if (sequence !== documentLoadSequence.current) return;
        setNavigationError(error instanceof Error ? error.message : messagesRef.current.navigationWriteFailed);
      });
  }, [documentId]);

  const updateManualOffset = useCallback((manualOffset: number | null) => {
    if (isDemo) return;
    if (manualOffset != null && (!Number.isSafeInteger(manualOffset) || Math.abs(manualOffset) > 10000)) return;
    manualOffsetTouched.current = true;
    setNavigation((existing) => ({ ...existing, manualOffset }));
    setNavigationError("");
    const sequence = documentLoadSequence.current;
    void writeCloudManualOffset(documentId, manualOffset, messagesRef.current.navigationWriteFailed)
      .catch((error) => {
        if (sequence !== documentLoadSequence.current) return;
        setNavigationError(error instanceof Error ? error.message : messagesRef.current.navigationWriteFailed);
      });
  }, [documentId, isDemo]);

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
        book?: CloudBook;
        uploadId?: string;
        objectKey?: string;
        error?: string;
      };
      if (!initialize.ok) throw new Error(initialized.error || messages.uploadFailed);
      if (initialized.exists) {
        setUploadProgress(100);
        setCloudMessage(messages.cloudBookReused);
        if (initialized.book && documentIdRef.current === fileFingerprint) {
          replaceBookInUrl(initialized.book.fingerprint);
        }
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
      if (documentIdRef.current === fileFingerprint) replaceBookInUrl(completed.book.fingerprint);
      await refreshBooks();
    } catch (error) {
      setUploadProgress(null);
      setCloudMessage(error instanceof Error ? error.message : messages.uploadFailed);
    }
  }, [messages, refreshBooks]);

  const renderPage = useCallback(async (pageNumber: number) => {
    const cached = imageCache.current.get(pageNumber);
    if (cached) {
      imageCache.current.delete(pageNumber);
      imageCache.current.set(pageNumber, cached);
      return cached;
    }
    if (!viewportWorkEnabledRef.current) {
      throw new DOMException("Page rendering is paused while the viewport is moving.", "AbortError");
    }
    const existing = renderJobs.current.get(pageNumber);
    if (existing) return existing;

    const epoch = renderEpoch.current;
    let activeRenderTask: PdfRenderTask | undefined;
    const job: Promise<string> = (async () => {
      const pdf = pdfRef.current;
      if (!pdf) throw new Error("PDF is not ready");
      const page = await pdf.getPage(pageNumber);
      if (epoch !== renderEpoch.current) throw new DOMException("Page rendering was cancelled.", "AbortError");
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 1280 / base.width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas is unavailable");
      const renderTask = page.render({ canvas, canvasContext: context, viewport });
      activeRenderTask = renderTask;
      renderTasks.current.set(pageNumber, renderTask);
      await renderTask.promise;
      if (epoch !== renderEpoch.current) throw new DOMException("Page rendering was cancelled.", "AbortError");
      const image = canvas.toDataURL("image/jpeg", 0.82);
      if (epoch !== renderEpoch.current) throw new DOMException("Page rendering was cancelled.", "AbortError");
      imageCache.current.set(pageNumber, image);
      while (imageCache.current.size > 12) {
        const oldest = imageCache.current.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        imageCache.current.delete(oldest);
      }
      return image;
    })().finally(() => {
      if (renderJobs.current.get(pageNumber) === job) renderJobs.current.delete(pageNumber);
      if (activeRenderTask && renderTasks.current.get(pageNumber) === activeRenderTask) {
        renderTasks.current.delete(pageNumber);
      }
    });
    renderJobs.current.set(pageNumber, job);
    return job;
  }, []);

  const requestTranslation = useCallback(async (page: number, force = false, cacheOnly = false) => {
    if (!shouldStartTranslationRequest(
      isDemo,
      Boolean(translationsRef.current[page]),
      force,
      cacheOnly,
      viewportWorkEnabledRef.current,
    )) return;
    const flightKey = `${documentId}:${page}`;
    if (force) {
      translationRuns.current.cancel(flightKey);
      translationRequests.current.get(flightKey)?.abort();
      translationRequests.current.delete(flightKey);
    }
    const runToken = translationRuns.current.start(flightKey);
    if (!runToken) return;
    const controller = new AbortController();
    translationRequests.current.set(flightKey, controller);
    const currentMessages = messagesRef.current;
    const documentSequence = documentLoadSequence.current;
    const key = cacheKey(documentId, page, translationSettings);
    const previousKey = page > 1 ? cacheKey(documentId, page - 1, translationSettings) : "";
    const requestVersion = nextTranslationVersion();
    let previousTranslation: Translation | undefined;
    const isCurrentRun = () => (
      documentSequence === documentLoadSequence.current
      && translationRuns.current.isCurrent(flightKey, runToken)
    );
    const requireCurrentRun = () => {
      if (!isCurrentRun()) throw new DOMException("Translation task was cancelled.", "AbortError");
    };
    const readPreviousTranslation = async () => {
      if (!previousKey) return undefined;
      try {
        return await readCloudCache(previousKey, currentMessages.cloudTranslationReadFailed, controller.signal);
      } catch (error) {
        if (controller.signal.aborted || isWorkCancellation(error)) throw error;
        return undefined;
      }
    };
    setLoadingPages((existing) => new Set(existing).add(page));
    setErrors((existing) => ({ ...existing, [page]: "" }));
    try {
      if (!force) {
        const cached = await readCloudCache(key, currentMessages.cloudTranslationReadFailed, controller.signal);
        if (cached) {
          previousTranslation = await readPreviousTranslation();
          requireCurrentRun();
          const reconciled = reconcilePageBoundary(previousTranslation, cached);
          completeTranslationAnimation(page);
          setTranslationSources((existing) => ({ ...existing, [page]: "cache" }));
          updateTranslations((existing) => ({ ...existing, [page]: reconciled }));
          recordNavigation(page, reconciled);
          if (reconciled !== cached) {
            void writeCloudCache(key, documentId, page, reconciled, currentMessages.cloudTranslationWriteFailed).catch(() => undefined);
          }
          return;
        }
        if (cacheOnly) {
          setTranslationSources((existing) => {
            if (existing[page] !== "cache") return existing;
            const next = { ...existing };
            delete next[page];
            return next;
          });
        }
      }
      if (!translationSettings.apiKey) throw new Error(currentMessages.apiKeyRequired);
      previousTranslation = await readPreviousTranslation();
      requireCurrentRun();

      const payload = await translationLimiter.run(translationSettings.translationConcurrency, async () => {
        requireCurrentRun();
        const contextPages = [page - 1, page, page + 1].filter((value) => value >= 1 && value <= totalPages);
        const images = await Promise.all(contextPages.map(async (number) => ({ page: number, dataUrl: await renderPage(number) })));
        requireCurrentRun();
        const response = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            settings: translationSettings,
            page,
            totalPages,
            images,
            previousTranslationTail: boundaryTail(previousTranslation),
          }),
          signal: controller.signal,
        });
        const result = await response.json() as TranslationResponse & { error?: string };
        if (!response.ok) throw new Error(result.error || currentMessages.translationRequestFailed);
        if (!Array.isArray(result.blocks)) throw new Error(currentMessages.invalidTranslation);
        return result;
      }, controller.signal);
      requireCurrentRun();
      const revision: Translation | undefined = payload.previousPageRevision?.page === page - 1
        && payload.previousPageRevision.blocks.length
        ? {
            ...previousTranslation,
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
      requireCurrentRun();
      if (translationAnimationEnabledRef.current) {
        setTranslationAnimationVersions((existing) => ({ ...existing, [page]: requestVersion }));
      }
      setTranslationSources((existing) => ({
        ...existing,
        ...(revision ? { [page - 1]: "api" as const } : {}),
        [page]: "api",
      }));
      updateTranslations((existing) => ({
        ...existing,
        ...(revision ? { [page - 1]: revision } : {}),
        [page]: translated,
      }));
      recordNavigation(page, translated);
      if (revision) recordNavigation(page - 1, revision);
      await Promise.all([
        writeCloudCache(key, documentId, page, translated, currentMessages.cloudTranslationWriteFailed),
        ...(revision ? [writeCloudCache(previousKey, documentId, page - 1, revision, currentMessages.cloudTranslationWriteFailed)] : []),
      ]);
    } catch (error) {
      if (!isCurrentRun() || isWorkCancellation(error)) return;
      const message = error instanceof Error ? error.message : currentMessages.translationFailed;
      setErrors((existing) => ({ ...existing, [page]: message }));
    } finally {
      if (translationRequests.current.get(flightKey) === controller) {
        translationRequests.current.delete(flightKey);
      }
      if (translationRuns.current.finish(flightKey, runToken) && documentSequence === documentLoadSequence.current) {
        setLoadingPages((existing) => {
          const next = new Set(existing);
          next.delete(page);
          return next;
        });
      }
    }
  }, [completeTranslationAnimation, documentId, isDemo, recordNavigation, renderPage, totalPages, translationSettings, updateTranslations]);

  useEffect(() => {
    if (isDemo || !documentReady || navigationLoading || !viewportWorkEnabled) return;
    const timers = pageWorkWindow(currentPage, totalPages, settings.nearbyPages).map((page) => (
      window.setTimeout(() => {
        const cacheOnly = translationSourcesRef.current[page] === "cache";
        void requestTranslation(page, false, cacheOnly);
      }, 250 + Math.abs(page - currentPage) * 250)
    ));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [currentPage, documentReady, isDemo, navigationLoading, requestTranslation, settings.nearbyPages, totalPages, viewportWorkEnabled]);

  const handleFile = useCallback(async (file?: File) => {
    if (!file) return;
    replaceBookInUrl(null);
    const fileFingerprint = await fingerprint(file);
    const sequence = beginDocumentLoad(fileFingerprint, file.name, 1, false);
    void loadNavigation(fileFingerprint, sequence, translationSettings);
    try {
      const { pdfjs, worker } = await loadPdfRuntime();
      const data = new Uint8Array(await file.arrayBuffer());
      const loadingTask = pdfjs.getDocument({
        data,
        worker,
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        wasmUrl: "/pdfjs/wasm/",
        iccUrl: "/pdfjs/iccs/",
      });
      if (sequence !== documentLoadSequence.current) {
        void loadingTask.destroy();
        return;
      }
      pdfLoadingTaskRef.current = loadingTask;
      const pdf = await loadingTask.promise;
      if (finishDocumentLoad(sequence, pdf)) {
        void uploadToCloud(file, fileFingerprint, pdf.numPages);
      }
    } catch (error) {
      if (sequence !== documentLoadSequence.current) return;
      const detail = error instanceof Error ? error.message : "Unknown PDF error";
      setDocumentError(messages.openPdfFailed(detail));
      setLoadingDocument(false);
    }
  }, [beginDocumentLoad, finishDocumentLoad, loadNavigation, messages, translationSettings, uploadToCloud]);

  const loadCloudBook = useCallback(async (book: CloudBook, updateUrl = true) => {
    setLibraryOpen(false);
    if (updateUrl) replaceBookInUrl(book.fingerprint);
    const sequence = beginDocumentLoad(book.fingerprint, book.name, book.pageCount, true);
    void loadNavigation(book.fingerprint, sequence, translationSettings);
    const currentMessages = messagesRef.current;
    try {
      const { pdfjs, worker } = await loadPdfRuntime();
      const { transport, failure } = createCloudPdfRangeTransport({
        Transport: pdfjs.PDFDataRangeTransport,
        url: `/api/books/${encodeURIComponent(book.id)}/file`,
        length: book.size,
        filename: book.name,
      });
      const loadingTask = pdfjs.getDocument({
        range: transport,
        worker,
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        wasmUrl: "/pdfjs/wasm/",
        iccUrl: "/pdfjs/iccs/",
        rangeChunkSize: CLOUD_PDF_RANGE_CHUNK_SIZE,
        disableStream: true,
        disableAutoFetch: true,
      });
      if (sequence !== documentLoadSequence.current) {
        void loadingTask.destroy();
        return;
      }
      pdfLoadingTaskRef.current = loadingTask;
      void failure.catch((error) => {
        if (sequence !== documentLoadSequence.current) return;
        pdfRef.current = undefined;
        setDocumentReady(false);
        setLoadingDocument(false);
        setDocumentError(messagesRef.current.openCloudFailed(error.message));
        void loadingTask.destroy();
      });
      const pdf = await Promise.race([loadingTask.promise, failure]);
      if (finishDocumentLoad(sequence, pdf)) {
        setUploadProgress(100);
        setCloudMessage(currentMessages.openedFromCloud);
      }
    } catch (error) {
      if (sequence !== documentLoadSequence.current) return;
      const detail = error instanceof Error ? error.message : "Unknown PDF error";
      setDocumentError(currentMessages.openCloudFailed(detail));
      setLoadingDocument(false);
    }
  }, [beginDocumentLoad, finishDocumentLoad, loadNavigation, translationSettings]);

  useEffect(() => {
    const requestedBookId = bookIdFromUrl();
    if (!requestedBookId) return;
    const restoreTimer = window.setTimeout(() => {
      void readCloudBook(requestedBookId, messagesRef.current.libraryReadFailed)
        .then((book) => loadCloudBook(book, false))
        .catch((error) => {
          const detail = error instanceof Error ? error.message : messagesRef.current.libraryReadFailed;
          setDocumentError(messagesRef.current.openCloudFailed(detail));
        });
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, [loadCloudBook]);

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
  const tocEntries = useMemo(() => collectTocEntries(navigation.observations), [navigation.observations]);
  const pageAnchors = useMemo(() => collectPageAnchors(navigation.observations), [navigation.observations]);
  const progress = Math.round((currentPage / totalPages) * 100);

  const goToPage = useCallback((page: number, mode: "direct" | "adjacent" = "direct") => {
    const safePage = Math.min(totalPages, Math.max(1, page));
    const target = document.querySelector<HTMLElement>(`[data-page="${safePage}"]`);
    if (!target) return;
    pageNavigationCleanup.current();
    navigationTarget.current = safePage;
    suspendViewportWork();
    setCurrentPage(safePage);

    let active = true;
    let frame = 0;
    let timeout = 0;
    let settleTimeout = 0;
    let hardTimeout = 0;
    const smoothNavigation = settings.smoothScrolling;
    const scrollContainer = target.closest<HTMLElement>(".spreads");
    const observer = !smoothNavigation && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => scheduleAlignment())
      : null;
    const interruptEvents = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

    const align = () => {
      frame = 0;
      if (!active || !target.isConnected) return;
      scrollProgrammatically(target, smoothNavigation ? "smooth" : "instant");
      if (smoothNavigation) {
        if (settleTimeout) window.clearTimeout(settleTimeout);
        settleTimeout = window.setTimeout(finish, 180);
      }
    };
    const cleanup = () => {
      active = false;
      programmaticScroll.current = false;
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      if (timeout) window.clearTimeout(timeout);
      if (settleTimeout) window.clearTimeout(settleTimeout);
      if (hardTimeout) window.clearTimeout(hardTimeout);
      window.removeEventListener("scroll", handleProgrammaticScroll);
      for (const event of interruptEvents) window.removeEventListener(event, interrupt);
      if (pageNavigationCleanup.current === cleanup) pageNavigationCleanup.current = () => undefined;
    };
    const finish = () => {
      cleanup();
      scheduleViewportResume(40);
    };
    const interrupt = () => {
      navigationTarget.current = null;
      cleanup();
      scheduleViewportResume(40);
    };
    const handleProgrammaticScroll = () => {
      if (!active || !smoothNavigation) return;
      if (settleTimeout) window.clearTimeout(settleTimeout);
      settleTimeout = window.setTimeout(finish, 140);
    };
    function scheduleAlignment() {
      if (!active) return;
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(align);
    }

    pageNavigationCleanup.current = cleanup;
    if (scrollContainer) observer?.observe(scrollContainer);
    if (smoothNavigation) {
      window.addEventListener("scroll", handleProgrammaticScroll, { passive: true });
      hardTimeout = window.setTimeout(finish, 2000);
    }
    for (const event of interruptEvents) window.addEventListener(event, interrupt, { once: true, passive: true });
    if (!smoothNavigation) timeout = window.setTimeout(finish, mode === "adjacent" ? 80 : 140);
    scheduleAlignment();
  }, [scheduleViewportResume, scrollProgrammatically, settings.smoothScrolling, suspendViewportWork, totalPages]);

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
          <button className="icon-button top-search-button" aria-label={messages.searchPages} onClick={() => {
            setSidebarOpen(true);
            setSidebarView("search");
            window.requestAnimationFrame(() => {
              searchInput.current?.focus();
              searchInput.current?.select();
            });
          }}><Search size={17} /></button>
          <button className="icon-button" title={messages.switchTheme} aria-label={messages.switchTheme} aria-pressed={theme === "dark"} onClick={() => setTheme((value) => value === "light" ? "dark" : "light")}>{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</button>
          <button className="secondary-button library-button" onClick={openLibrary}><BookOpen size={16} /> {messages.cloudLibrary}</button>
          <button className="secondary-button" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /> {messages.settings}</button>
          <button className="primary-button" onClick={() => fileInput.current?.click()}><Upload size={16} /> {messages.openPdf}</button>
          <input ref={fileInput} type="file" accept="application/pdf" hidden onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            void handleFile(file);
          }} />
        </div>
      </header>

      <div className="workspace">
        <aside className={cn("sidebar", !sidebarOpen && "collapsed", sidebarView === "search" && "searching")}>
          <div className="sidebar-head">
            <button className="icon-button" aria-label={messages.toggleSidebar} onClick={() => setSidebarOpen((open) => !open)}>{sidebarOpen ? <PanelLeftClose size={18} /> : <Menu size={18} />}</button>
            {sidebarOpen && (
              <div className="sidebar-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={sidebarView === "pages"}
                  aria-controls="sidebar-pages"
                  className={cn(sidebarView === "pages" && "active")}
                  title={messages.pages}
                  onClick={() => setSidebarView("pages")}
                >
                  <FileText size={14} />
                  <span>{messages.pages}</span>
                </button>
                <button
                  role="tab"
                  aria-selected={sidebarView === "contents"}
                  aria-controls="sidebar-contents"
                  className={cn(sidebarView === "contents" && "active")}
                  title={messages.contentsCount(tocEntries.length)}
                  onClick={() => setSidebarView("contents")}
                >
                  <ListTree size={14} />
                  <span>{messages.contents}</span>
                  {tocEntries.length > 0 && <strong>{tocEntries.length}</strong>}
                </button>
                <button
                  role="tab"
                  aria-selected={sidebarView === "search"}
                  aria-controls="sidebar-search"
                  className={cn(sidebarView === "search" && "active")}
                  title={messages.searchPages}
                  onClick={() => {
                    setSidebarView("search");
                    window.requestAnimationFrame(() => searchInput.current?.focus());
                  }}
                >
                  <Search size={14} />
                  <span>{messages.searchPages}</span>
                </button>
              </div>
            )}
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
              {sidebarView === "pages" ? (
                <nav id="sidebar-pages" className="page-nav" aria-label={messages.pages}>
                  {pageNumbers.map((page) => {
                    const source = translationSources[page];
                    const status = source === "cache"
                      ? messages.translationCacheHit
                      : source === "api" ? messages.translationApiSucceeded : "";
                    return (
                      <button key={page} className={cn(page === currentPage && "active")} onClick={() => goToPage(page)}>
                        <span className="page-thumbnail">{page <= 2 && isDemo ? <SampleScan page={page} messages={messages} /> : page}</span>
                        <span>{messages.page(page)}</span>
                        {source === "cache" ? (
                          <span className="page-translation-status source-cache" title={status} aria-label={status}>
                            CACHE
                          </span>
                        ) : loadingPages.has(page) ? (
                          <span className="page-translation-status loading" title={messages.translationInProgress} aria-label={messages.translationInProgress}>
                            <LoaderCircle className="spin" size={13} aria-hidden="true" />
                          </span>
                        ) : source ? (
                          <span className={cn("page-translation-status", `source-${source}`)} title={status} aria-label={status}>
                            {source.toUpperCase()}
                          </span>
                        ) : translations[page] ? (
                          <CircleCheck size={14} aria-hidden="true" />
                        ) : null}
                      </button>
                    );
                  })}
                </nav>
              ) : sidebarView === "contents" ? (
                <div id="sidebar-contents" className="sidebar-contents">
                  <ContentsNavigation
                    entries={tocEntries}
                    anchors={pageAnchors}
                    manualOffset={navigation.manualOffset}
                    totalPages={totalPages}
                    currentPage={currentPage}
                    loading={navigationLoading}
                    error={navigationError}
                    messages={messages}
                    onNavigate={goToPage}
                    onManualOffsetChange={updateManualOffset}
                  />
                </div>
              ) : (
                <div id="sidebar-search" className="search-panel">
                  <div className="search-field">
                    <Search size={15} />
                    <input
                      ref={searchInput}
                      autoFocus
                      value={searchQuery}
                      placeholder={messages.searchPlaceholder}
                      aria-label={messages.searchPlaceholder}
                      onChange={(event) => {
                        const value = event.target.value;
                        setSearchQuery(value);
                        if (!value.trim()) {
                          setSearchMatches([]);
                          setSearchLoading(false);
                          setSearchError("");
                        }
                      }}
                    />
                    {searchQuery && (
                      <button className="icon-button" aria-label={messages.closeError} onClick={() => {
                        setSearchQuery("");
                        setSearchMatches([]);
                        setSearchLoading(false);
                        setSearchError("");
                        searchInput.current?.focus();
                      }}>
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  {searchQuery.trim() && (
                    <div className="search-summary">
                      {searchLoading ? messages.searching : searchError || messages.searchResults(searchMatches.length)}
                    </div>
                  )}
                  <div className="search-results" role="list">
                    {searchMatches.map((match, index) => (
                      <button key={`${match.page}-${index}`} role="listitem" onClick={() => goToPage(match.page)}>
                        <span><strong>{messages.page(match.page)}</strong></span>
                        <p><HighlightedText text={match.snippet} query={searchQuery} /></p>
                      </button>
                    ))}
                    {!searchLoading && !searchError && searchQuery.trim() && searchMatches.length === 0 && (
                      <p className="search-empty">{messages.noSearchResults}</p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </aside>

        <section className="reader">
          <div className="reader-toolbar">
            <div className="page-stepper">
              <button className="icon-button" onClick={() => goToPage(currentPage - 1, "adjacent")} aria-label={messages.previousPage}><ChevronLeft size={17} /></button>
              <span><strong>{currentPage}</strong> / {totalPages}</span>
              <button className="icon-button" onClick={() => goToPage(currentPage + 1, "adjacent")} aria-label={messages.nextPage}><ChevronRight size={17} /></button>
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
              <button className="secondary-button" onClick={() => setSettingsOpen(true)}>{messages.openSettings}</button>
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
                  workEnabled={isPageWorkEnabled(page, currentPage, settings.nearbyPages, viewportWorkEnabled)}
                  workDistance={Math.abs(page - currentPage)}
                  isDemo={isDemo}
                  translation={displayedTranslations[page]}
                  translationSource={translationSources[page]}
                  animateTranslation={translationSources[page] === "api"
                    && settings.translationAnimation
                    && translationAnimationVersions[page] === displayedTranslations[page]?.cacheVersion}
                  translationAnimationSpeed={settings.translationAnimationSpeed}
                  loading={loadingPages.has(page)}
                  error={errors[page]}
                  renderPage={renderPage}
                  requestTranslation={requestTranslation}
                  onTranslationAnimationComplete={completeTranslationAnimation}
                  setCurrentPage={observeCurrentPage}
                  messages={messages}
                  searchQuery={sidebarView === "search" ? searchQuery.trim() : ""}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="floating-status"><Sparkles size={15} /><span>{messages.contextWindow}</span><strong>{messages.pageRange(Math.max(1, currentPage - 1), Math.min(totalPages, currentPage + 1))}</strong></div>
      {settingsOpen && <SettingsPanel settings={settings} locale={locale} messages={messages} onChange={updateSettings} onClose={() => setSettingsOpen(false)} />}
      {libraryOpen && (
        <BookLibrary
          books={cloudBooks}
          locale={locale}
          messages={messages}
          currentDocumentId={documentId}
          loading={cloudBooksLoading}
          onSelect={(book) => void loadCloudBook(book)}
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
