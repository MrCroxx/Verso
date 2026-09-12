import { ensureStorageSchema, findBook, getStorage, mapBook, type LocalDatabase } from "../db/books";
import { normalizeNavigationObservation, type NavigationObservation } from "./document-navigation";
import { MAX_TRANSLATION_ARCHIVE_BYTES, TRANSLATION_ARCHIVE_FORMAT, TRANSLATION_ARCHIVE_VERSION } from "./translation-archive";

type ArchiveBook = {
  fingerprint: string;
  name: string;
  pageCount: number;
  translations: { key: string; page: number; translation: Record<string, unknown>; updatedAt: number }[];
  navigation: { observations: NavigationObservation[]; manualOffset: number | null };
};

export class TranslationArchiveError extends Error {
  constructor(public code: string, public status = 400) {
    super(code);
  }
}

function invalid(): never {
  throw new TranslationArchiveError("INVALID_ARCHIVE");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function validPage(value: unknown, pageCount: number): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= pageCount;
}

function parseArchive(value: unknown): ArchiveBook[] {
  const archive = object(value);
  if (archive.format !== TRANSLATION_ARCHIVE_FORMAT || archive.version !== TRANSLATION_ARCHIVE_VERSION || !Array.isArray(archive.books)) invalid();
  const fingerprints = new Set<string>();
  return archive.books.map((value) => {
    const book = object(value);
    if (typeof book.fingerprint !== "string" || !/^(?:[a-f0-9]{64}|fnv1a-[a-f0-9]{16})$/.test(book.fingerprint)
      || fingerprints.has(book.fingerprint) || typeof book.name !== "string"
      || !Number.isSafeInteger(book.pageCount) || Number(book.pageCount) < 1 || !Array.isArray(book.translations)) invalid();
    fingerprints.add(book.fingerprint);
    const fingerprint = book.fingerprint;
    const pageCount = Number(book.pageCount);
    const keys = new Set<string>();
    const translations = book.translations.map((value) => {
      const entry = object(value);
      if (!validPage(entry.page, pageCount) || typeof entry.key !== "string" || entry.key.length > 2048
        || !/^layout-v(?:3|4)::/.test(entry.key) || keys.has(entry.key)
        || !Number.isSafeInteger(entry.updatedAt) || Number(entry.updatedAt) < 0) invalid();
      const parts = entry.key.split("::");
      if (parts[1] !== fingerprint || parts[2] !== String(entry.page) || parts.length < 4 || !parts.at(-1)) invalid();
      keys.add(entry.key);
      const translation = object(entry.translation);
      if ((translation.page !== undefined && translation.page !== entry.page)
        || (!Array.isArray(translation.blocks) && typeof translation.markdown !== "string")
        || (translation.blocks !== undefined && (!Array.isArray(translation.blocks)
          || translation.blocks.some((block) => !block || typeof block !== "object" || Array.isArray(block) || typeof block.text !== "string")))
        || (translation.cacheVersion !== undefined && (!Number.isSafeInteger(translation.cacheVersion) || Number(translation.cacheVersion) < 0))
        || Buffer.byteLength(JSON.stringify(translation)) > 1024 * 1024) invalid();
      return { key: entry.key, page: entry.page, translation, updatedAt: Number(entry.updatedAt) };
    });
    const navigation = object(book.navigation);
    if (!Array.isArray(navigation.observations)
      || (navigation.manualOffset !== null && (!Number.isSafeInteger(navigation.manualOffset) || Math.abs(Number(navigation.manualOffset)) > 10000))) invalid();
    const pages = new Set<number>();
    const observations = navigation.observations.map((value) => {
      const observation = object(value);
      if (!validPage(observation.pdfPage, pageCount) || pages.has(observation.pdfPage)
        || typeof observation.isTableOfContents !== "boolean" || !Array.isArray(observation.tocEntries)
        || JSON.stringify(observation.tocEntries).length > 256 * 1024) invalid();
      pages.add(observation.pdfPage);
      return normalizeNavigationObservation(observation);
    });
    return { fingerprint, name: book.name, pageCount, translations, navigation: { observations, manualOffset: navigation.manualOffset as number | null } };
  });
}

async function selectedBook(db: LocalDatabase, documentId: string | null) {
  if (documentId === null) return null;
  if (!documentId || documentId.length > 128) throw new TranslationArchiveError("BOOK_NOT_FOUND", 404);
  const book = await findBook(db, documentId);
  if (!book) throw new TranslationArchiveError("BOOK_NOT_FOUND", 404);
  return book;
}

