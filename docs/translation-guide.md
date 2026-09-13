# Translation guide

## Configure an AI provider

Open **Settings → AI provider**, choose OpenAI or OpenAI Compatible, and enter
an endpoint, API key, and model. Use **Test connection** to verify the setup.
Configuration saves automatically in the local SQLite database. API keys are
never returned in full by the settings API; the UI receives a masked hint.
Verso does not load provider credentials from environment variables.

Choose a provider model that accepts images for scanned pages and complex
layouts. Pages and context required for translation are sent to that provider.
The PDF library, page indexes, and saved results remain in local filesystem
storage. The browser stores interface and reading preferences, not books or
translations.

Choose the translation target separately from the interface language. Older
cached pages remain readable; retranslate a page to regenerate its structure,
figures, formulas, and sentence mappings with the current translation format.
Source regions that cannot be matched reliably are not highlighted.

## Usage and estimated cost

The reader can display reported token usage, generation speed, and estimated
translation cost when the provider supplies the necessary usage data. Configure
input, output, and optional cached-input prices in **Settings → AI provider**.
Select the matching currency and pricing schedule. Estimates use your configured
rates and are not provider billing statements; changing the endpoint or model
clears the previous prices. Older translations may have no usage data.

Use [translation traces](translation-traces.md) for per-stage timings, live
counter semantics, provider timeouts, and diagnostic exports.

## Translation backups

Use **Export library translations** in **Settings → Library** to export every local
book, or **Export translations** in a book's three-dot reading menu to export that book.
The versioned JSON file includes translations in every target language, layout
and source alignment data, contents, and page number settings. It excludes PDF
files, provider credentials, and translation jobs.

Use the corresponding **Import** action to restore a file. Upload the matching
PDFs first: books are matched by fingerprint, even when their local IDs differ.
Imports add missing records and retain existing translations and navigation.
Errors and missing PDFs are reported; successful imports and exports finish
without an extra message. A book's reading menu accepts only that book's export; Settings → Library
accepts both single-book and whole-library files. Files are limited to 100 MB.

## Background translation queue

Open **Translation queue** from the library to see jobs in every target language,
page progress, retry counts, and provider errors. Library cards show concise
progress and link to the queue when a task needs attention. Raw background
errors appear only in the queue view.

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
