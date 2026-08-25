import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

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

type SqlValue = string | number | bigint | Uint8Array | null;

export class LocalStatement {
  private values: SqlValue[] = [];
  private readonly statement: StatementSync;

  constructor(statement: StatementSync) {
    this.statement = statement;
  }

  bind(...values: SqlValue[]) {
    this.values = values;
    return this;
  }

  async first<T extends Record<string, unknown>>() {
    return this.statement.get(...this.values) as T | undefined;
  }

  async all<T extends Record<string, unknown>>() {
    return { results: this.statement.all(...this.values) as T[] };
  }

  async run() {
    return this.statement.run(...this.values);
  }
}

export class LocalDatabase {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  prepare(query: string) {
    return new LocalStatement(this.database.prepare(query));
  }

  async batch(statements: LocalStatement[]) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  optimize() {
    this.database.exec("PRAGMA optimize");
  }
}

const dataDirectory = process.env.VERSO_DATA_DIR || ".data";
const booksDirectory = `${dataDirectory}/books`;
const uploadsDirectory = `${dataDirectory}/uploads`;
const rendersDirectory = `${dataDirectory}/renders`;
const databasePath = `${dataDirectory}/verso.sqlite`;

let storage: {
  db: LocalDatabase;
  booksDirectory: string;
  uploadsDirectory: string;
  rendersDirectory: string;
} | undefined;
let schemaReady: Promise<void> | undefined;

export function getStorage() {
  if (storage) return storage;
  mkdirSync(/* turbopackIgnore: true */ booksDirectory, { recursive: true });
  mkdirSync(/* turbopackIgnore: true */ uploadsDirectory, { recursive: true });
  mkdirSync(/* turbopackIgnore: true */ rendersDirectory, { recursive: true });
  const sqlite = new DatabaseSync(/* turbopackIgnore: true */ databasePath);
  sqlite.exec("PRAGMA busy_timeout = 5000");
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  hardenStoragePermissions();
  storage = { db: new LocalDatabase(sqlite), booksDirectory, uploadsDirectory, rendersDirectory };
  return storage;
}

export async function ensureStorageSchema(db: LocalDatabase = getStorage().db) {
  schemaReady ??= (async () => {
    const statements = [
      `CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        object_key TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL,
        page_count INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        uploaded_at INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS books_uploaded_at_idx ON books (uploaded_at DESC)",
      `CREATE TABLE IF NOT EXISTS translations (
        cache_key TEXT PRIMARY KEY NOT NULL,
        document_id TEXT NOT NULL,
        page INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS translations_document_page_idx ON translations (document_id, page)",
      `CREATE TABLE IF NOT EXISTS navigation_pages (
        document_id TEXT NOT NULL,
        pdf_page INTEGER NOT NULL,
        is_table_of_contents INTEGER NOT NULL,
        toc_entries TEXT NOT NULL,
        page_label TEXT,
        page_value INTEGER,
        numbering TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (document_id, pdf_page)
      )`,
      "CREATE INDEX IF NOT EXISTS navigation_pages_document_idx ON navigation_pages (document_id, pdf_page)",
      `CREATE TABLE IF NOT EXISTS navigation_settings (
        document_id TEXT PRIMARY KEY NOT NULL,
        manual_offset INTEGER,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ai_provider_settings (
        id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
        provider TEXT NOT NULL CHECK (provider IN ('openai', 'compatible')),
        endpoint TEXT NOT NULL,
        api_key TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL CHECK (reasoning_effort IN ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
        updated_at INTEGER NOT NULL
      )`,
    ];
    for (const statement of statements) await db.prepare(statement).run();
    db.optimize();
    hardenStoragePermissions();
  })();
  return schemaReady;
}

export function hardenStoragePermissions() {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(/* turbopackIgnore: true */ path)) {
      chmodSync(/* turbopackIgnore: true */ path, 0o600);
    }
  }
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

export async function findBook(db: LocalDatabase, id: string) {
  await ensureStorageSchema(db);
  const row = await db.prepare("SELECT * FROM books WHERE id = ?1 OR fingerprint = ?1 LIMIT 1").bind(id).first();
  return row ? mapBook(row) : null;
}

export function resolveBookPath(objectKey: string) {
  if (!/^books\/[a-z0-9-]+\.pdf$/.test(objectKey)) throw new Error("Invalid local book path.");
  return `${dataDirectory}/${objectKey}`;
}

export function resolveUploadDirectory(uploadId: string) {
  if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new Error("Invalid upload session.");
  return `${uploadsDirectory}/${uploadId}`;
}

export function resolveRenderPath(
  fingerprint: string,
  version: string,
  profile: string,
  page: number,
) {
  if (!/^(?:[a-f0-9]{64}|fnv1a-[a-f0-9]{16})$/.test(fingerprint)) {
    throw new Error("Invalid render fingerprint.");
  }
  if (!/^v\d+$/.test(version) || !/^[a-z]+$/.test(profile)) {
    throw new Error("Invalid render profile.");
  }
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Invalid render page.");
  return `${rendersDirectory}/${fingerprint}/${version}/${profile}/${String(page).padStart(6, "0")}.jpg`;
}