export async function exportTranslationArchive(documentId: string | null) {
  const { db } = getStorage();
  await ensureStorageSchema(db);
  const selected = await selectedBook(db, documentId);
  const books = selected ? [selected] : (await db.prepare("SELECT * FROM books ORDER BY uploaded_at DESC").all()).results.map(mapBook);
  const archived: ArchiveBook[] = [];
  let bytes = 0;
  for (const book of books) {
    const translations = await db.prepare("SELECT cache_key, page, payload, updated_at FROM translations WHERE document_id = ?1 ORDER BY page, cache_key")
      .bind(book.fingerprint).all<{ cache_key: string; page: number; payload: string; updated_at: number }>();
    const pages = await db.prepare("SELECT * FROM navigation_pages WHERE document_id = ?1 ORDER BY pdf_page").bind(book.fingerprint).all();
    const settings = await db.prepare("SELECT manual_offset FROM navigation_settings WHERE document_id = ?1").bind(book.fingerprint).first();
    const entry: ArchiveBook = {
      fingerprint: book.fingerprint, name: book.name, pageCount: book.pageCount,
      translations: translations.results.map((row) => ({ key: row.cache_key, page: row.page, translation: JSON.parse(row.payload), updatedAt: row.updated_at })),
      navigation: {
        observations: pages.results.map((row) => normalizeNavigationObservation({
          pdfPage: row.pdf_page, isTableOfContents: Boolean(row.is_table_of_contents), tocEntries: JSON.parse(String(row.toc_entries)),
          anchor: row.page_label ? { label: row.page_label, value: row.page_value, numbering: row.numbering } : null,
        })),
        manualOffset: settings?.manual_offset == null ? null : Number(settings.manual_offset),
      },
    };
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (bytes > MAX_TRANSLATION_ARCHIVE_BYTES) throw new TranslationArchiveError("ARCHIVE_TOO_LARGE", 413);
    archived.push(entry);
  }
  const exportedAt = new Date();
  const archive = JSON.stringify({ format: TRANSLATION_ARCHIVE_FORMAT, version: TRANSLATION_ARCHIVE_VERSION, exportedAt: exportedAt.toISOString(), books: archived });
  if (Buffer.byteLength(archive) > MAX_TRANSLATION_ARCHIVE_BYTES) throw new TranslationArchiveError("ARCHIVE_TOO_LARGE", 413);
  const filename = selected ? `verso-${selected.fingerprint.slice(0, 16)}-translations` : "verso-library-translations";
  return { archive, filename: `${filename}-${exportedAt.getTime()}.json` };
}

export async function importTranslationArchive(value: unknown, documentId: string | null) {
  // Validate the entire archive before touching storage, including unmatched books.
  const books = parseArchive(value);
  const { db } = getStorage();
  await ensureStorageSchema(db);
  const selected = await selectedBook(db, documentId);
  if (selected && (books.length !== 1 || books[0].fingerprint !== selected.fingerprint)) {
    throw new TranslationArchiveError("BOOK_MISMATCH");
  }
  const statements = [];
  let translationCount = 0;
  let matchedBooks = 0;
  let missingBooks = 0;
  const navigationStatements = [];
  for (const book of books) {
    const local = selected || await findBook(db, book.fingerprint);
    if (!local) { missingBooks++; continue; }
    if (local.pageCount !== book.pageCount) throw new TranslationArchiveError("BOOK_MISMATCH");
    matchedBooks++;
    for (const entry of book.translations) {
      // Ignore conflicts so importing a backup cannot replace local or in-flight work.
      statements.push(db.prepare(`INSERT INTO translations (cache_key, document_id, page, payload, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(cache_key) DO NOTHING`)
        .bind(entry.key, local.fingerprint, entry.page, JSON.stringify(entry.translation), entry.updatedAt));
      translationCount++;
    }
    for (const observation of book.navigation.observations) {
      navigationStatements.push(db.prepare(`INSERT INTO navigation_pages
        (document_id, pdf_page, is_table_of_contents, toc_entries, page_label, page_value, numbering, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(document_id, pdf_page) DO NOTHING`)
        .bind(local.fingerprint, observation.pdfPage, observation.isTableOfContents ? 1 : 0, JSON.stringify(observation.tocEntries),
          observation.anchor?.label ?? null, observation.anchor?.value ?? null, observation.anchor?.numbering ?? null, Date.now()));
    }
    if (book.navigation.manualOffset !== null) {
      navigationStatements.push(db.prepare(`INSERT INTO navigation_settings (document_id, manual_offset, updated_at)
        VALUES (?1, ?2, ?3) ON CONFLICT(document_id) DO NOTHING`).bind(local.fingerprint, book.navigation.manualOffset, Date.now()));
    }
  }
  const results = await db.batch([...statements, ...navigationStatements]);
  const imported = results.slice(0, translationCount).reduce((count, result) => count + Number(result.changes), 0);
  return { books: matchedBooks, imported, retained: translationCount - imported, missingBooks };
}
