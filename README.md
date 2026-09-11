# Verso

Verso is an AI-powered web reader for scanned PDF books. It keeps the original
page visible beside a layout-aware translation, so you can read across
languages without losing the typography, illustrations, or structure of the
source.

![Verso reader showing a scanned page and its translation side by side](./docs/images/reader-light.png)

## Features

- **Side-by-side reading:** compare the source scan and translation while
  navigating pages from a persistent sidebar with reading progress.
- **Layout-aware vision translation:** preserve headings, paragraphs, lists,
  captions, whitespace, and page numbers. Restore illustrations cropped from
  the source scan in reading order and retain their horizontal placement and
  relative width, preserving typography as the entire reading view scales.
- **Sentence alignment:** hover over or keyboard-focus a translated sentence to
  highlight its original lines on the scan. Match the source sentence against
  actual PDF word boxes, using local Tesseract OCR for image-only pages. Word
  indexes are cached in the data volume; existing sentence mappings are corrected
  when their page is opened. Unmatched text is not highlighted.
  Existing cached pages remain readable; use the page's retranslate button to
  add image crops and sentence alignment.
- **Cross-page context:** translate with a bounded window of consecutive pages,
  revise unfinished paragraphs, and deterministically remove duplicated text at
  page boundaries.
- **Server-managed AI providers:** use the OpenAI Responses API or an
  OpenAI-compatible endpoint without exposing provider credentials to the
  browser. Provider settings are stored in server-side SQLite together with
  the local library metadata.
- **Local library and caching:** keep uploaded PDFs, page indexes, blank-page
  results, and translations in the Docker volume or desktop library so books remain available
  across reading sessions without a cloud storage service.
- **Whole-book translation queue:** enqueue a book from the library and follow its
  page progress. Work continues with the browser closed and resumes after a server
  restart. Reading requests take priority over pending background pages and share
  in-flight work; existing translations (including blank pages) are reused for the
  selected target language. Failed jobs can be retried without retranslating saved
  pages. Discarding a book's translations also removes its queued work.
- **Automatic contents navigation:** detect translated contents pages, preserve
  printed page references, and calibrate PDF page offsets automatically or
  manually.
- **Translation search:** search locally cached translations, jump directly to a
  result, and highlight matches without scanning or retranslating the book.
  Open search with Cmd + F or Ctrl + F in both the browser and desktop app.
  Additional modifiers are left to the system, including Ctrl + Cmd + F for
  macOS fullscreen.
- **Large-book performance:** lazily rasterize requested pages on the server,
  persist display and vision derivatives in the local volume, and bound both
  page rendering and background translation work.
- **Reading view zoom:** fit both pages to the available width while preserving
  the margins inside each page. Zoom the entire spread with the toolbar, Ctrl/Cmd + mouse wheel, or
  Ctrl/Cmd + plus/minus; Ctrl/Cmd + 0 restores fit width. The sidebar and toolbar
  stay at their normal size. Browser-menu zoom remains a browser-level setting.
- **Reader preferences:** switch the interface between English and Simplified
  Chinese independently of the translation target, choose a light or dark
  theme, and configure animated page navigation without altering the source
  scan.

## Background translation queue

Open **Translation queue** from the library to see jobs in every target language,
page progress, retry counts, and provider errors. The library cards show concise
status and a queue link; raw background errors appear only in the queue view.

The queue has its own **Background concurrency** selector (1–10, default 4),
saved in local SQLite and shared across books and target languages. It translates
multiple pages of the same book concurrently and applies changes to existing
jobs. Lowering the setting lets active pages finish before filling fewer slots.
Reader concurrency is configured separately in Settings (also 1–10, default 4).
Both use the shared provider scheduler, which keeps pending reader work first.
Only a bounded number of pages are materialized; adjacent source images remain
available as context even if a previous page's translation is still running.

Each page has its own allowance of three automatic retries, after 1, 2, and 4
seconds (four total attempts). A page that exhausts its retries is skipped so
other pages can continue. A book pauses only when **three distinct pages** remain
failed after exhausting their own retries. This tolerates isolated bad pages
while stopping a persistently failing job. Successful pages do not consume this
limit; pages recovered through the reader are removed from the failure count.

If the queue reaches the end with one or two failed pages, it shows **Finished
with failed pages**, rather than claiming the book is fully translated. Choose
**Retry translation** to retry unfinished pages with fresh per-page allowances.
Retry counts, exhausted pages, and pause state survive application restarts in
local SQLite storage.

