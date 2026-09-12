# Translation performance investigation

Measured on September 11, 2026, against local `main` at `e78c181`, with
instrumentation added before moving source extraction off the serial path.
The configured provider was `deepseek-flash` with `high` reasoning. Requests
used the existing three adjacent page images, unchanged prompts and image
quality, and the same translation target and cached previous-page tail.

## Measurements

The benchmark used a consistent SQLite backup and read-only access to the
existing Docker book volume. Its translations, queue, and image caches were
isolated from the running reader. Each request explicitly bypassed the
translation cache. The production background queue remained active, so these
are observations of the deployed workload, not an isolated provider benchmark.

| Stage | Page 33 (failed model JSON) | Page 34 (successful) |
| --- | ---: | ---: |
| Total server request | 61.584 s | 78.263 s |
| Image preparation | 0.139 s | 0.145 s |
| Provider response headers | 61.350 s | 77.919 s |
| Provider response body | 0.087 s | 0.178 s |
| Source extraction and alignment | Not reached | 0.013 s |
| Persist translation and navigation | Not reached | 0.002 s |
| Output tokens, including reasoning | 12,599 | 15,851 |
| Reasoning tokens | 9,833 | 12,171 |
| Cached input tokens | 5,120 | 4,992 |

Provider time accounts for 99.8% of the successful request. The API is not
streamed, so response-header latency includes provider processing and may
include the full generation. It is **not** time to first token. Token counts
suggest reasoning is a substantial contributor, but the API does not report
separate reasoning and answer-generation durations; neither can be measured
individually from these requests.

A repeat of page 34 after source overlap took 78.129 s, with 78.105 s in the
provider request and 2.9 ms in final alignment. Image and source caches were
warm and model output length differed, so this is not a controlled speedup
estimate. It confirms that provider time still dominates after the change.

All six sampled local PDFs had embedded text on their sampled pages. This
explains the inexpensive local extraction. Scans without a text layer can
still invoke Tesseract and incur a longer local tail.

The failed request returned HTTP 200 but invalid JSON inside the model's
translation text. Its trace identifies `response.normalize` as the failure
stage. Increasing rendering concurrency or speeding up SQLite cannot address
this provider output failure.

## Changes

- Look up cached translations before entering the provider queue. Previously a
  cached page could wait for all occupied provider slots, despite needing no
  provider request. Keep the second lookup inside the queue to reuse results
  completed while waiting.
- Start current-page text extraction/OCR after preparing the page images, while
  the provider runs. Use the same extraction, language packs, concurrency
  limits, cache, and alignment algorithm. Await the result before returning the
  translation. Attach extraction error handling immediately and preserve the
  existing readable-translation fallback.
- Keep whole-book translation sequential to preserve the previous-page
  translation context and revision ordering. Reader requests remain bounded by
  the existing shared priority queue.
- Keep model, reasoning effort, prompt, schema, image resolution, adjacent-page
  context, and output fidelity unchanged. A large reduction in model latency
  would require a separately evaluated model or reasoning-setting change.

For the measured text-bearing book, source overlap saves only milliseconds.
It must not be presented as a substantial improvement to the observed
minute-long provider calls. For uncached OCR pages, its potential saving is
approximately the smaller of source extraction time and provider time.

## Validation

`npm run lint` and all 75 tests in `npm test` pass.

The integration suite covers cached pages while the provider queue is full,
shared foreground/background jobs, retries and discards, unchanged translation
structure in both provider protocols, live traces, failed traces, export,
local retention, and reading traces after a process restart. A deterministic
OCR fixture must complete while the mock provider response is still held open;
this verifies overlap without relying on variable provider timings.

Chrome's tracing protocol was also used to record the actual browser timing
helpers: Chrome 153 emitted 36 timing events with the `Verso translation`
custom-track metadata. The trace screen was checked in desktop and mobile
viewports with no JavaScript errors or horizontal overflow.


## Streaming TTFT and the local LiteLLM route

A follow-up investigation on September 11 used deployed streaming traces and
local LiteLLM v1.100.0 spend logs. Verso was configured to send requests to
`https://ai.mrcroxx.com/v1`, through Cloudflare Tunnel and the public Nginx
proxy back to LiteLLM on this same host. LiteLLM then calls the configured
third-party upstream. Nginx already disables response buffering and caching;
LiteLLM was idle outside requests, with no CPU saturation observed.

Matching request timestamps and prompt/completion counts gives:

| Translation | Verso request to LiteLLM start | LiteLLM start to first processed chunk | Verso response headers | Verso first text |
| --- | ---: | ---: | ---: | ---: |
| Most recent page 1 | 45.305 s | 2.032 s | 47.532 s | 86.448 s |
| Page 69 | 22.598 s | 4.972 s | 27.795 s | 113.629 s |
| Page 68 | 4.149 s | 3.895 s | 8.279 s | 46.416 s |
| Page 66 | 28.655 s | 4.215 s | 33.094 s | 96.954 s |

