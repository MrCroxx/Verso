"use client";
/* eslint-disable @next/next/no-img-element */

import {
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  HardDrive,
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
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_AI_PROVIDER_SETTINGS,
  type AiProvider,
  type AiProviderSettingsUpdate,
  type PublicAiProviderSettings,
  type ReasoningEffort,
} from "../lib/ai-provider-settings";
import { LOCAL_PDF_RANGE_CHUNK_SIZE, createLocalPdfRangeTransport } from "../lib/local-pdf-range-transport";
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
import { deduplicatePageBoundary, hasLayoutContent, normalizeTranslationPayload, type LayoutBlock, type SourceRect } from "../lib/translation-layout";
import { searchTranslationPayload } from "../lib/translation-search";
import { groupTranslationMedia, imagePlacement } from "../lib/translation-media";
import { DEFAULT_TYPEWRITER_CHARACTERS_PER_SECOND, typewriterProgress } from "../lib/translation-typewriter";
import type { UiLocale } from "../lib/ui-locale";
import { pageWorkWindow, isPageWorkEnabled, shouldStartTranslationRequest } from "../lib/viewport-work";
import { useUiLocale } from "./ui-locale";
import { SourceImageCrop } from "./source-image-crop";
import { ReaderViewport, READER_PAGE_WIDTH, MIN_READER_ZOOM, MAX_READER_ZOOM } from "./reader-viewport";
import { alignSourceBlocks, type SourcePageLayout } from "../lib/source-alignment";

type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;
type PdfLoadingTask = import("pdfjs-dist").PDFDocumentLoadingTask;
type PdfRenderTask = import("pdfjs-dist").RenderTask;
type PdfWorker = import("pdfjs-dist").PDFWorker;

let pdfJsPromise: Promise<typeof import("pdfjs-dist")> | undefined;
let pdfWorkerPromise: Promise<PdfWorker> | undefined;

function loadPdfJs() {
  pdfJsPromise ??= import("pdfjs-dist").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    return pdfjs;
  });
  return pdfJsPromise;
}

async function loadPdfRuntime() {
  const pdfjs = await loadPdfJs();
  if (!pdfWorkerPromise) {
    const worker = new pdfjs.PDFWorker();
    pdfWorkerPromise = worker.promise.then(() => worker).catch((error) => {
      worker.destroy();
      pdfWorkerPromise = undefined;
      throw error;
    });
  }
  return { pdfjs, worker: await pdfWorkerPromise };
}

type TranslationSettings = {
  targetLanguage: string;
  translationConcurrency: number;
};

type AppSettings = TranslationSettings & {
  schemaVersion: number;
  nearbyPages: number;
  smoothScrolling: boolean;
  translationAnimation: boolean;
  translationAnimationSpeed: number;
};

type TranslationService = PublicAiProviderSettings & {
  loaded: boolean;
};

type LocalBook = {
  id: string;
  fingerprint: string;
  name: string;
  size: number;
  pageCount: number;
  contentType: string;
  uploadedAt: number;
};

type TranslationBlock = LayoutBlock;

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
  serverManaged?: boolean;
  cacheVersion?: number;
  cachedAt?: number;
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
    blankCached: "空白页已保存到本机",
    boundaryFixed: "跨页重复已校正 · 已保存到本机",
    revised: "已结合下一页修订 · 已保存到本机",
    cachedLayout: "译文已保存到本机 · 保留原页布局",
    cached: "译文已保存到本机",
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
    zoomIn: "放大阅读视图",
    zoomOut: "缩小阅读视图",
    fitWidth: "适应宽度",
    readerZoom: "阅读视图缩放",
    readingContext: (page: number) => `正在读取第 ${page} 页及相邻上下文`,
    loadingCachedTranslation: (page: number) => `正在载入第 ${page} 页的缓存译文`,
    retry: "重试",
    settingsDialog: "设置",
    settings: "设置",
    settingsSubtitle: "阅读体验与视觉翻译设置",
    closeSettings: "关闭设置",
    serverProvider: "服务端 AI Provider",
    serverProviderReady: (model: string) => `已保存在服务端 SQLite${model ? ` · ${model}` : ""}`,
    serverProviderMissing: "尚未配置。保存以下服务端配置后即可翻译。",
    provider: "Provider",
    openaiProvider: "OpenAI",
    compatibleProvider: "OpenAI Compatible",
    apiEndpoint: "API Endpoint",
    apiKey: "API Key",
    apiKeyPlaceholder: "输入新的 API Key",
    apiKeyHelp: "密钥只保存在服务端 SQLite；读取设置时不会返回浏览器。留空可保留现有密钥。",
    model: "Model",
    reasoningEffort: "Reasoning Effort",
    saveProvider: "保存 AI Provider",
    savingProvider: "正在保存…",
    providerSaved: "服务端 AI 配置已保存。",
    providerSaveFailed: "无法保存服务端 AI 配置。",
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
    discardBookTranslations: "清空所有译文",
    confirmDiscardBookTranslations: "再次点击，确认清空",
    discardBookTranslationsHelp: "清空本书所有目标语言的译文，并停止后台翻译。",
    cancelDiscardBookTranslations: "取消",
    discardTranslations: "丢弃本书全部译文",
    discardTranslationsHelp: "删除这本书所有目标语言的本地译文缓存，不影响 PDF、目录和页码索引。",
    discardTranslationsConfirm: (name: string) => `确定丢弃《${name}》的全部译文缓存吗？此操作无法撤销。`,
    discardingTranslations: "正在丢弃…",
    translationsDiscarded: (count: number) => `已丢弃 ${count} 页缓存译文。`,
    discardTranslationsFailed: "无法丢弃本书的译文缓存。",
    saveSettings: "保存设置",
    localLibrary: "本地书库",
    translateBook: "后台翻译整本书",
    translateBookAction: "翻译整本书",
    translatingBookAction: "翻译中",
    translatedBookAction: "已翻译",
    retryBookAction: "重试翻译",
    queuePending: "正在加入队列…",
    queueFailed: "翻译失败，点击重试",
    queueCompleted: "整本翻译完成",
    queueProgress: (done: number, total: number) => `后台翻译 · ${done} / ${total} 页`,
    queueReadFailed: "无法读取翻译队列",
    queueHelp: (language: string) => `译为 ${language} · 关闭页面后继续，阅读优先`,
    libraryHomeTitle: "你的书库",
    librarySlogan: "对照原文，跨越语言阅读。",
    bookCoverAlt: (name: string) => `${name} 的封面`,
    openBook: (name: string) => `打开《${name}》`,
    uploadPdf: "上传新 PDF",
    bookCount: (count: number) => `${count} 本`,
    loadingLibrary: "正在读取书库",
    bookMeta: (pages: number, size: string, date: string) => `${pages} 页 · ${size} · ${date}`,
    noBooks: "还没有本地书籍",
    noBooksHelp: "上传 PDF 后会自动出现在这里。",
    openLibrary: "打开本地书库",
    localProgress: (progress: number) => `本地保存 ${progress}%`,
    localCached: "已保存到本机",
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
    pdfReady: "PDF 已加载，但服务端尚未配置 AI Provider。",
    openSettings: "打开设置",
    localIndex: (pages: number) => `已载入本地页码索引 · ${pages} 页`,
    readingIndex: "正在读取 PDF 页码索引",
    connectingRenderer: (name: string) => `已切换到《${name}》，正在连接页面渲染器`,
    rendererFailed: "页面渲染器连接失败",
    rendererFailedHelp: "请从本地书库重新选择，或重新打开 PDF。",
    contextWindow: "上下文窗口",
    pageRange: (start: number, end: number) => `第 ${start}–${end} 页`,
    switchLanguage: "Switch interface to English",
    switchTheme: "切换明暗模式",
    libraryReadFailed: "无法读取本地书库",
    preparingLocal: "正在准备本地存储",
    localBookReused: "本机已有此书，已直接复用",
    uploadSessionMissing: "无法创建本地上传会话",
    partFailed: (part: number) => `分片 ${part} 上传失败`,
    cachingParts: (completed: number, total: number) => `正在保存到本机 · ${completed}/${total}`,
    uploadCompleteFailed: "无法完成本地保存",
    cachedLocal: "已保存到本机",
    uploadFailed: "本地保存失败",
    apiKeyRequired: "服务端尚未配置 AI Provider。",
    invalidTranslation: "模型返回了无效的译文结构。",
    translationFailed: "无法生成译文",
    localTranslationReadFailed: "无法读取本地译文缓存",
    localTranslationWriteFailed: "无法写入本地译文缓存",
    localTranslationDiscardFailed: "无法删除本地译文缓存",
    navigationReadFailed: "无法读取本地目录",
    navigationWriteFailed: "无法写入本地目录",
    translationRequestFailed: "翻译请求失败",
    translationCacheHit: "已从本地译文缓存载入",
    translationApiSucceeded: "API 翻译成功",
    translationInProgress: "正在读取或生成译文",
    openPdfFailed: (detail: string) => `无法打开这个 PDF：${detail}`,
    openedFromLocal: "已从本地书库打开",
    openLocalFailed: (detail: string) => `无法打开本地 PDF：${detail}`,
  },
  "en-US": {
    blankPage: "No translatable text on this page",
    blankCached: "Blank page saved locally",
    boundaryFixed: "Cross-page overlap fixed · Saved locally",
    revised: "Revised with the next page · Saved locally",
    cachedLayout: "Translation saved locally · Source layout preserved",
    cached: "Translation saved locally",
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
    zoomIn: "Zoom in reading view",
    zoomOut: "Zoom out reading view",
    fitWidth: "Fit width",
    readerZoom: "Reading view zoom",
    readingContext: (page: number) => `Reading page ${page} and adjacent context`,
    loadingCachedTranslation: (page: number) => `Loading cached translation for page ${page}`,
    retry: "Retry",
    settingsDialog: "Settings",
    settings: "Settings",
    settingsSubtitle: "Reading and vision translation preferences",
    closeSettings: "Close settings",
    serverProvider: "Server AI provider",
    serverProviderReady: (model: string) => `Stored in server-side SQLite${model ? ` · ${model}` : ""}`,
    serverProviderMissing: "Not configured. Save the server settings below to enable translation.",
    provider: "Provider",
    openaiProvider: "OpenAI",
    compatibleProvider: "OpenAI Compatible",
    apiEndpoint: "API Endpoint",
    apiKey: "API Key",
    apiKeyPlaceholder: "Enter a new API key",
    apiKeyHelp: "The key is stored only in server-side SQLite and is never returned when settings are read. Leave blank to keep the current key.",
    model: "Model",
    reasoningEffort: "Reasoning effort",
    saveProvider: "Save AI provider",
    savingProvider: "Saving…",
    providerSaved: "Server AI settings saved.",
    providerSaveFailed: "Unable to save server AI settings.",
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
    discardBookTranslations: "Drop all translations",
    confirmDiscardBookTranslations: "Click again to confirm",
    discardBookTranslationsHelp: "Clear translations in every target language and stop background translation for this book.",
    cancelDiscardBookTranslations: "Cancel",
    discardTranslations: "Discard all translations for this book",
    discardTranslationsHelp: "Delete cached translations in every target language for this book. The PDF, contents, and page index are preserved.",
    discardTranslationsConfirm: (name: string) => `Discard every cached translation for “${name}”? This cannot be undone.`,
    discardingTranslations: "Discarding…",
    translationsDiscarded: (count: number) => `Discarded cached translations for ${count} page${count === 1 ? "" : "s"}.`,
    discardTranslationsFailed: "Unable to discard translations for this book.",
    saveSettings: "Save settings",
    localLibrary: "Local Library",
    translateBook: "Translate entire book",
    translateBookAction: "Translate book",
    translatingBookAction: "Translating",
    translatedBookAction: "Translated",
    retryBookAction: "Retry translation",
    queuePending: "Adding to queue…",
    queueFailed: "Translation failed · Retry",
    queueCompleted: "Book translation complete",
    queueProgress: (done: number, total: number) => `Translating · ${done} / ${total} pages`,
    queueReadFailed: "Unable to read translation queue",
    queueHelp: (language: string) => `Into ${language} · Continues after closing, reading takes priority`,
    libraryHomeTitle: "Your library",
    librarySlogan: "See the original. Read beyond language.",
    bookCoverAlt: (name: string) => `Cover of ${name}`,
    openBook: (name: string) => `Open ${name}`,
    uploadPdf: "Upload a new PDF",
    bookCount: (count: number) => `${count} book${count === 1 ? "" : "s"}`,
    loadingLibrary: "Loading library",
    bookMeta: (pages: number, size: string, date: string) => `${pages} pages · ${size} · ${date}`,
    noBooks: "No local books yet",
    noBooksHelp: "Uploaded PDFs will appear here.",
    openLibrary: "Open local library",
    localProgress: (progress: number) => `Local save ${progress}%`,
    localCached: "Saved locally",
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
    pdfReady: "PDF loaded, but the AI provider is not configured on the server.",
    openSettings: "Open settings",
    localIndex: (pages: number) => `Local page index loaded · ${pages} pages`,
    readingIndex: "Reading PDF page index",
    connectingRenderer: (name: string) => `Switched to “${name}”; connecting the page renderer`,
    rendererFailed: "Page renderer connection failed",
    rendererFailedHelp: "Select the book again from the local library or reopen the PDF.",
    contextWindow: "Context window",
    pageRange: (start: number, end: number) => `Pages ${start}–${end}`,
    switchLanguage: "切换界面为简体中文",
    switchTheme: "Toggle light or dark mode",
    libraryReadFailed: "Unable to read the local library",
    preparingLocal: "Preparing local storage",
    localBookReused: "This book is already stored locally and will be reused",
    uploadSessionMissing: "Unable to create a local upload session",
    partFailed: (part: number) => `Failed to upload part ${part}`,
    cachingParts: (completed: number, total: number) => `Saving locally · ${completed}/${total}`,
    uploadCompleteFailed: "Unable to complete local save",
    cachedLocal: "Saved locally",
    uploadFailed: "Local save failed",
    apiKeyRequired: "The AI provider is not configured on the server.",
    invalidTranslation: "The model returned an invalid translation structure.",
    translationFailed: "Unable to generate translation",
    localTranslationReadFailed: "Unable to read the local translation cache",
    localTranslationWriteFailed: "Unable to write the local translation cache",
    localTranslationDiscardFailed: "Unable to delete the local translation cache",
    navigationReadFailed: "Unable to read local contents",
    navigationWriteFailed: "Unable to write local contents",
    translationRequestFailed: "Translation request failed",
    translationCacheHit: "Loaded from the local translation cache",
    translationApiSucceeded: "API translation succeeded",
    translationInProgress: "Loading or generating translation",
    openPdfFailed: (detail: string) => `Unable to open this PDF: ${detail}`,
    openedFromLocal: "Opened from local library",
    openLocalFailed: (detail: string) => `Unable to open local PDF: ${detail}`,
  },
} as const;

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
  schemaVersion: 2,
  targetLanguage: "Simplified Chinese",
  nearbyPages: 2,
  translationConcurrency: 4,
  smoothScrolling: true,
  translationAnimation: true,
  translationAnimationSpeed: DEFAULT_TYPEWRITER_CHARACTERS_PER_SECOND,
};