Use **Stop translation** in the queue to stop pending work and cancel its active
provider request. Completed translations are retained. **Resume translation**
continues unfinished pages and skips pages already translated. Stopping is
scoped to the selected book and target language; an independent reader request
that the background worker joined may still finish and save its page.

## Screenshots

### Translation configuration

Open the dedicated `/settings` page from the library or reader to configure the
server provider, translation, reading, and interface preferences. Returning to
the reader restores the book and page. All settings save automatically. Use
Test connection to check the configured AI endpoint, credentials, and model
with a short request. Interface language remains independent of the translation
target. Provider
credentials, endpoints, models, and reasoning settings are stored in the
server-side SQLite database. The API key is never returned by the settings API.

![Verso translation and reading settings](./docs/images/ai-settings.png)

### Dark theme

The reader chrome and translated page adapt to dark mode while the scanned page
retains its original appearance.

![Verso reader in dark mode](./docs/images/reader-dark.png)

## Technology

- React 19 and the Next.js App Router.
- Poppler for server-side, volume-backed page rasterization, with PDF.js as a
  browser fallback for files that have not finished uploading.
- SQLite for metadata, navigation indexes, and translation records.
- The local filesystem for uploaded PDF objects.
- TypeScript, Tailwind CSS, and Lucide icons.

## Requirements

- Node.js 22.13 or newer.
- npm.
- Poppler's `pdftocairo` and `pdftotext` for page rendering and word positions.
- Tesseract with English, Simplified/Traditional Chinese, and Japanese language
  data for word positions in image-only PDFs.
  The Docker image includes these tools. Without Poppler, page display falls
  back to PDF.js; reliable sentence highlighting requires the local text/OCR
  tools.

## Local Development

```bash
npm ci
npm run dev
```

On Debian or Ubuntu, install the optional server renderer with
`apt-get install poppler-utils tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-chi-tra tesseract-ocr-jpn`. The development server listens on
`0.0.0.0:3000`. Open
`http://localhost:3000` locally or use the machine hostname from another device
on the same network.

Start Verso, open Settings, and enter the AI provider configuration. Verso does
not read provider credentials from environment variables. Translation results,
uploaded books, and page indexes are not stored in browser caches.

For a local production deployment, build and start the standalone server:

```bash
npm run build
npm start
```

`npm start` binds to `0.0.0.0:3000` and resolves the default `.data` directory
before the standalone server changes its working directory. Set
`VERSO_DATA_DIR` to use a different absolute or project-relative data path.

## Docker Deployment

Images for `linux/amd64` and `linux/arm64` are published from the `main` branch
to `ghcr.io/mrcroxx/verso`. Start the latest image with Docker Compose:

```bash
docker compose up -d
```

Then open `http://localhost:3000`. The named `verso-data` volume stores
`verso.sqlite`, uploaded books, and lazily generated page images together with
page indexes, translations, and AI provider settings. No external database,
queue, or object-storage service is required. The database contains the
provider credential, so protect its backups and back up the volume before
replacing or moving the deployment.

The equivalent Docker command is:

```bash
docker run -d \
  --name verso \
  --restart unless-stopped \
  -p 3000:3000 \
  -v verso-data:/data \
  ghcr.io/mrcroxx/verso:latest
```

To update an existing Compose deployment:

```bash
docker compose pull
docker compose up -d
```

## macOS Desktop App

Verso can also run as a standalone macOS app with a local library, using the
same reader and backend as the Docker deployment. The app bundles Node.js,
Poppler, Tesseract, and OCR language data; it does not require Docker or a remote
Verso server. Desktop data lives in `~/Library/Application Support/Verso/library`.

Build an ad-hoc signed installer on a Mac:

```bash
brew install poppler tesseract tesseract-lang
npm ci
VERSO_MAC_UNSIGNED=1 npm run desktop:package
```

Installers are written to `dist/desktop`. The **CI** Actions workflow also builds
separate Apple Silicon and Intel artifacts after Linux and macOS validation
passes on main pushes, version tags, and manual dispatch. See
[desktop development and packaging](docs/desktop.md) for startup behavior,
validation, signing, and notarization.

## Translation traces