These timestamps share the host clock. LiteLLM's `completionStartTime` marks
its first processed stream chunk, which can be a role-only event; it is not
necessarily the first meaningful token. None of these requests reported a
retry. The pre-LiteLLM interval includes the public network path, connection
setup, and image upload/request buffering before application processing. These
measurements locate the delay before LiteLLM, without isolating a particular
Cloudflare hop or attributing the whole interval to model processing.

A sequential local/public/local probe from the Verso container sent identical
2,852,671-byte requests with three existing page images, the same model and
high reasoning, and a short readability-check prompt. Each successful probe
was cancelled after its first meaningful reasoning/text delta:

| Route | Response headers | First nonempty output |
| --- | ---: | ---: |
| Local host port 4000, run 1 | 3.542 s | 4.123 s |
| Public hostname | No headers before 90 s timeout | Not observed |
| Local host port 4000, run 2 | 3.688 s | 4.544 s |

This is a route probe, not a controlled end-to-end translation benchmark.
Together with the spend logs, it supports removing the public loop from local
Verso requests. The deployment override adds
`host.docker.internal:host-gateway`, and the saved provider endpoint uses
`http://host.docker.internal:4000/v1`. Credentials, model, high reasoning,
prompts, image detail, and translation concurrency are unchanged. The public
LiteLLM entrypoint remains available to other clients.

A second substantial interval remains between early streamed output and the
first answer text: reasoning. Historical `first_text` traces exclude reasoning
and therefore overstate time to first model output. New `provider.first_output`
and `provider.first_reasoning` spans separate those events. Reducing reasoning
strength could change translation quality and was not part of this fix.

Some streaming usage records are internally inconsistent: one request reports
4,860 completion tokens but 10,584 reasoning tokens; another reports 3,848 and
23,820 respectively. Those totals cannot describe combined reasoning and text.
Live counters therefore mark approximate token/TPS values and reject such
usage for calibration. They never count SSE chunks as tokens. Reasoning text
is consumed for numeric statistics only and is neither sent to the browser nor
persisted in traces. See the README for the estimation method and its limits.

### Deployed verification

A complete translation of page 69 through the new local route succeeded with
six validated blocks saved to the existing volume. Trace
`68fc4e7e-fadc-4e20-aa76-96fb33f5d1bf` records:

| Stage | Duration from provider request start |
| --- | ---: |
| Response headers | 3.968 s |
| First nonempty output (reasoning) | 4.612 s |
| First answer text | 58.758 s |
| Total server translation, including preparation and persistence | 77.217 s |

The matching LiteLLM request started at `2026-09-11T03:36:35.046Z`, about
18 ms after Verso submitted the provider request, compared with 22.598 s for
the earlier public-route page 69 request. Output length and reasoning duration
varied between runs, so the difference in whole-page time is not a controlled
route-only speedup. The direct measurement does confirm removal of the long
pre-gateway wait. The client received 449 numeric progress events with no text
preview. Final usage again reported fewer completion tokens (6,774) than
reasoning tokens (14,462), and the counters correctly retained their estimate.

Final validation: lint passed; the production build and all 80 tests passed.
Browser fixtures verified statistics beside the refresh button, absent partial
text, successful final rendering, late-reader progress, and no added horizontal
overflow at desktop and narrow widths. The existing Docker service was rebuilt
and deployed in place and its health check passed. Existing failed whole-book
queues were not restarted as part of the single-page verification.

## Configurable background concurrency

The queue now supports 1–10 simultaneous pages (default 4), including pages of the
same book. This supersedes the sequential background behavior described above.
Its server-persisted setting is independent of reader concurrency, which also
supports 1–10. Work remains bounded and pending reader requests retain priority.
Parallel pages use the same adjacent source images; a previous translation tail
is used only when that page has already completed. Outstanding page state and
per-page retries survive restarts. Each page gets three automatic retries; the
book pauses at three distinct pages that remain failed after those retries.
Recovered pages are removed from that count, and isolated exhausted pages are
skipped so later pages can continue.

## Compact output and conservative source routing (September 12, 2026)

Translation now selects its input and output contract per page. The model,
reasoning effort, requested-page image quality, persistent translation keys,
reader rendering, and provider concurrency settings are unchanged.

### Output contract

Visual translation generates translated text only in `sentences[].text`,
including a single sentence for display equations. The server reconstructs
`block.text` by exact concatenation before normalization, alignment, storage,
and delivery. Images, equation numbers, captions, typography, and previous-page
revision layouts retain their existing representation. Legacy responses with
`block.text` are still accepted; existing caches and imports need no migration.