const EMPTY_TRANSLATION_SERVICE: TranslationService = {
  ...DEFAULT_AI_PROVIDER_SETTINGS,
  loaded: false,
  configured: false,
  apiKeyConfigured: false,
  apiKeyHint: "",
  updatedAt: 0,
};

const translationLimiter = createConcurrencyLimiter();
let latestTranslationVersion = Date.now() * 1000;
const EMPTY_NAVIGATION: DocumentNavigation = { observations: [], manualOffset: null };
const BOOK_QUERY_PARAMETER = "book";

function bookIdFromUrl() {
  return new URL(window.location.href).searchParams.get(BOOK_QUERY_PARAMETER)?.trim() || null;
}

function updateBookInUrl(bookId: string | null, mode: "push" | "replace" = "replace") {
  const url = new URL(window.location.href);
  if (bookId) url.searchParams.set(BOOK_QUERY_PARAMETER, bookId);
  else url.searchParams.delete(BOOK_QUERY_PARAMETER);
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  if (mode === "push") window.history.pushState(window.history.state, "", nextUrl);
  else window.history.replaceState(window.history.state, "", nextUrl);
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

function cacheKey(documentId: string, page: number, settings: TranslationSettings) {
  return ["layout-v3", documentId, page, cacheKeySuffix(settings)].join("::");
}

function cacheKeySuffix(settings: TranslationSettings) {
  return ["server-v1", settings.targetLanguage].join("::");
}

async function readLocalCache(
  key: string,
  documentId: string,
  page: number,
  settings: TranslationSettings,
  fallbackMessage: string,
  signal?: AbortSignal,
): Promise<Translation | undefined> {
  const query = new URLSearchParams({
    key,
    documentId,
    page: String(page),
    fallbackCacheKeySuffix: settings.targetLanguage,
  });
  const response = await fetch(`/api/translations?${query}`, { cache: "no-store", signal });
  const result = await response.json() as { translation?: Translation | null; error?: string };
  if (!response.ok) throw new Error(result.error || fallbackMessage);
  return result.translation ? normalizeTranslationPayload(result.translation) as Translation : undefined;
}

async function readLocalTranslationIndex(
  documentId: string,
  settings: TranslationSettings,
  fallbackMessage: string,
): Promise<number[]> {
  const query = new URLSearchParams({
    documentId,
    cacheKeySuffix: cacheKeySuffix(settings),
    fallbackCacheKeySuffix: settings.targetLanguage,
  });
  const response = await fetch(`/api/translations?${query}`, { cache: "no-store" });
  const result = await response.json() as { pages?: unknown; error?: string };
  if (!response.ok) throw new Error(result.error || fallbackMessage);
  return Array.isArray(result.pages)
    ? result.pages.map(Number).filter((page) => Number.isSafeInteger(page) && page > 0)
    : [];
}

async function readLocalBook(id: string, fallbackMessage: string): Promise<LocalBook> {
  const response = await fetch(`/api/books/${encodeURIComponent(id)}`, { cache: "no-store" });
  const result = await response.json() as { book?: LocalBook; error?: string };
  if (!response.ok || !result.book) throw new Error(result.error || fallbackMessage);
  return result.book;
}

async function writeLocalCache(
  key: string,
  documentId: string,
  page: number,
  translation: Translation,
  fallbackMessage: string,
) {
  const response = await fetch("/api/translations", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, documentId, page, translation }),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error || fallbackMessage);
}

async function deleteLocalTranslations(documentId: string, fallbackMessage: string) {
  const query = new URLSearchParams({ documentId });
  const response = await fetch(`/api/translations?${query}`, { method: "DELETE" });
  const result = await response.json() as { deleted?: number; error?: string };
  if (!response.ok) throw new Error(result.error || fallbackMessage);
  return Number(result.deleted) || 0;
}

