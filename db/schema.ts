import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
