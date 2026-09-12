export const TRANSLATION_CACHE_LAYOUT_VERSION = "layout-v4";
export const TRANSLATION_CACHE_SERVER_VERSION = "server-v2";

export function translationCacheSuffix(targetLanguage: string) {
  return `${TRANSLATION_CACHE_SERVER_VERSION}::${targetLanguage}`;
}

export function translationCacheKey(documentId: string, page: number, targetLanguage: string) {
  return `${TRANSLATION_CACHE_LAYOUT_VERSION}::${documentId}::${page}::${translationCacheSuffix(targetLanguage)}`;
}
