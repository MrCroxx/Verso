# Translation traces

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

See [the performance investigation](translation-performance.md) for
measurements, changes, and their practical limits.
