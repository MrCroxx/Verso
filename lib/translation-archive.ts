export const TRANSLATION_ARCHIVE_FORMAT = "verso-translations";
export const TRANSLATION_ARCHIVE_VERSION = 1;
export const MAX_TRANSLATION_ARCHIVE_BYTES = 100 * 1024 * 1024;

export type TranslationImportResult = {
  books: number;
  imported: number;
  retained: number;
  missingBooks: number;
};
