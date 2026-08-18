export type StoredBook = {
  id: string;
  fingerprint: string;
  name: string;
  objectKey: string;
  size: number;
  pageCount: number;
  contentType: string;
  uploadedAt: number;
};

type StorageBindings = {
  DB?: D1Database;
  BOOKS?: R2Bucket;
};

let schemaReady: Promise<void> | undefined;
let storageBindings: StorageBindings = {};

export function setStorageBindings(bindings: StorageBindings) {
  storageBindings = bindings;
}

export function getStorage() {
  if (!storageBindings.DB || !storageBindings.BOOKS) {
    throw new Error("Cloud book storage is unavailable in this environment.");
  }
  return { db: storageBindings.DB, bucket: storageBindings.BOOKS };
}

export async function ensureStorageSchema(db: D1Database) {
  schemaReady ??= (async () => {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        object_key TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL,
        page_count INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        uploaded_at INTEGER NOT NULL
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS books_uploaded_at_idx ON books (uploaded_at DESC)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS translations (
        cache_key TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS translations_document_page_idx ON translations (document_id, page)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS navigation_pages (
        document_id TEXT NOT NULL,
        pdf_page INTEGER NOT NULL,
        is_table_of_contents INTEGER NOT NULL,
        toc_entries TEXT NOT NULL,
        page_label TEXT,
        page_value INTEGER,
        numbering TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (document_id, pdf_page)
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS navigation_pages_document_idx ON navigation_pages (document_id, pdf_page)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS navigation_settings (
        document_id TEXT PRIMARY KEY NOT NULL,
        manual_offset INTEGER,
        updated_at INTEGER NOT NULL
      )`),
    ]);
  })();
  return schemaReady;
}

export function mapBook(row: Record<string, unknown>): StoredBook {
  return {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    name: String(row.name),
    objectKey: String(row.object_key),
    size: Number(row.size),
    pageCount: Number(row.page_count),
    contentType: String(row.content_type),
    uploadedAt: Number(row.uploaded_at),
  };
}

export async function findBook(db: D1Database, id: string) {
  await ensureStorageSchema(db);
  const row = await db.prepare("SELECT * FROM books WHERE id = ?1 OR fingerprint = ?1 LIMIT 1").bind(id).first();
  return row ? mapBook(row) : null;
}
