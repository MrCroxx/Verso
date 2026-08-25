# Verso

Verso is an AI-powered web reader for scanned PDF books. It keeps the original
page visible beside a layout-aware translation, so you can read across
languages without losing the typography, illustrations, or structure of the
source.

![Verso reader showing a scanned page and its translation side by side](./docs/images/reader-light.png)

## Features

- **Side-by-side reading:** compare the source scan and translation while
  navigating pages from a persistent sidebar with reading progress.
- **Two-stage layout translation:** use a configurable vision model to recognize
  source text, semantic roles, positions, and reading order, then send the
  structured text to a separately configurable translation model.
- **Cross-page ownership:** recognize incoming and outgoing page fragments,
  claim each connected fragment group once inside the bounded prefetch window,
  and leave out-of-window fragments visibly pending until their neighbor is
  available.
- **Server-managed AI providers:** use the OpenAI Responses API or an
  OpenAI-compatible endpoint without exposing provider credentials to the
  browser. Provider settings are stored in server-side SQLite together with
  the local library metadata.
- **Local library and caching:** keep uploaded PDFs, page indexes, blank-page
  results, and translations in the Docker data volume so books remain available
  across reading sessions without a cloud storage service.
- **Automatic contents navigation:** detect translated contents pages, preserve
  printed page references, and calibrate PDF page offsets automatically or
  manually.
- **Translation search:** search locally cached translations, jump directly to a
  result, and highlight matches without scanning or retranslating the book.
- **Large-book performance:** lazily rasterize requested pages on the server,
  persist display and vision derivatives in the local volume, and bound both
  page rendering and background translation work.
- **Reader preferences:** switch the interface between English and Simplified
  Chinese independently of the translation target, choose a light or dark
  theme, and configure animated page navigation without altering the source
  scan.

## Screenshots

### Translation configuration

Open Settings to configure the server provider and tune the target language,
prefetch behavior, and parallelism for the provider's limits. Provider
credentials, endpoints, recognition and translation models, and reasoning
settings are stored in the server-side SQLite database. The API key is never
returned by the settings API.

![Verso translation and reading settings](./docs/images/ai-settings.png)

### Dark theme

The reader chrome and translated page adapt to dark mode while the scanned page
retains its original appearance.

![Verso reader in dark mode](./docs/images/reader-dark.png)

## Technology

- React 19 and the Next.js App Router.
- Poppler for server-side, volume-backed page rasterization, with PDF.js as a
  browser fallback for files that have not finished uploading.
- SQLite for metadata, navigation indexes, recognition results, and translation
  records.
- The local filesystem for uploaded PDF objects.
- TypeScript, Tailwind CSS, and Lucide icons.

## Requirements

- Node.js 22.13 or newer.
- npm.
- Poppler's `pdftocairo` for the server page cache in non-Docker deployments.
  The Docker image already includes it; without it, the reader falls back to
  PDF.js in the browser.

## Local Development

```bash
npm ci
npm run dev
```

On Debian or Ubuntu, install the optional server renderer with
`apt-get install poppler-utils`. The development server listens on
`0.0.0.0:3000`. Open
`http://localhost:3000` locally or use the machine hostname from another device
on the same network.

Start Verso, open Settings, and save the AI provider configuration. Verso does
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