When local PDF words or high-confidence cached OCR are available, the current
page's provider schema omits sentence rectangles. The existing local alignment
computes them. The schema retains model rectangles when local extraction is
unavailable, and for previous-page revisions. Cold OCR still overlaps provider
generation; it is not added to the serial path just to remove coordinates.

### Source analysis and context

Embedded text, including block and line IDs, is cached under
`renders/<fingerprint>/v2/embedded`. Empty text layers are negatively cached;
failed extraction is retried on a later request. A bounded Cairo SVG inspection
checks for painted graphics, images, hidden text, and unknown rendering forms.
Its result is cached under `v2/textonly`. Analysis failure retains vision.
These derived files are local, reusable across translation languages, and
independent of the translated-page cache.

The text route initially admits only ordinary Latin-script prose with reliable
single-column geometry and consistent typography. Formulas, lists, navigation
pages, unsupported scripts, uncertain text, mixed graphics, and overlapping
columns retain visual translation. Merely having a text layer is insufficient.
Stable sentence IDs map translations back to local source text, source rectangles,
block geometry, and typography. Missing, duplicated, reordered, or empty units,
changed page numbers, and malformed text output cause at most one full-context
visual fallback. Both attempts' reported usage is included in the trace totals;
invalid text output is never cached as a successful page.

Adjacent verified prose pages contribute complete first/last paragraphs, up to
two paragraphs and 3,500 characters. A paragraph is never truncated to fit the
budget. Cached OCR may instead select a full-width half-page image only when
confidence is at least 95, at least 98% of detected words were retained, simple
geometry passes, and both boundary paragraphs fit wholly inside that half with
a margin. Crops retain the original 2,200-pixel full-page scale and JPEG quality.
Cold or uncertain scans retain full adjacent images; crop failure also retains
the full image. No extra neighboring OCR jobs are started for this optimization.

An unfinished cached previous translation preserves the full previous image
and uses the visual route, since the model may need to revise that entire page.
Without a complete previous image, whole-page revisions are disabled. Complex
adjacent pages can therefore still supply full images even when the requested
page uses stable text IDs. Client-supplied image requests retain their visual
path. All extraction, graphics checks, and rendering have bounded concurrency.

### Verification

`tests/translation-optimization.test.mjs` exercises contract restoration,
source coverage, sentence highlights, rejected IDs, geometry and content gates,
complete boundary context, and serialized output size. Native Poppler fixtures
verify ordinary text, vector diagrams, columns, formulas, hidden text, local
analysis reuse/corruption recovery, and actual 1,650-by-1,100 boundary JPEGs.
Native-tool tests skip when Poppler is unavailable.

The HTTP integration suite exercises both provider protocols, exact schemas,
local coordinate restoration, cached translations, preserved reasoning settings,
text context, cropped context, full-image fallback, previous-page context, and
usage accounting across a failed text attempt and its visual retry. Existing
rendering, equations, captions, cross-page words, OCR overlap, queue sharing,
archive, and restart tests remain in the full test command.

Trace attributes include `translationMode`, `localSentenceRects`,
`contextTextPages`, `contextCropPages`, `sourceUnits`, `providerAttempts`,
`optimizationFallback`, and `textValidationFailed`. `request.encode` records
actual request bytes and image count. These distinguish saved input/output work
from queue time or a different provider/model setting.

### Small live comparison

Four paid calls compared the original `89a9020` provider prompt/schema with the
new pipeline on two pages of the existing technical report. Both sides used
`deepseek-flash`, `high` reasoning, Simplified Chinese, identical full-page
render settings, no cached previous translation, and the same local LiteLLM
endpoint. An isolated book/database copy kept live settings and translations
untouched. Baseline measurements start after image rendering; optimized times
include the API's local preparation, alignment and persistence, so these are
observations rather than a controlled provider-only latency benchmark.

| Page and route | Input tokens, before → after | Output tokens including reasoning, before → after | Observed seconds, before → after |
| --- | ---: | ---: | ---: |
| 51, short prose / stable IDs | 4,605 → 1,464 | 1,815 → 393 | 8.64 → 3.37 |
| 5, figure and inline math / vision | 5,614 → 5,447 | 19,700 → 15,521 | 72.19 → 60.76 |

Page 51 retained a full previous-page context image because that neighboring
page was complex. Its requested-page image was removed (two images became
one). Page 5 retained all three images; output reduction came from the compact
contract and different model reasoning, not reduced image detail. Reasoning
counts were 1,168 → 277 and 15,474 → 13,431 respectively. Each optimized request
completed in one provider attempt.

Manual source/translation comparison found no missing sentences in these two
samples. Page 51 retained all four source units including its page number;
page 5 retained its figure, caption, all 22 sentence mappings, numeric claims,
and cross-page continuation. All 26 sentence mappings grounded successfully
in the local source on both sides. The four inline LaTeX expressions on page 5
were identical between outputs and rendered with KaTeX. Translated wording and
some spacing/crop estimates varied; this is not a claim of identical pixels or
unchanged quality on every page.

