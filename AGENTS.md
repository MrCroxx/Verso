# Repository Guidelines

## Language

- Write commit messages, code comments, identifiers, documentation, pull request titles, and pull request descriptions in English.
- User-facing localization resources and translated book content may use their target language.

## Git and GitHub

- Use Conventional Commits for pull request titles, for example `feat: add keyboard navigation`.
- Keep commit messages concise and written in English.
- Sign commits cryptographically and include a DCO sign-off whenever the local environment supports both.

## Validation

- Run `npm run lint` before publishing changes.
- Run `npm test` for changes that affect application behavior, storage, rendering, or build configuration.
- Keep the local development server bound to `0.0.0.0` so the application remains reachable from the LAN.

## Product Constraints

- Keep uploaded books, page indexes, and translation results in cloud-backed storage rather than browser caches.
- Preserve lazy PDF rendering and bounded translation concurrency for large scanned books.
- Keep interface locale independent from the translation target language.
