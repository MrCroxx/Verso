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
