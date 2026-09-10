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