Open **Settings → View translation traces** (`/traces`). The local waterfall
refreshes every two seconds and shows foreground and background requests,
queue waits, image preparation, provider latency, PDF text/OCR extraction,
alignment, persistence, cache hits, failures, and token usage when the provider
reports it. Completed traces survive restarts; the latest 200 are retained in
`translation_traces` in the volume-backed SQLite database. In-flight traces
are held in memory and disappear on restart. No credentials, prompts, page
images, translation text, or provider response bodies are recorded.

Translation uses streaming for both Responses and Chat Completions providers.
Provider requests allow five minutes for response headers, then five minutes
without response data. Every nonempty network chunk resets the idle deadline,
including reasoning, SSE heartbeats, and fragmented events. Active translations
can run for up to 30 minutes in total; this final limit also stops endless
reasoning or heartbeat-only streams. Timeout errors distinguish initial waiting,
idle connections, and the total limit, and traces record `timeoutPhase`.
These limits apply to both the desktop app and Docker, including providers that
return ordinary JSON. The short Settings connection test retains its 30-second
limit.

While a page is translating, the header beside its refresh button shows the
current phase, received tokens, Unicode characters, and average tokens per
second (TPS), refreshed at most every 150 ms. Counts include received reasoning
and output text, including JSON structure. No partial text or reasoning is
forwarded to the reader. A reader joining an existing background job receives
its latest counters without a second model request.

Providers usually report token usage only at completion. Until consistent
usage arrives, tokens are estimated as received UTF-8 bytes divided by four,
rounded up; this is a rough estimate, not model tokenization. The header tooltip
explains the estimate without adding a symbol to each counter.
TPS uses the same token count divided by time since the first nonempty output
delta, including pauses, and appears after one second of output. Final reported
usage calibrates tokens and TPS only when internally consistent (for example,
reasoning tokens must not exceed output tokens). Character counts remain exact
for received Unicode code points. Providers that omit hidden reasoning cannot
expose it through these live counters.

Counters stay in memory and are removed when the request finishes or the reader
switches documents. The complete model output is still validated, aligned, and
saved before it replaces the page. An interrupted or incomplete stream is an
error, never a partially saved translation. Providers that return ordinary JSON
instead of SSE remain readable and are marked `streamed: false` in the trace.

For Chrome debugging:

1. In **Performance**, enable **Capture settings → Show custom tracks**, start
   recording before requesting a translation, and stop after it completes.
   The **Verso translation** group contains browser queue/image preparation
   and server-stage tracks. Server spans are anchored at response receipt to
   avoid cross-machine clock skew; their network alignment is approximate.
   See the [Chrome custom-track documentation](https://developer.chrome.com/docs/devtools/performance/extension).
2. In **Network**, `/api/translate` requests with `Accept: text/event-stream`
   contain `progress` events followed by a final `result` or `error` event. The
   final event includes the trace. Clients requesting ordinary JSON also get
   `Server-Timing` and `X-Verso-Trace-Id` response headers. Streaming responses
   cannot include final durations in headers sent before generation completes.
3. For background work or requests completed before recording, use **Export**
   on `/traces`. Open the Chrome Trace Event JSON in `chrome://tracing` or a
   [Perfetto-compatible viewer](https://perfetto.dev/docs/getting-started/other-formats).
   `/api/traces?format=chrome` exports all retained traces; add `&id=TRACE_ID`
   for one request.

`provider.wait_headers` ends at HTTP response headers. All `provider.first_*`
spans start at request submission: `first_event` ends at the first parsed SSE
event, `first_output` at the first nonempty reasoning or text delta,
`first_reasoning` at the first nonempty reasoning delta, and `first_text` at the
first nonempty output-text delta. A role-only event is not a token. For reasoning
models, `first_text` includes thinking time and is not time to first output. `provider.stream`
measures from headers until the completed output has been received. The first
text delta can contain JSON structure before any translated words. Old traces
and JSON-only provider responses may include full generation in header latency.
Parent spans include child work and parallel spans overlap; adding every
duration overcounts elapsed time. `queue.shared_wait` means the request joined
an existing page translation; inspect that page's original request for its
provider stages.

Protocol references: [OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming-responses)
and [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/).

See [the performance investigation](docs/translation-performance.md) for
measurements, changes, and their practical limits.

## Validation

```bash
npm run lint
npm test
```

`npm test` creates a production build and runs the rendering, translation
normalization, blank-page caching, cross-page deduplication, and concurrency
tests.

## Repository Conventions

Repository-wide contribution and language rules are documented in
[`AGENTS.md`](./AGENTS.md).