The live runs used a development build; final cache-validation and independent
previous-revision schema guards were subsequently verified by tests.

These two single-run samples do not establish a general percentage saving.
Page 51 is unusually short, generation is stochastic, and input cache state
can differ. Token counts are provider-reported usage, not measured currency
cost; cached-input pricing and model rates must be accounted for separately.
No extra live calls were made solely to obtain a more favorable result.

Final validation: `npm run lint` passed without warnings. `npm test` completed
the production build and 134 tests: 130 passed, zero failed, and four existing
GUI tests skipped in the headless environment. Native Poppler tests ran and
passed. The running Docker deployment was not replaced by this development run.

## Source presentation corrections

Image crops now use the locally aligned bounds of separately translated body text,
headings, captions and page numbers to exclude neighboring prose on all four sides.
The same bounds limit whitespace expansion so it cannot bring excluded text back.
Ambiguous overlaps through the central artwork retain the estimated crop. Raw OCR
words inside diagrams and code images are not treated as exclusion regions.

PDF typography uses font sizes from optional local `pdftohtml` XML metadata when
page dimensions, word positions and text agree. This avoids treating an inflated
font bounding box as the font's em size. Without usable font metadata, estimates
aggregate letter-weighted word heights by line; narrow letters and punctuation no
longer reduce the estimated size. Titles, captions and body text retain their own
source measurements, and equations retain their existing typography.

Embedded PDF analysis uses cache version 3 and enriched word layouts use version 2.
Existing OCR caches remain reusable. Translation cache keys and content are
unchanged; cached translations receive these corrections when their source layout
loads in the reader. No additional model requests are needed.

Programming listings now have a `code` block kind. The compact provider contract
returns code once, verbatim in a sentence, with the language label in `marker`.
The reader renders literal text in a selectable `<pre><code>` element, preserving
indentation and line breaks and allowing horizontal scrolling without cropping.
Code content is never executed or interpreted as HTML or translated prose.

For existing image blocks, local PDF word geometry can recover explicitly labelled,
monospaced listings, including lines just outside a clipped model estimate. It
removes only a verified consecutive line-number gutter and restores spacing from
character widths. Unlabelled diagrams, ambiguous extraction and OCR retain the
image fallback. Source line wrapping is preserved, including wraps inside strings;
this is a transcription of the printed listing, not an automatic syntax repair.
Existing translation caches remain valid and need no provider calls for recovery.

Readable text tables use consecutive `table_header` / `table_row` blocks, with one
sentence entry per cell. This reuses the compact output contract: translated cell
text is generated once, and empty cells retain their column positions. The reader
groups rows into a semantic HTML table with column headers, source-informed column
widths, wrapped cell contents and horizontal overflow for narrow viewports.
Complex merged-cell and graphical tables retain the image fallback.

Legacy paragraphs are upgraded locally only when a horizontally separated header
and at least two data rows match every cell's source text within its own PDF column.
Ambiguous or merged sentence mappings remain unchanged rather than guessing how to
split translated text. Cached content is preserved, and this recovery makes no
provider requests. Table cell highlights use column-specific matches, avoiding
partial matches such as `Action` inside `transaction` in a neighboring cell.

Code blocks now use locally measured font sizes for model-produced listings as
well as recovered listings. Display size is bounded to 12–16 px at the default
reader scale (13 px without a source measurement), then multiplied once by the
user's translation font scale. Both `pre` and `code` explicitly inherit this size.

Each code block has a localized copy button with success/failure feedback. Copying
uses the literal code string, including indentation and final newlines. The secure
Clipboard API is preferred; a temporary selected textarea provides a fallback for
LAN HTTP readers and restores focus/selection afterward. No code is executed and
no model requests are involved.

Explicit table rows now align independently of legacy table detection. Text anchors
recover source columns even when model row coordinates are inaccurate, including
single-row and headerless tables. Matching respects whole-word boundaries, uses
reading order for repeated values, and clears ungrounded rectangles. Reliable OCR
word matches can also supply cell highlights without upgrading arbitrary OCR prose
to a table. No additional provider request is required.

Each mapped table cell is a keyboard focus target and highlights its source lines
when hovered, including cell padding. Leaving or blurring the cell clears the
source overlay. Nested text hover handlers are suppressed inside table cells, and
cells whose typewriter content has not yet appeared remain inactive.

Image canvases now highlight their source region on hover or keyboard focus. The
mapping uses the final pixel crop normalized to page coordinates, including local
edge recovery and caption/body exclusions. Active highlights update when the crop
changes and clear when the image is left, blurred, unloaded or unmounted. Caption
interaction remains independent. This applies to existing cached image blocks
without changing translation content or making provider requests.