async function readLocalNavigation(documentId: string, fallbackMessage: string): Promise<DocumentNavigation> {
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

async function writeLocalNavigationObservation(
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

async function writeLocalManualOffset(documentId: string, manualOffset: number | null, fallbackMessage: string) {
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
    isBlank: !hasLayoutContent(result.blocks),
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

function MappedTranslationText({ block, query, offset, progress, onHighlight }: {
  block: TranslationBlock;
  query: string;
  offset: number;
  progress: number;
  onHighlight: (rects: SourceRect[]) => void;
}) {
  if (!block.sentences?.length) {
    return <TypewriterText text={block.text} query={query} offset={offset} progress={progress} />;
  }
  const sentences = block.sentences;
  return sentences.map((sentence, index) => {
    const start = offset + sentences.slice(0, index).reduce((sum, item) => sum + Array.from(item.text).length, 0);
    const interactive = sentence.sourceRects.length > 0 && progress > start;
    return (
      <span
        key={index}
        className={interactive ? "translation-sentence" : undefined}
        tabIndex={interactive ? 0 : undefined}
        title={interactive ? sentence.sourceText : undefined}
        onMouseEnter={() => onHighlight(interactive ? sentence.sourceRects : [])}
        onMouseLeave={() => onHighlight([])}
        onFocus={() => onHighlight(interactive ? sentence.sourceRects : [])}
        onBlur={() => onHighlight([])}
      >
        <TypewriterText text={sentence.text} query={query} offset={start} progress={progress} />
      </span>
    );
  });
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
  sourceRaster,
  onHighlight,
}: {
  sourceRaster: HTMLImageElement | HTMLCanvasElement | null;
  onHighlight: (rects: SourceRect[]) => void;
  value: Translation;
  messages: UiMessages;
  searchQuery: string;
  animate: boolean;
  animationActive: boolean;
  animationSpeed: number;
  onAnimationComplete: () => void;
}) {
  const displayBlocks = useMemo(() => groupTranslationMedia(value.blocks ?? []), [value.blocks]);
  const texts = value.blocks?.length
    ? displayBlocks.flatMap(({ block, caption }) => {
      if (caption) return [caption.text];
      if (block.kind === "spacer" || block.kind === "image") return [];
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
          {displayBlocks.map(({ block, index, caption, captionRect, captionPosition, spaceBefore }) => {
            const className = cn(
              "layout-block",
              `block-${block.kind}`,
              `align-${block.align}`,
              `indent-${Math.min(3, Math.max(0, block.indent))}`,
              `before-${spaceBefore}`,
              `size-${block.size}`,
            );
            if (block.kind === "spacer") {
              return <div key={index} className={className} aria-hidden="true" />;
            }
            if (block.kind === "image") {
              const captionIndex = segmentIndex;
              if (caption) segmentIndex++;
              return block.sourceRect ? (
                <SourceImageCrop
                  key={index}
                  source={sourceRaster}
                  rect={block.sourceRect}
                  className={className}
                  alt={messages.scannedSourceAlt(value.page)}
                  captionPosition={captionPosition}
                  captionRect={captionRect}
                  captionSize={caption?.size}
                  captionFontSize={caption?.fontSize ? caption.fontSize * READER_PAGE_WIDTH : undefined}
                  placement={imagePlacement(block, Boolean(caption))}
                  caption={caption && (
                    <MappedTranslationText block={caption} query={searchQuery} offset={offsets[captionIndex] ?? 0} progress={progress} onHighlight={onHighlight} />
                  )}
                />
              ) : null;
            }
            const style = block.fontSize ? { fontSize: block.fontSize * READER_PAGE_WIDTH } : undefined;
            if (block.kind === "list_item") {
              const markerIndex = segmentIndex++;
              const textIndex = segmentIndex++;
              const trailingIndex = segmentIndex++;
              return (
                <div key={index} className={className} style={style}>
                  <span className="block-marker">
                    <TypewriterText text={block.marker} query="" offset={offsets[markerIndex] ?? 0} progress={progress} />
                  </span>
                  <span className="block-text">
                    <MappedTranslationText block={block} query={searchQuery} offset={offsets[textIndex] ?? 0} progress={progress} onHighlight={onHighlight} />
                  </span>
                  <span className="block-trailing">
                    <TypewriterText text={block.trailing} query="" offset={offsets[trailingIndex] ?? 0} progress={progress} />
                  </span>
                </div>
              );
            }
            const currentTextIndex = segmentIndex++;
            const content = (
              <MappedTranslationText
                block={block}
                onHighlight={onHighlight}
                query={searchQuery}
                offset={offsets[currentTextIndex] ?? 0}
                progress={progress}
              />
            );
            if (block.kind === "heading") {
              return <h2 key={index} className={className} style={style}>{content}</h2>;
            }
            return <p key={index} className={className} style={style}>{content}</p>;
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
        {cached ? <HardDrive size={15} /> : <Sparkles size={15} />}
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
  pageImageUrl?: string;
  renderPageToCanvas: (page: number, canvas: HTMLCanvasElement, signal: AbortSignal) => Promise<void>;
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
  pageImageUrl,
  renderPageToCanvas,
  requestTranslation,
  onTranslationAnimationComplete,
  setCurrentPage,
  messages,
  searchQuery,
}: PageSpreadProps) {
  const { ref, near } = useNearViewport(`${Math.max(1, nearbyPages) * 720}px 0px`);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [sourceActive, setSourceActive] = useState(false);
  const [sourceLayout, setSourceLayout] = useState<SourcePageLayout | null>(null);
  const alignedTranslation = useMemo(() => translation?.blocks ? {
    ...translation,
    blocks: sourceLayout ? alignSourceBlocks(translation.blocks, sourceLayout) : translation.blocks.map((block) => ({
      ...block, sentences: block.sentences?.map((sentence) => ({ ...sentence, sourceRects: [] })),
    })),
  } : translation, [translation, sourceLayout]);
  const needsAlignment = Boolean(translation?.blocks?.some((block) => block.text.trim()));
  useEffect(() => {
    if (!sourceActive || !pageImageUrl || !needsAlignment) return;
    const controller = new AbortController();
    const url = `${pageImageUrl.split("?")[0]}/layout`;
    void fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const layout = await response.json() as SourcePageLayout;
        if (!controller.signal.aborted) setSourceLayout(layout);
      }).catch(() => undefined);
    return () => controller.abort();
  }, [sourceActive, pageImageUrl, needsAlignment]);
  const [sourceReady, setSourceReady] = useState(false);
  const [sourceAspectRatio, setSourceAspectRatio] = useState("1 / 1.4142");
  const [sourceRaster, setSourceRaster] = useState<HTMLImageElement | HTMLCanvasElement | null>(null);
  const [highlight, setHighlight] = useState<{ translation: Translation | undefined; rects: SourceRect[] } | null>(null);
  const highlightSource = useCallback((rects: SourceRect[]) => setHighlight({ translation, rects }), [translation]);
  const highlightRects = sourceReady && highlight?.translation === translation ? highlight?.rects ?? [] : [];
  const [serverImageFailed, setServerImageFailed] = useState(false);
  const [renderError, setRenderError] = useState("");
  const [renderAttempt, setRenderAttempt] = useState(0);
  const cachedTranslation = translationSource === "cache";
  const finishTranslationAnimation = useCallback(
    () => onTranslationAnimationComplete(page, translation?.cacheVersion),
    [onTranslationAnimationComplete, page, translation?.cacheVersion],
  );

  useEffect(() => {
    if (isDemo) return;
    if (!near) {
      const releaseSource = window.setTimeout(() => {
        setSourceActive(false);
        setSourceReady(false);
        setSourceRaster(null);
        setSourceLayout(null);
        setHighlight(null);
        setServerImageFailed(false);
        setRenderError("");
      }, 500);
      return () => window.clearTimeout(releaseSource);
    }
    if (!workEnabled) return;

    let timer: number | undefined;
    const activate = () => setSourceActive(true);
    if (workDistance === 0) activate();
    else timer = window.setTimeout(activate, workDistance * 180);
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [isDemo, near, workDistance, workEnabled]);

  useEffect(() => {
    if (isDemo || !sourceActive || (pageImageUrl && !serverImageFailed)) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const controller = new AbortController();
    setSourceReady(false);
    setRenderError("");
    void renderPageToCanvas(page, canvas, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) {
          setSourceReady(true);
          setSourceRaster(canvas);
          setSourceAspectRatio(`${canvas.width} / ${canvas.height}`);
        }
      })
      .catch((error) => {
        if (controller.signal.aborted || isWorkCancellation(error)) return;
        setRenderError(error instanceof Error ? error.message : "Unknown page rendering error");
      });
    return () => controller.abort();
  }, [isDemo, page, pageImageUrl, renderAttempt, renderPageToCanvas, serverImageFailed, sourceActive]);

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
        <div className="source-raster" style={isDemo ? undefined : { aspectRatio: sourceAspectRatio }}>
          {isDemo ? (
            <SampleScan page={page} messages={messages} />
          ) : renderError ? (
            <div className="page-render-error">
              <strong>{messages.scanFailed}</strong>
              <p>{renderError}</p>
              <button className="secondary-button" onClick={() => {
                setRenderError("");
                setRenderAttempt((attempt) => attempt + 1);
              }}>{messages.retryRender}</button>
            </div>
          ) : sourceActive && pageImageUrl && !serverImageFailed ? (
            <>
              <img
                src={pageImageUrl}
                alt={messages.scannedSourceAlt(page)}
                decoding="async"
                fetchPriority={workDistance === 0 ? "high" : "auto"}
                style={{ display: sourceReady ? "block" : "none" }}
                onLoad={(event) => {
                  setSourceReady(true);
                  setSourceRaster(event.currentTarget);
                  setSourceAspectRatio(`${event.currentTarget.naturalWidth} / ${event.currentTarget.naturalHeight}`);
                }}
                onError={() => {
                  setSourceReady(false);
                  setServerImageFailed(true);
                }}
              />
              {!sourceReady && <div className="page-loading"><LoaderCircle className="spin" size={24} /> {messages.renderingScan}</div>}
            </>
          ) : sourceActive ? (
            <>
              <canvas
                ref={canvasRef}
                role="img"
                aria-label={messages.scannedSourceAlt(page)}
                style={{ display: sourceReady ? "block" : "none" }}
              />
              {!sourceReady && <div className="page-loading"><LoaderCircle className="spin" size={24} /> {messages.renderingScan}</div>}
            </>
          ) : (
            <div className="page-loading"><LoaderCircle className="spin" size={24} /> {messages.renderingScan}</div>
          )}
          <div className="source-highlights" aria-hidden="true">
            {highlightRects.map((rect, index) => (
              <span key={index} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />
            ))}
          </div>
        </div>
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
            value={alignedTranslation!}
            sourceRaster={sourceReady ? sourceRaster : null}
            onHighlight={highlightSource}
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
  translationService,
  currentBookName,
  canDiscardTranslations,
  locale,
  messages,
  onChange,
  onProviderSave,
  onDiscardTranslations,
  onClose,
}: {
  settings: AppSettings;
  translationService: TranslationService;
  currentBookName: string;
  canDiscardTranslations: boolean;
  locale: UiLocale;
  messages: UiMessages;
  onChange: (next: AppSettings) => void;
  onProviderSave: (settings: AiProviderSettingsUpdate) => Promise<void>;
  onDiscardTranslations: () => Promise<number>;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState<AiProvider>(translationService.provider);
  const [endpoint, setEndpoint] = useState(translationService.endpoint);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(translationService.model);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(translationService.reasoningEffort);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerMessage, setProviderMessage] = useState("");
  const [providerSaveFailed, setProviderSaveFailed] = useState(false);
  const [discardingTranslations, setDiscardingTranslations] = useState(false);
  const [discardMessage, setDiscardMessage] = useState("");
  const [discardFailed, setDiscardFailed] = useState(false);

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  async function saveProvider() {
    setProviderSaving(true);
    setProviderMessage("");
    setProviderSaveFailed(false);
    try {
      await onProviderSave({ provider, endpoint, apiKey, model, reasoningEffort });
      setApiKey("");
      setProviderMessage(messages.providerSaved);
    } catch {
      setProviderSaveFailed(true);
      setProviderMessage(messages.providerSaveFailed);
    } finally {
      setProviderSaving(false);
    }
  }

  async function discardTranslations() {
    if (!window.confirm(messages.discardTranslationsConfirm(currentBookName))) return;
    setDiscardingTranslations(true);
    setDiscardMessage("");
    setDiscardFailed(false);
    try {
      const deleted = await onDiscardTranslations();
      setDiscardMessage(messages.translationsDiscarded(deleted));
    } catch {
      setDiscardFailed(true);
      setDiscardMessage(messages.discardTranslationsFailed);
    } finally {
      setDiscardingTranslations(false);
    }
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="settings-panel" role="dialog" aria-modal="true" aria-label={messages.settingsDialog} onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-title">
          <div><span>{messages.settings}</span><p>{messages.settingsSubtitle}</p></div>
          <button className="icon-button" onClick={onClose} aria-label={messages.closeSettings}><X size={18} /></button>
        </div>

        <div className={cn("server-provider-status", translationService.configured ? "ready" : "missing")}>
          <HardDrive size={17} />
          <div>
            <strong>{messages.serverProvider}</strong>
            <p>
              {translationService.configured
                ? messages.serverProviderReady(translationService.model)
                : messages.serverProviderMissing}
            </p>
          </div>
        </div>

        <label className="field-label">{messages.provider}</label>
        <div className="segmented">
          {(["openai", "compatible"] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={cn(provider === value && "active")}
              onClick={() => {
                setProvider(value);
                if (value === "openai" && !endpoint.trim()) setEndpoint(DEFAULT_AI_PROVIDER_SETTINGS.endpoint);
              }}
            >
              {value === "openai" ? messages.openaiProvider : messages.compatibleProvider}
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="api-endpoint">{messages.apiEndpoint}</label>
        <input id="api-endpoint" type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} />

        <label className="field-label" htmlFor="api-key">{messages.apiKey}</label>
        <input
          id="api-key"
          type="password"
          autoComplete="new-password"
          value={apiKey}
          placeholder={translationService.apiKeyHint || messages.apiKeyPlaceholder}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <p className="field-help">{messages.apiKeyHelp}</p>

        <div className="field-grid">
          <div>
            <label className="field-label" htmlFor="ai-model">{messages.model}</label>
            <input id="ai-model" value={model} onChange={(event) => setModel(event.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="reasoning-effort">{messages.reasoningEffort}</label>
            <select
              id="reasoning-effort"
              value={reasoningEffort}
              onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)}
            >
              {(["none", "low", "medium", "high", "xhigh", "max"] as const).map((effort) => (
                <option key={effort} value={effort}>{effort}</option>
              ))}
            </select>
          </div>
        </div>
        <button
          type="button"
          className="secondary-button full provider-save-button"
          disabled={providerSaving}
          onClick={() => void saveProvider()}
        >
          {providerSaving ? messages.savingProvider : messages.saveProvider}
        </button>
        {providerMessage && (
          <p className={cn("provider-save-message", providerSaveFailed && "error")}>{providerMessage}</p>
        )}

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
        {canDiscardTranslations && (
          <div className="translation-cache-actions">
            <div>
              <strong>{messages.discardTranslations}</strong>
              <p>{messages.discardTranslationsHelp}</p>
            </div>
            <button
              type="button"
              className="danger-button full"
              disabled={discardingTranslations}
              onClick={() => void discardTranslations()}
            >
              {discardingTranslations ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}
              {discardingTranslations ? messages.discardingTranslations : messages.discardTranslations}
            </button>
            {discardMessage && (
              <p className={cn("discard-message", discardFailed && "error")}>{discardMessage}</p>
            )}
          </div>
        )}
        <button className="primary-button full" onClick={onClose}>{messages.saveSettings}</button>
      </aside>
    </div>
  );
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

type BookTranslationJob = { documentId: string; status: string; error: string | null; completedPages: number; totalPages: number };

function LibraryHome({
  books,
  locale,
  messages,
  loading,
  error,
  translationSettings,
  onDiscardTranslations,
  onSelect,
  onUpload,
  onRetry,
  onOpenSettings,
  onToggleLocale,
  onToggleTheme,
  theme,
}: {
  books: LocalBook[];
  translationSettings: TranslationSettings;
  locale: UiLocale;
  messages: UiMessages;
  loading: boolean;
  error: string;
  onDiscardTranslations: (book: LocalBook) => Promise<number>;
  onSelect: (book: LocalBook) => void;
  onUpload: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
  onToggleLocale: () => void;
  onToggleTheme: () => void;
  theme: ThemeMode;
}) {
  const [jobs, setJobs] = useState<BookTranslationJob[]>([]);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [queueErrors, setQueueErrors] = useState<Record<string, string>>({});
  const [queueError, setQueueError] = useState("");
  const [openActionsId, setOpenActionsId] = useState<string | null>(null);
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<Set<string>>(new Set());
  const [discardMessages, setDiscardMessages] = useState<Record<string, string>>({});
  const [discardErrors, setDiscardErrors] = useState<Record<string, string>>({});
  const language = translationSettings.targetLanguage;
  const refreshQueue = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/translation-queue?${new URLSearchParams({ targetLanguage: language })}`, { signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || messages.queueReadFailed);
    if (signal?.aborted) return;
    setJobs(result.jobs);
    setQueueError("");
  }, [language, messages.queueReadFailed]);
  useEffect(() => {
    const controller = new AbortController();
    setJobs([]);
    const refresh = () => void refreshQueue(controller.signal).catch((error) => {
      if (!controller.signal.aborted) setQueueError(error instanceof Error ? error.message : messages.queueReadFailed);
    });
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [refreshQueue, messages.queueReadFailed]);
  useEffect(() => {
    if (confirmDiscardId) document.getElementById(`discard-confirm-${confirmDiscardId}`)?.focus();
  }, [confirmDiscardId]);
  useEffect(() => {
    if (!openActionsId) return;
    const closeOutside = (event: PointerEvent) => {
      const actions = document.getElementById(`book-actions-${openActionsId}`)?.parentElement;
      if (!actions?.contains(event.target as Node)) {
        setOpenActionsId(null);
        setConfirmDiscardId(null);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [openActionsId]);
  const discardTranslations = async (book: LocalBook) => {
    if (discarding.has(book.id) || pending.has(book.id)) return;
    if (confirmDiscardId !== book.id) {
      setConfirmDiscardId(book.id);
      setDiscardMessages((value) => ({ ...value, [book.id]: "" }));
      setDiscardErrors((value) => ({ ...value, [book.id]: "" }));
      return;
    }
    setConfirmDiscardId(null);
    setOpenActionsId(null);
    setDiscarding((value) => new Set(value).add(book.id));
    try {
      const deleted = await onDiscardTranslations(book);
      setJobs((value) => value.filter((job) => job.documentId !== book.fingerprint));
      setQueueErrors((value) => ({ ...value, [book.id]: "" }));
      setDiscardMessages((value) => ({ ...value, [book.id]: messages.translationsDiscarded(deleted) }));
      await refreshQueue().catch((error) => {
        setQueueError(error instanceof Error ? error.message : messages.queueReadFailed);
      });
    } catch (error) {
      setDiscardErrors((value) => ({ ...value, [book.id]: error instanceof Error ? error.message : messages.discardTranslationsFailed }));
    } finally {
      setDiscarding((value) => { const next = new Set(value); next.delete(book.id); return next; });
    }
  };
  const enqueue = async (book: LocalBook) => {
    setOpenActionsId(null);
    setConfirmDiscardId(null);
    setDiscardMessages((value) => ({ ...value, [book.id]: "" }));
    setPending((value) => new Set(value).add(book.id));
    setQueueErrors((value) => ({ ...value, [book.id]: "" }));
    try {
      const response = await fetch("/api/translation-queue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId: book.id, targetLanguage: language, translationConcurrency: translationSettings.translationConcurrency }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || messages.queueFailed);
      await refreshQueue();
    } catch (error) {
      setQueueErrors((value) => ({ ...value, [book.id]: error instanceof Error ? error.message : messages.queueFailed }));
    } finally {
      setPending((value) => { const next = new Set(value); next.delete(book.id); return next; });
    }
  };
  return (
    <>
      <header className="topbar library-topbar">
        <div className="brand"><div className="brand-mark">V</div><span>Verso</span><em>AI Reader</em></div>
        <div className="top-actions">
          <button className="icon-button locale-button" title={messages.switchLanguage} aria-label={messages.switchLanguage} onClick={onToggleLocale}><Globe2 size={16} /><span>{locale === "zh-CN" ? "EN" : "中"}</span></button>
          <button className="icon-button" title={messages.switchTheme} aria-label={messages.switchTheme} aria-pressed={theme === "dark"} onClick={onToggleTheme}>{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</button>
          <button className="secondary-button" onClick={onOpenSettings}><Settings2 size={16} /> {messages.settings}</button>
          <button className="primary-button" onClick={onUpload}><Plus size={16} /><span className="action-label">{messages.uploadPdf}</span></button>
        </div>
      </header>
      <section className="library-home" aria-labelledby="library-title">
        <div className="library-hero">
          <div>
            <p>{messages.localLibrary}</p>
            <h1 id="library-title">{messages.libraryHomeTitle}</h1>
            <span>{messages.librarySlogan}</span>
          </div>
          <strong>{messages.bookCount(books.length)}</strong>
        </div>
        {books.length > 0 && (
          <p className="library-translation-note"><Languages size={14} /><span>{messages.queueHelp(language)}</span></p>
        )}
        {queueError && <p role="alert" className="queue-error">{queueError}</p>}
        {loading ? (
          <div className="library-home-empty"><LoaderCircle className="spin" size={24} /><strong>{messages.loadingLibrary}</strong></div>
        ) : error ? (
          <div className="library-home-empty library-home-error" role="alert">
            <span><X size={28} /></span>
            <strong>{messages.libraryReadFailed}</strong>
            <p>{error}</p>
            <button className="secondary-button" onClick={onRetry}><RefreshCw size={15} />{messages.retry}</button>
          </div>
        ) : books.length ? (
          <div className="library-grid">
            {books.map((book) => {
              const job = jobs.find((value) => value.documentId === book.fingerprint);
              const active = job?.status === "queued" || job?.status === "running";
              const complete = job?.status === "completed" && job.completedPages === job.totalPages;
              return (
              <article className={cn("library-book-card", openActionsId === book.id && "book-actions-open")} key={book.id}>
              <button
                className="library-book"
                onClick={() => { setOpenActionsId(null); setConfirmDiscardId(null); onSelect(book); }}
                disabled={discarding.has(book.id)}
                aria-label={messages.openBook(book.name.replace(/\.pdf$/i, ""))}
              >
                <span className="library-cover">
                  <BookOpen size={28} />
                  <img
                    src={`/api/books/${encodeURIComponent(book.id)}/pages/1?profile=thumbnail`}
                    alt={messages.bookCoverAlt(book.name.replace(/\.pdf$/i, ""))}
                    loading="lazy"
                    onError={(event) => { event.currentTarget.hidden = true; }}
                  />
                </span>
                <span className="library-book-copy">
                  <strong>{book.name.replace(/\.pdf$/i, "")}</strong>
                  <small>{messages.bookMeta(book.pageCount, formatFileSize(book.size), new Date(book.uploadedAt).toLocaleDateString(locale))}</small>
                </span>
              </button>
              <div className="book-translation">
                <div className="book-actions" onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    setOpenActionsId((value) => value === book.id ? null : value);
                    setConfirmDiscardId((value) => value === book.id ? null : value);
                  }
                }} onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setOpenActionsId(null);
                    setConfirmDiscardId(null);
                    event.currentTarget.querySelector<HTMLButtonElement>(".book-more-action")?.focus();
                  }
                }}>
                  <button type="button" className="book-translate-action"
                    disabled={pending.has(book.id) || discarding.has(book.id) || active || complete}
                    title={messages.translateBook} onClick={() => void enqueue(book)}>
                    {active || pending.has(book.id) ? <LoaderCircle className="spin" size={14} />
                      : complete ? <CircleCheck size={14} /> : <Languages size={14} />}
                    <span>{pending.has(book.id) || active ? messages.translatingBookAction
                      : complete ? messages.translatedBookAction : job?.status === "failed" ? messages.retryBookAction : messages.translateBookAction}</span>
                  </button>
                  <button type="button" className="icon-button book-more-action" id={`book-more-${book.id}`}
                    aria-label={messages.moreOptions} title={messages.moreOptions}
                    aria-expanded={openActionsId === book.id} aria-controls={`book-actions-${book.id}`}
                    disabled={pending.has(book.id) || discarding.has(book.id)}
                    onClick={() => {
                      setOpenActionsId((value) => value === book.id ? null : book.id);
                      setConfirmDiscardId(null);
                    }}>
                    {discarding.has(book.id) ? <LoaderCircle className="spin" size={16} /> : <MoreHorizontal size={18} />}
                  </button>
                  {openActionsId === book.id && (
                    <div className="book-actions-popover" id={`book-actions-${book.id}`} role="group" aria-label={messages.moreOptions}>
                      {confirmDiscardId === book.id ? (
                        <>
                          <p id={`discard-help-${book.id}`}>{messages.discardBookTranslationsHelp}</p>
                          <button type="button" className="danger-button book-confirm-discard" id={`discard-confirm-${book.id}`}
                            aria-describedby={`discard-help-${book.id}`} onClick={() => void discardTranslations(book)}>
                            <Trash2 size={14} />{messages.confirmDiscardBookTranslations}
                          </button>
                          <button type="button" className="book-cancel-discard" onClick={() => {
                            setConfirmDiscardId(null);
                            setOpenActionsId(null);
                            document.getElementById(`book-more-${book.id}`)?.focus();
                          }}>{messages.cancelDiscardBookTranslations}</button>
                        </>
                      ) : (
                        <button type="button" className="book-discard-action" onClick={() => void discardTranslations(book)}>
                          <Trash2 size={14} />{messages.discardBookTranslations}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {job && !complete && (
                  <div className="book-translation-progress">
                    <small>{messages.queueProgress(job.completedPages, job.totalPages)}</small>
                    <progress max={job.totalPages} value={job.completedPages} aria-label={messages.queueProgress(job.completedPages, job.totalPages)} />
                  </div>
                )}
                {(queueErrors[book.id] || job?.error) && <p className="queue-error" role="alert">{queueErrors[book.id] || job?.error}</p>}
                {discardMessages[book.id] && <small role="status">{discardMessages[book.id]}</small>}
                {discardErrors[book.id] && <p className="queue-error" role="alert">{discardErrors[book.id]}</p>}
              </div>
              </article>
            ); })}
          </div>
        ) : (
          <div className="library-home-empty">
            <span><BookOpen size={30} /></span>
            <strong>{messages.noBooks}</strong>
            <p>{messages.noBooksHelp}</p>
            <button className="primary-button" onClick={onUpload}><Plus size={16} />{messages.uploadPdf}</button>
          </div>
        )}
      </section>
    </>
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
  const readerMenu = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PdfDocument | undefined>(undefined);
  const pdfLoadingTaskRef = useRef<PdfLoadingTask | undefined>(undefined);
  const imageCache = useRef(new Map<number, string>());
  const renderJobs = useRef(new Map<number, Promise<string>>());
  const renderTasks = useRef(new Set<PdfRenderTask>());
  const renderEpoch = useRef(0);
  const translationRuns = useRef(createLatestTaskRegistry<string>());
  const translationRequests = useRef(new Map<string, AbortController>());
  const translationCacheWrites = useRef(new Set<Promise<void>>());
  const translationCacheClearing = useRef(false);
  const navigationWrites = useRef(new Set<string>());
  const manualOffsetTouched = useRef(false);
  const pageNavigationCleanup = useRef<() => void>(() => undefined);
  const viewportSettleTimer = useRef<number | undefined>(undefined);
  const viewportWorkEnabledRef = useRef(true);
  const programmaticScroll = useRef(false);
  const userScrollIntentUntil = useRef(0);
  const navigationTarget = useRef<number | null>(null);
  const documentLoadSequence = useRef(0);
  const documentIdRef = useRef("verso-demo");
  const currentPageRef = useRef(1);
  const translationAnimationEnabledRef = useRef(DEFAULT_SETTINGS.translationAnimation);
  const sourceScrollAnchor = useRef<{ page: number; top: number } | null>(null);
  const sourceAnchorReleaseFrame = useRef<number | undefined>(undefined);
  const translationsRef = useRef<Record<number, Translation>>(DEMO_TRANSLATIONS);
  const translationSourcesRef = useRef<Record<number, TranslationSource>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showLibraryHome, setShowLibraryHome] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  const [readerMenuOpen, setReaderMenuOpen] = useState(false);
  const [readerZoom, setReaderZoom] = useState(1);
  const [sidebarView, setSidebarView] = useState<SidebarView>("pages");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const { locale, setLocale } = useUiLocale();
  const [theme, setTheme] = useState<ThemeMode>("light");
  const messages = UI_MESSAGES[locale];
  const messagesRef = useRef(messages);
  const [settings, setSettings] = useState<AppSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    const stored = localStorage.getItem("verso-settings");
    if (!stored) return DEFAULT_SETTINGS;
    try {
      const storedSettings = JSON.parse(stored) as Partial<AppSettings>;
      return {
        ...DEFAULT_SETTINGS,
        targetLanguage: storedSettings.targetLanguage || DEFAULT_SETTINGS.targetLanguage,
        nearbyPages: Number.isInteger(storedSettings.nearbyPages) ? storedSettings.nearbyPages! : DEFAULT_SETTINGS.nearbyPages,
        translationConcurrency: Number.isInteger(storedSettings.translationConcurrency)
          ? storedSettings.translationConcurrency!
          : DEFAULT_SETTINGS.translationConcurrency,
        smoothScrolling: storedSettings.smoothScrolling ?? DEFAULT_SETTINGS.smoothScrolling,
        translationAnimation: storedSettings.translationAnimation ?? DEFAULT_SETTINGS.translationAnimation,
        translationAnimationSpeed: storedSettings.schemaVersion === DEFAULT_SETTINGS.schemaVersion
          && Number(storedSettings.translationAnimationSpeed) >= 10
          ? Number(storedSettings.translationAnimationSpeed)
          : DEFAULT_TYPEWRITER_CHARACTERS_PER_SECOND,
      };
    } catch {
      return DEFAULT_SETTINGS;
    }
  });
  const [translationService, setTranslationService] = useState<TranslationService>(EMPTY_TRANSLATION_SERVICE);
  const translationSettings = useMemo<TranslationSettings>(() => ({
    targetLanguage: settings.targetLanguage,
    translationConcurrency: settings.translationConcurrency,
  }), [
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
  const [localIndexLoaded, setLocalIndexLoaded] = useState(false);
  const [documentError, setDocumentError] = useState("");
  const [isDemo, setIsDemo] = useState(true);
  const [serverBookAvailable, setServerBookAvailable] = useState(false);
  const [translations, setTranslations] = useState<Record<number, Translation>>(DEMO_TRANSLATIONS);
  const [translationSources, setTranslationSources] = useState<Record<number, TranslationSource>>({});
  const [translationAnimationVersions, setTranslationAnimationVersions] = useState<Record<number, number>>({});
  const [loadingPages, setLoadingPages] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [localBooks, setLocalBooks] = useState<LocalBook[]>([]);
  const [localBooksLoading, setLocalBooksLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [storageMessage, setStorageMessage] = useState("");
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
    for (const task of renderTasks.current) {
      try {
        task.cancel();
      } catch {
        // The task may have completed between iteration and cancellation.
      }
    }
    renderTasks.current.clear();
    renderJobs.current.clear();
  }, []);

  const cancelTranslationWork = useCallback(() => {
    translationRuns.current.cancelAll();
    for (const controller of translationRequests.current.values()) controller.abort();
    translationRequests.current.clear();
    setLoadingPages(new Set());
  }, []);

  const cancelDocumentWork = useCallback(() => {
    cancelPageRenders();
    cancelTranslationWork();
  }, [cancelPageRenders, cancelTranslationWork]);

  const persistTranslation = useCallback((
    key: string,
    targetDocumentId: string,
    page: number,
    translation: Translation,
    fallbackMessage: string,
  ) => {
    const write = writeLocalCache(key, targetDocumentId, page, translation, fallbackMessage);
    translationCacheWrites.current.add(write);
    void write.then(
      () => translationCacheWrites.current.delete(write),
      () => translationCacheWrites.current.delete(write),
    );
    return write;
  }, []);

  const discardCurrentBookTranslations = useCallback(async () => {
    const currentDocumentId = documentIdRef.current;
    const documentSequence = documentLoadSequence.current;
    translationCacheClearing.current = true;
    cancelTranslationWork();
    try {
      await Promise.allSettled([...translationCacheWrites.current]);
      const deleted = await deleteLocalTranslations(
        currentDocumentId,
        messagesRef.current.localTranslationDiscardFailed,
      );
      if (
        currentDocumentId === documentIdRef.current
        && documentSequence === documentLoadSequence.current
      ) {
        translationsRef.current = {};
        translationSourcesRef.current = {};
        setTranslations({});
        setTranslationSources({});
        setTranslationAnimationVersions({});
        setLoadingPages(new Set());
        setErrors({});
        setSearchMatches([]);
        setSearchError("");
      }
      return deleted;
    } finally {
      translationCacheClearing.current = false;
    }
  }, [cancelTranslationWork]);

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
      setTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    }, 0);
    return () => window.clearTimeout(detectPreferences);
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const saveTranslationService = useCallback(async (providerSettings: AiProviderSettingsUpdate) => {
    const response = await fetch("/api/settings/ai-provider", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(providerSettings),
    });
    const result = await response.json() as PublicAiProviderSettings & { error?: string };
    if (!response.ok) throw new Error(result.error || "Unable to save translation service settings.");
    setTranslationService({ ...result, loaded: true });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/ai-provider", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json() as PublicAiProviderSettings & { error?: string };
        if (!response.ok) throw new Error(result.error || "Unable to read translation service status.");
        setTranslationService({ ...result, loaded: true });
      })
      .catch(() => {
        if (!controller.signal.aborted) setTranslationService({ ...EMPTY_TRANSLATION_SERVICE, loaded: true });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!readerMenuOpen) return;
    const closeMenu = (event: PointerEvent) => {
      if (!readerMenu.current?.contains(event.target as Node)) setReaderMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setReaderMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [readerMenuOpen]);

  useEffect(() => {
    if (!sidebarDrawerOpen || !window.matchMedia("(max-width: 900px)").matches) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [sidebarDrawerOpen]);

  const refreshBooks = useCallback(async () => {
    const currentMessages = messagesRef.current;
    setLocalBooksLoading(true);
    setLibraryError("");
    try {
      const response = await fetch("/api/books", { cache: "no-store" });
      const result = await response.json() as { books?: LocalBook[]; error?: string };
      if (!response.ok) throw new Error(result.error || currentMessages.libraryReadFailed);
      setLocalBooks(result.books || []);
    } catch (error) {
      const message = error instanceof Error ? error.message : currentMessages.libraryReadFailed;
      setStorageMessage(message);
      setLibraryError(message);
    } finally {
      setLocalBooksLoading(false);
    }
  }, []);

  useEffect(() => {
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
        if (showLibraryHome) return;
        event.preventDefault();
        setSettingsOpen(false);
        setSidebarOpen(true);
        setSidebarDrawerOpen(window.matchMedia("(max-width: 900px)").matches);
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
      } else if (event.key === "Escape") {
        setSidebarDrawerOpen(false);
      }
    }

    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, [showLibraryHome, sidebarView]);

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
          body: JSON.stringify({
            documentId,
            query,
            cacheKeySuffix: cacheKeySuffix(translationSettings),
            fallbackCacheKeySuffix: translationSettings.targetLanguage,
          }),
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
    cancelDocumentWork();
    setReaderMenuOpen(false);
    setSettingsOpen(false);
    setShowLibraryHome(true);
    if (bookIdFromUrl()) updateBookInUrl(null, "push");
    window.scrollTo({ top: 0, behavior: "instant" });
    void refreshBooks();
  }, [cancelDocumentWork, refreshBooks]);

  const loadNavigation = useCallback(async (id: string, sequence: number, providerSettings: TranslationSettings) => {
    setNavigationLoading(true);
    setNavigationError("");
    try {
      const [navigationResult, translationIndexResult] = await Promise.allSettled([
        readLocalNavigation(id, messagesRef.current.navigationReadFailed),
        readLocalTranslationIndex(id, providerSettings, messagesRef.current.localTranslationReadFailed),
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

  const beginDocumentLoad = useCallback((id: string, name: string, pageCount: number, hasLocalIndex: boolean) => {
    const sequence = ++documentLoadSequence.current;
    const previousLoadingTask = pdfLoadingTaskRef.current;
    const previousPdf = pdfRef.current;
    pdfLoadingTaskRef.current = undefined;
    pdfRef.current = undefined;
    if (previousLoadingTask) void previousLoadingTask.destroy();
    else if (previousPdf) void previousPdf.loadingTask.destroy();
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
    setServerBookAvailable(hasLocalIndex);
    setLocalIndexLoaded(hasLocalIndex);
    setDocumentReady(hasLocalIndex);
    setLoadingDocument(!hasLocalIndex);
    setDocumentError("");
    if (hasLocalIndex) {
      viewportWorkEnabledRef.current = true;
      setViewportWorkEnabled(true);
    }
    window.scrollTo({ top: 0, behavior: "instant" });
    return sequence;
  }, [cancelDocumentWork, suspendViewportWork]);

  const finishDocumentLoad = useCallback((sequence: number, pdf: PdfDocument) => {
    if (sequence !== documentLoadSequence.current) {
      void pdf.loadingTask.destroy();
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
    void writeLocalNavigationObservation(documentId, observation, messagesRef.current.navigationWriteFailed)
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
    void writeLocalManualOffset(documentId, manualOffset, messagesRef.current.navigationWriteFailed)
      .catch((error) => {
        if (sequence !== documentLoadSequence.current) return;
        setNavigationError(error instanceof Error ? error.message : messagesRef.current.navigationWriteFailed);
      });
  }, [documentId, isDemo]);

  const uploadToLocal = useCallback(async (file: File, fileFingerprint: string, pageCount: number) => {
    setUploadProgress(0);
    setStorageMessage(messages.preparingLocal);
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
        book?: LocalBook;
        uploadId?: string;
        objectKey?: string;
        error?: string;
      };
      if (!initialize.ok) throw new Error(initialized.error || messages.uploadFailed);
      if (initialized.exists) {
        setUploadProgress(100);
        setStorageMessage(messages.localBookReused);
        if (initialized.book && documentIdRef.current === fileFingerprint) {
          updateBookInUrl(initialized.book.fingerprint);
          setServerBookAvailable(true);
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
          setStorageMessage(messages.cachingParts(completedParts, partCount));
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, partCount) }, () => uploadWorker()));

      const complete = await fetch(`/api/books/uploads/${encodeURIComponent(initialized.uploadId)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...metadata, objectKey: initialized.objectKey, parts }),
      });
      const completed = await complete.json() as { book?: LocalBook; error?: string };
      if (!complete.ok || !completed.book) throw new Error(completed.error || messages.uploadCompleteFailed);
      setUploadProgress(100);
      setStorageMessage(messages.cachedLocal);
      if (documentIdRef.current === fileFingerprint) {
        updateBookInUrl(completed.book.fingerprint);
        setServerBookAvailable(true);
      }
      await refreshBooks();
    } catch (error) {
      setUploadProgress(null);
      setStorageMessage(error instanceof Error ? error.message : messages.uploadFailed);
    }
  }, [messages, refreshBooks]);

  const renderPdfPageToCanvas = useCallback(async (
    pageNumber: number,
    canvas: HTMLCanvasElement,
    targetWidth: number,
    signal?: AbortSignal,
  ) => {
    if (!viewportWorkEnabledRef.current) {
      throw new DOMException("Page rendering is paused while the viewport is moving.", "AbortError");
    }
    if (signal?.aborted) throw new DOMException("Page rendering was cancelled.", "AbortError");

    const epoch = renderEpoch.current;
    const pdf = pdfRef.current || await pdfLoadingTaskRef.current?.promise;
    if (!pdf) throw new Error("PDF is not ready");
    const page = await pdf.getPage(pageNumber);
    if (epoch !== renderEpoch.current || signal?.aborted) {
      throw new DOMException("Page rendering was cancelled.", "AbortError");
    }

    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, targetWidth / base.width);
    const viewport = page.getViewport({ scale });
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas is unavailable");

    const renderTask = page.render({ canvas, canvasContext: context, viewport });
    const cancel = () => {
      try {
        renderTask.cancel();
      } catch {
        // The task may have completed between the abort and cancellation.
      }
    };
    renderTasks.current.add(renderTask);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await renderTask.promise;
      if (epoch !== renderEpoch.current || signal?.aborted) {
        throw new DOMException("Page rendering was cancelled.", "AbortError");
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      renderTasks.current.delete(renderTask);
    }
  }, []);

  const renderPageToCanvas = useCallback(async (
    pageNumber: number,
    canvas: HTMLCanvasElement,
    signal: AbortSignal,
  ) => {
    const cssWidth = canvas.parentElement?.clientWidth || window.innerWidth;
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const targetWidth = Math.min(1280, Math.max(640, Math.round(cssWidth * pixelRatio)));
    await renderPdfPageToCanvas(pageNumber, canvas, targetWidth, signal);
  }, [renderPdfPageToCanvas]);

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

    const job: Promise<string> = (async () => {
      const canvas = document.createElement("canvas");
      await renderPdfPageToCanvas(pageNumber, canvas, 1800);
      const image = canvas.toDataURL("image/jpeg", 0.82);
      imageCache.current.set(pageNumber, image);
      while (imageCache.current.size > 12) {
        const oldest = imageCache.current.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        imageCache.current.delete(oldest);
      }
      return image;
    })().finally(() => {
      if (renderJobs.current.get(pageNumber) === job) renderJobs.current.delete(pageNumber);
    });
    renderJobs.current.set(pageNumber, job);
    return job;
  }, [renderPdfPageToCanvas]);

  const requestTranslation = useCallback(async (page: number, force = false, cacheOnly = false) => {
    if (translationCacheClearing.current) return;
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
        return await readLocalCache(
          previousKey,
          documentId,
          page - 1,
          translationSettings,
          currentMessages.localTranslationReadFailed,
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted || isWorkCancellation(error)) throw error;
        return undefined;
      }
    };
    setLoadingPages((existing) => new Set(existing).add(page));
    setErrors((existing) => ({ ...existing, [page]: "" }));
    try {
      if (!force) {
        const cached = await readLocalCache(
          key,
          documentId,
          page,
          translationSettings,
          currentMessages.localTranslationReadFailed,
          controller.signal,
        );
        if (cached) {
          previousTranslation = await readPreviousTranslation();
          requireCurrentRun();
          const reconciled = reconcilePageBoundary(previousTranslation, cached);
          completeTranslationAnimation(page);
          setTranslationSources((existing) => ({ ...existing, [page]: "cache" }));
          updateTranslations((existing) => ({ ...existing, [page]: reconciled }));
          recordNavigation(page, reconciled);
          if (reconciled !== cached) {
            void persistTranslation(
              key,
              documentId,
              page,
              reconciled,
              currentMessages.localTranslationWriteFailed,
            ).catch(() => undefined);
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
      if (!translationService.configured) throw new Error(currentMessages.apiKeyRequired);
      previousTranslation = await readPreviousTranslation();
      requireCurrentRun();

      const payload = await translationLimiter.run(translationSettings.translationConcurrency, async () => {
        requireCurrentRun();
        const contextPages = [page - 1, page, page + 1].filter((value) => value >= 1 && value <= totalPages);
        let imageSource = serverBookAvailable
          ? { bookId: documentId, contextPages }
          : {
              images: await Promise.all(contextPages.map(async (number) => ({
                page: number,
                dataUrl: await renderPage(number),
              }))),
            };
        requireCurrentRun();
        const sendTranslation = (source: typeof imageSource | { images: Array<{ page: number; dataUrl: string }> }) => (
          fetch("/api/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              targetLanguage: translationSettings.targetLanguage,
              translationConcurrency: translationSettings.translationConcurrency,
              force,
              ...(serverBookAvailable ? { bookId: documentId } : {}),
              page,
              totalPages,
              ...source,
              previousTranslationTail: boundaryTail(previousTranslation),
            }),
            signal: controller.signal,
          })
        );
        let response = await sendTranslation(imageSource);
        let result = await response.json() as TranslationResponse & { error?: string; code?: string };
        if (!response.ok && result.code === "PAGE_RENDERER_UNAVAILABLE" && serverBookAvailable) {
          requireCurrentRun();
          imageSource = {
            images: await Promise.all(contextPages.map(async (number) => ({
              page: number,
              dataUrl: await renderPage(number),
            }))),
          };
          requireCurrentRun();
          response = await sendTranslation(imageSource);
          result = await response.json() as TranslationResponse & { error?: string; code?: string };
        }
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
            isBlank: !hasLayoutContent(payload.previousPageRevision.blocks),
            revised: true,
            cacheVersion: payload.cacheVersion ?? requestVersion,
            cachedAt: payload.cachedAt ?? Date.now(),
          }
        : undefined;
      const translated = reconcilePageBoundary(revision || previousTranslation, {
        page,
        markdown: translationMarkdown(payload.blocks),
        blocks: payload.blocks,
        isBlank: payload.isBlank,
        sourceSummary: payload.sourceSummary,
        cacheVersion: payload.cacheVersion ?? requestVersion,
        cachedAt: payload.cachedAt ?? Date.now(),
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
      if (!payload.serverManaged) await Promise.all([
        persistTranslation(
          key,
          documentId,
          page,
          translated,
          currentMessages.localTranslationWriteFailed,
        ),
        ...(revision ? [persistTranslation(
          previousKey,
          documentId,
          page - 1,
          revision,
          currentMessages.localTranslationWriteFailed,
        )] : []),
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
  }, [completeTranslationAnimation, documentId, isDemo, persistTranslation, recordNavigation, renderPage, serverBookAvailable, totalPages, translationService.configured, translationSettings, updateTranslations]);

  useEffect(() => {
    if (isDemo || !documentReady || navigationLoading || !viewportWorkEnabled || !translationService.loaded) return;
    const timers = pageWorkWindow(currentPage, totalPages, settings.nearbyPages).map((page) => (
      window.setTimeout(() => {
        const cacheOnly = translationSourcesRef.current[page] === "cache";
        void requestTranslation(page, false, cacheOnly);
      }, 250 + Math.abs(page - currentPage) * 250)
    ));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [currentPage, documentReady, isDemo, navigationLoading, requestTranslation, settings.nearbyPages, totalPages, translationService.loaded, viewportWorkEnabled]);

  const handleFile = useCallback(async (file?: File) => {
    if (!file) return;
    setShowLibraryHome(false);
    updateBookInUrl(null);
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
        void uploadToLocal(file, fileFingerprint, pdf.numPages);
      }
    } catch (error) {
      if (sequence !== documentLoadSequence.current) return;
      const detail = error instanceof Error ? error.message : "Unknown PDF error";
      setDocumentError(messages.openPdfFailed(detail));
      setLoadingDocument(false);
    }
  }, [beginDocumentLoad, finishDocumentLoad, loadNavigation, messages, translationSettings, uploadToLocal]);

  const loadLocalBook = useCallback(async (book: LocalBook, updateUrl = true) => {
    setShowLibraryHome(false);
    if (updateUrl) updateBookInUrl(book.fingerprint, "push");
    const sequence = beginDocumentLoad(book.fingerprint, book.name, book.pageCount, true);
    void loadNavigation(book.fingerprint, sequence, translationSettings);
    const currentMessages = messagesRef.current;
    try {
      const { pdfjs, worker } = await loadPdfRuntime();
      const { transport, failure } = createLocalPdfRangeTransport({
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
        rangeChunkSize: LOCAL_PDF_RANGE_CHUNK_SIZE,
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
        setStorageMessage(messagesRef.current.openLocalFailed(error.message));
        void loadingTask.destroy();
      });
      const pdf = await Promise.race([loadingTask.promise, failure]);
      if (finishDocumentLoad(sequence, pdf)) {
        setUploadProgress(100);
        setStorageMessage(currentMessages.openedFromLocal);
      }
    } catch (error) {
      if (sequence !== documentLoadSequence.current) return;
      const detail = error instanceof Error ? error.message : "Unknown PDF error";
      setStorageMessage(currentMessages.openLocalFailed(detail));
    }
  }, [beginDocumentLoad, finishDocumentLoad, loadNavigation, translationSettings]);

  useEffect(() => {
    const restoreFromUrl = () => {
      const requestedBookId = bookIdFromUrl();
      if (!requestedBookId) {
        cancelDocumentWork();
        setShowLibraryHome(true);
        return;
      }
      setShowLibraryHome(false);
      void readLocalBook(requestedBookId, messagesRef.current.libraryReadFailed)
        .then((book) => loadLocalBook(book, false))
        .catch((error) => {
          const detail = error instanceof Error ? error.message : messagesRef.current.libraryReadFailed;
          setStorageMessage(messagesRef.current.openLocalFailed(detail));
          setShowLibraryHome(true);
        });
    };
    const restoreTimer = window.setTimeout(restoreFromUrl, 0);
    window.addEventListener("popstate", restoreFromUrl);
    return () => {
      window.clearTimeout(restoreTimer);
      window.removeEventListener("popstate", restoreFromUrl);
    };
  }, [cancelDocumentWork, loadLocalBook]);

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

  const openSidebarView = useCallback((view: SidebarView) => {
    setSidebarOpen(true);
    setSidebarDrawerOpen(window.matchMedia("(max-width: 900px)").matches);
    setSidebarView(view);
    setReaderMenuOpen(false);
    if (view === "search") {
      window.requestAnimationFrame(() => {
        searchInput.current?.focus();
        searchInput.current?.select();
      });
    }
  }, []);

  const closeSidebar = useCallback(() => {
    if (window.matchMedia("(max-width: 900px)").matches) {
      setSidebarDrawerOpen(false);
    } else {
      setSidebarOpen(false);
    }
  }, []);

  if (showLibraryHome) {
    return (
      <main className="app-shell library-shell">
        <LibraryHome
          books={localBooks}
          translationSettings={translationSettings}
          locale={locale}
          messages={messages}
          loading={localBooksLoading}
          error={libraryError}
          theme={theme}
          onDiscardTranslations={(book) => book.fingerprint === documentIdRef.current
            ? discardCurrentBookTranslations()
            : deleteLocalTranslations(book.fingerprint, messages.localTranslationDiscardFailed)}
          onSelect={(book) => void loadLocalBook(book)}
          onUpload={() => fileInput.current?.click()}
          onRetry={() => void refreshBooks()}
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleLocale={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}
          onToggleTheme={() => setTheme((value) => value === "light" ? "dark" : "light")}
        />
        <input ref={fileInput} type="file" accept="application/pdf" hidden onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          void handleFile(file);
        }} />
        {settingsOpen && (
          <SettingsPanel
            settings={settings}
            translationService={translationService}
            currentBookName={fileName}
            canDiscardTranslations={false}
            locale={locale}
            messages={messages}
            onChange={updateSettings}
            onProviderSave={saveTranslationService}
            onDiscardTranslations={discardCurrentBookTranslations}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </main>
    );
  }

  return (
    <main className={cn("app-shell", sidebarDrawerOpen && "sidebar-drawer-open")}>
      <header className="topbar">
        <button className="brand brand-button" onClick={openLibrary} aria-label={messages.openLibrary}><div className="brand-mark">V</div><span>Verso</span><em>AI Reader</em></button>
        <button className="document-title" onClick={openLibrary} title={messages.openLibrary}><FileText size={16} /><span>{fileName}</span><ChevronDown size={14} /></button>
        <div className="top-actions">
          {uploadProgress !== null && uploadProgress < 100 && (
            <div className="cache-status" title={storageMessage}>
              <LoaderCircle className="spin" size={14} />{messages.localProgress(uploadProgress)}
            </div>
          )}
          <button className="icon-button locale-button" title={messages.switchLanguage} aria-label={messages.switchLanguage} onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}><Globe2 size={16} /><span>{locale === "zh-CN" ? "EN" : "中"}</span></button>
          <button className="icon-button top-search-button" aria-label={messages.searchPages} onClick={() => {
            setSidebarOpen(true);
            setSidebarDrawerOpen(window.matchMedia("(max-width: 900px)").matches);
            setSidebarView("search");
            window.requestAnimationFrame(() => {
              searchInput.current?.focus();
              searchInput.current?.select();
            });
          }}><Search size={17} /></button>
          <button className="icon-button" title={messages.switchTheme} aria-label={messages.switchTheme} aria-pressed={theme === "dark"} onClick={() => setTheme((value) => value === "light" ? "dark" : "light")}>{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</button>
          <button className="secondary-button library-button" onClick={openLibrary}><BookOpen size={16} /> {messages.localLibrary}</button>
          <button className="secondary-button" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /> {messages.settings}</button>
          <button className="primary-button" onClick={() => fileInput.current?.click()}><Upload size={16} /><span className="action-label">{messages.openPdf}</span></button>
          <input ref={fileInput} type="file" accept="application/pdf" hidden onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            void handleFile(file);
          }} />
        </div>
      </header>

      <div className="workspace">
        <button
          type="button"
          className={cn("sidebar-backdrop", sidebarDrawerOpen && "visible")}
          aria-label={messages.toggleSidebar}
          tabIndex={sidebarDrawerOpen ? 0 : -1}
          onClick={() => setSidebarDrawerOpen(false)}
        />
        <aside className={cn("sidebar", !sidebarOpen && "collapsed", sidebarDrawerOpen && "mobile-open")}>
          <div className="sidebar-head">
            <button className="icon-button sidebar-close-button" aria-label={messages.toggleSidebar} onClick={closeSidebar}>
              <PanelLeftClose className="desktop-sidebar-close" size={18} />
              <X className="mobile-sidebar-close" size={19} />
            </button>
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
                      <button key={page} className={cn(page === currentPage && "active")} onClick={() => {
                        goToPage(page);
                        setSidebarDrawerOpen(false);
                      }}>
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
                    onNavigate={(page) => {
                      goToPage(page);
                      setSidebarDrawerOpen(false);
                    }}
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
                      <button key={`${match.page}-${index}`} role="listitem" onClick={() => {
                        goToPage(match.page);
                        setSidebarDrawerOpen(false);
                      }}>
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
            <div className="reader-toolbar-start">
              <button
                className={cn("icon-button", "reader-sidebar-button", sidebarOpen && "desktop-hidden")}
                aria-label={messages.toggleSidebar}
                onClick={() => openSidebarView("pages")}
              >
                <Menu size={19} />
              </button>
              <div className="page-stepper">
                <button className="icon-button" onClick={() => goToPage(currentPage - 1, "adjacent")} aria-label={messages.previousPage}><ChevronLeft size={17} /></button>
                <span><strong>{currentPage}</strong> / {totalPages}</span>
                <button className="icon-button" onClick={() => goToPage(currentPage + 1, "adjacent")} aria-label={messages.nextPage}><ChevronRight size={17} /></button>
              </div>
            </div>
            <div className="column-labels"><span>{messages.sourceScan}</span><i /><span><Languages size={15} /> {targetLanguageLabel(settings.targetLanguage, locale)}</span></div>
            <div className="reader-zoom" role="group" aria-label={messages.readerZoom}>
              <button className="icon-button" aria-label={messages.zoomOut} disabled={readerZoom <= MIN_READER_ZOOM} onClick={() => setReaderZoom((value) => Math.max(MIN_READER_ZOOM, value - 0.1))}><Minus size={16} /></button>
              <button className="zoom-fit" title={messages.fitWidth} onClick={() => setReaderZoom(1)}>{Math.round(readerZoom * 100)}%</button>
              <button className="icon-button" aria-label={messages.zoomIn} disabled={readerZoom >= MAX_READER_ZOOM} onClick={() => setReaderZoom((value) => Math.min(MAX_READER_ZOOM, value + 0.1))}><Plus size={16} /></button>
              <button className="zoom-fit" onClick={() => setReaderZoom(1)}>{messages.fitWidth}</button>
            </div>
            <div className="reader-menu-anchor" ref={readerMenu}>
              <button
                className="icon-button reader-menu-button"
                aria-label={messages.moreOptions}
                aria-expanded={readerMenuOpen}
                aria-controls="reader-overflow-menu"
                onClick={() => setReaderMenuOpen((open) => !open)}
              >
                <MoreHorizontal size={20} />
              </button>
              {readerMenuOpen && (
                <div id="reader-overflow-menu" className="reader-overflow-menu" role="menu">
                  <button role="menuitem" onClick={() => openSidebarView("pages")}><FileText size={17} /><span>{messages.pages}</span></button>
                  <button role="menuitem" onClick={() => openSidebarView("contents")}><ListTree size={17} /><span>{messages.contents}</span></button>
                  <button role="menuitem" onClick={() => openSidebarView("search")}><Search size={17} /><span>{messages.searchPages}</span></button>
                  <i aria-hidden="true" />
                  <button role="menuitem" onClick={() => {
                    setReaderMenuOpen(false);
                    openLibrary();
                  }}><BookOpen size={17} /><span>{messages.localLibrary}</span></button>
                  <button role="menuitem" onClick={() => {
                    setReaderMenuOpen(false);
                    setSettingsOpen(true);
                  }}><Settings2 size={17} /><span>{messages.settings}</span></button>
                  <button role="menuitem" onClick={() => {
                    setReaderMenuOpen(false);
                    fileInput.current?.click();
                  }}><Upload size={17} /><span>{messages.openPdf}</span></button>
                </div>
              )}
            </div>
          </div>

          {documentError && (
            <div className="reader-notice error-notice">
              <span>{documentError}</span>
              <button className="icon-button" onClick={() => setDocumentError("")} aria-label={messages.closeError}><X size={16} /></button>
            </div>
          )}
          {!isDemo && !loadingDocument && translationService.loaded && !translationService.configured && !documentError && (
            <div className="reader-notice setup-notice">
              <span><Sparkles size={15} /> {messages.pdfReady}</span>
              <button className="secondary-button" onClick={() => setSettingsOpen(true)}>{messages.openSettings}</button>
            </div>
          )}

          {loadingDocument ? (
            <div className="document-loading">
              <LoaderCircle className="spin" size={28} />
              <strong>{localIndexLoaded ? messages.localIndex(totalPages) : messages.readingIndex}</strong>
              <p>{messages.connectingRenderer(fileName.replace(/\.pdf$/i, ""))}</p>
            </div>
          ) : documentError && !documentReady ? (
            <div className="document-loading document-load-failed">
              <strong>{messages.rendererFailed}</strong>
              <p>{messages.rendererFailedHelp}</p>
            </div>
          ) : (
            <ReaderViewport zoom={readerZoom} onZoom={setReaderZoom} currentPage={currentPage}>
              {pageNumbers.map((page) => (
                <PageSpread
                  key={`${documentId}-${page}-${serverBookAvailable ? "server" : "local"}`}
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
                  pageImageUrl={serverBookAvailable
                    ? `/api/books/${encodeURIComponent(documentId)}/pages/${page}?profile=display`
                    : undefined}
                  renderPageToCanvas={renderPageToCanvas}
                  requestTranslation={requestTranslation}
                  onTranslationAnimationComplete={completeTranslationAnimation}
                  setCurrentPage={observeCurrentPage}
                  messages={messages}
                  searchQuery={sidebarView === "search" ? searchQuery.trim() : ""}
                />
              ))}
            </ReaderViewport>
          )}
        </section>
      </div>

      <div className="floating-status"><Sparkles size={15} /><span>{messages.contextWindow}</span><strong>{messages.pageRange(Math.max(1, currentPage - 1), Math.min(totalPages, currentPage + 1))}</strong></div>
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          translationService={translationService}
          currentBookName={fileName}
          canDiscardTranslations={!isDemo}
          locale={locale}
          messages={messages}
          onChange={updateSettings}
          onProviderSave={saveTranslationService}
          onDiscardTranslations={discardCurrentBookTranslations}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </main>
  );
}
