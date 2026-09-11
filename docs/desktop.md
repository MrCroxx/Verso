# macOS desktop app

Verso supports a local Electron app alongside its Docker deployment. Both use
the same Next.js build, API handlers, SQLite schema, PDF renderer, and bounded
translation queue. The desktop app does not require a remote Verso server.
AI translation still requires a configured provider and connectivity to it.

## Use the app

Open `Verso.app` from the disk image and copy it to Applications. The app bundles
Node.js, Poppler, Tesseract, their non-system dynamic libraries, and English,
Simplified Chinese, Traditional Chinese, and Japanese OCR data. End users do
not need Docker, Homebrew, or a separate Node installation.

Books, page images, indexes, translations, and provider settings live in
`~/Library/Application Support/Verso/library`. Back up this directory with the
app fully quit. Replacing the app does not replace the library. Docker continues
to use its `/data` volume; these libraries are independent.

Closing the last window on macOS keeps background translation running. Click
the Dock icon to reopen the reader. **Verso > Quit Verso** (Cmd+Q) stops the
backend and its PDF/OCR children. Saved queue progress resumes on the next
launch; an interrupted page may be requested again. System sleep pauses work.
Only one instance can use the desktop library at a time.

## Develop

On a Mac with Node.js 22.13 or newer and npm:

```bash
brew install poppler tesseract tesseract-lang
npm ci
npm run desktop:dev
```

This builds the production reader and launches it in Electron using the local
Node installation and native tools. Run it again after changing the web app.
For frontend hot reload, use the existing `npm run dev` web workflow, which
continues to bind to `0.0.0.0`.

## Build an installer

Build on a Mac matching the desired architecture, with the dependencies above:

```bash
VERSO_MAC_UNSIGNED=1 npm run desktop:package
```

The command runs lint and tests, prepares a standalone server, bundles the
native tools, and creates `dist/desktop/Verso-<version>-<arch>.dmg` and `.zip`.
It then runs the packaged app smoke test before reporting success.
Use `-- --dir` to build only the `.app`. Apple Silicon and Intel installers
are separate; cross-compiling the native dependencies is intentionally rejected.
The minimum usable macOS version depends on the bundled Homebrew binaries.
The workflow currently builds and tests on macOS 15; earlier versions are not
validated.

`VERSO_MAC_UNSIGNED=1` creates an ad-hoc signed build for local testing, without
Apple notarization. It is not a Developer ID release and Gatekeeper may require
an explicit local override. For Developer ID builds, omit that variable and
install a Developer ID signing identity in the macOS keychain. Set
`VERSO_MAC_SIGN_IDENTITY` to select a specific identity, or leave it unset for
automatic discovery. For notarization, supply `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`, or `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. No credentials are stored in the repo.
See [Electron signing](https://github.com/electron/osx-sign)
and [notarization](https://github.com/electron/notarize).

Packaging uses the official `@electron/packager` with macOS `hdiutil` and `ditto`
for DMG and ZIP files. Dependencies are locked to patched versions. npm's
`allowScripts` policy explicitly approves the reviewed native resolver setup;
unrelated install scripts are not blanket-approved.

The **macOS Desktop** GitHub Actions workflow produces ad-hoc signed arm64 and
x64 artifacts on every push to `main`, manual dispatch, version tags, and pull
requests affecting the desktop build. Download the DMG and ZIP installers from
the successful run's `Verso-macOS-arm64` or `Verso-macOS-x64` artifacts. It does
not upload GitHub Releases. Docker image publishing continues through the
existing CI workflow.

## Packaging and validation

The Electron renderer uses a stable `https://verso.localhost` origin intercepted
inside the app, without DNS or an external HTTPS server, so theme, locale,
and reader preferences survive backend port changes. The backend listens only
on a randomly allocated `127.0.0.1` port. A per-launch token is added by the
main-process protocol handler; unauthenticated requests are rejected before
Next.js handles them. The renderer has no Node integration, uses context
isolation and sandboxing, and cannot navigate to remote servers.

The desktop launcher uses Next's internal `getRequestHandlers` from the pinned
Next version, with the generated standalone configuration. Re-run desktop
integration and packaged smoke tests when updating Next. It disables on-disk
ISR writes so the signed application bundle stays read-only.

Native packaging follows Mach-O dependencies recursively, rewrites load paths
relative to the bundled binaries, and rejects unresolved external dependencies
or wrong architectures. Poppler's embedded Homebrew data path is replaced with
a shorter relative path before signing; its subprocesses run from the bundled
`server` directory. Fontconfig uses system fonts and a writable library cache.
Package receipts, formula metadata, available license notices, and a native
binary manifest are included under `Contents/Resources/native`. Preserve
upstream licenses and provide corresponding sources required by bundled
components when redistributing installers.

```bash
npm test
node scripts/smoke-macos.mjs dist/desktop/mac-arm64/Verso.app
# Intel: dist/desktop/mac/Verso.app
```

The integration tests cover authenticated access, host validation, settings
persistence, process shutdown, startup failure, and startup timeout. The macOS
smoke test relocates the app to a directory containing spaces, clears Homebrew
from PATH, verifies signatures, exercises bundled SQLite, renders and extracts
a PDF, loads all four OCR languages, and opens the actual Electron window with
an isolated temporary library. The window test uploads a PDF through the reader,
checks range downloads and page rendering, updates settings, verifies locale
persistence, and receives a translation event stream without making a provider
request. This macOS test must pass before treating an installer as validated.
