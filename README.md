# Verso

Verso is a web reader for scanned PDF books. It renders the source scan and an
AI-generated, layout-aware translation side by side while keeping large books
responsive through lazy page rendering and bounded translation concurrency.

## Features

- Vision translation through the OpenAI Responses API or compatible providers.
- Configurable provider endpoint, model, reasoning effort, target language,
  prefetch range, and translation concurrency.
- Layout-aware translation blocks for headings, paragraphs, lists, captions,
  whitespace, and page numbers.
- Bounded cross-page context with previous-page revision and deterministic
  boundary deduplication.
- Cloud-backed PDF, page index, blank-page, and translation caches.
- On-demand rendering and translation suitable for scanned books with hundreds
  of pages.
- Simplified Chinese and English interface locales.
- Light and dark interface themes without altering the scanned source image.

## Technology

- React 19 and the Next.js App Router API through vinext.
- PDF.js for browser-side scanned page rendering.
- Cloudflare D1 for metadata and translation records.
- Cloudflare R2 for uploaded PDF objects.
- TypeScript, Tailwind CSS, and Lucide icons.

## Requirements

- Node.js 22.13 or newer.
- npm.

## Local Development

```bash
npm ci
npm run dev
```

The development server listens on `0.0.0.0:3000`. Open
`http://localhost:3000` locally or use the machine hostname from another device
on the same network.

Provider credentials are configured in the application. Translation results,
uploaded books, and page indexes are not stored in browser caches.

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
