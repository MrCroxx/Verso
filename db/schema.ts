import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const books = sqliteTable("books", {
  id: text("id").primaryKey(),
  fingerprint: text("fingerprint").notNull().unique(),
  name: text("name").notNull(),
  objectKey: text("object_key").notNull().unique(),
  size: integer("size").notNull(),
  pageCount: integer("page_count").notNull(),
  contentType: text("content_type").notNull(),
  uploadedAt: integer("uploaded_at").notNull(),
});

export const translations = sqliteTable(
  "translations",
  {
    cacheKey: text("cache_key").primaryKey(),
    documentId: text("document_id").notNull(),
    page: integer("page").notNull(),
    payload: text("payload").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("translations_document_page_idx").on(table.documentId, table.page)],
);

export const navigationPages = sqliteTable(
  "navigation_pages",
  {
    documentId: text("document_id").notNull(),
    pdfPage: integer("pdf_page").notNull(),
    isTableOfContents: integer("is_table_of_contents", { mode: "boolean" }).notNull(),
    tocEntries: text("toc_entries").notNull(),
    pageLabel: text("page_label"),
    pageValue: integer("page_value"),
    numbering: text("numbering"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.pdfPage] }),
    index("navigation_pages_document_idx").on(table.documentId, table.pdfPage),
  ],
);

export const navigationSettings = sqliteTable("navigation_settings", {
  documentId: text("document_id").primaryKey(),
  manualOffset: integer("manual_offset"),
  updatedAt: integer("updated_at").notNull(),
});
