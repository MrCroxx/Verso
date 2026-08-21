export const UI_LOCALE_COOKIE = "verso-ui-locale";

export type UiLocale = "zh-CN" | "en-US";

export function parseUiLocale(value: string | null | undefined): UiLocale | undefined {
  return value === "zh-CN" || value === "en-US" ? value : undefined;
}

export function resolveUiLocale(
  savedLocale: string | null | undefined,
  acceptLanguage: string | null | undefined,
): UiLocale {
  const saved = parseUiLocale(savedLocale);
  if (saved) return saved;

  const preferredSupportedLanguage = (acceptLanguage || "")
    .split(",")
    .map((entry, index) => {
      const [language, ...parameters] = entry.trim().split(";");
      const qualityParameter = parameters.find((parameter) => parameter.trim().startsWith("q="));
      const quality = qualityParameter ? Number(qualityParameter.trim().slice(2)) : 1;
      return { language: language.toLowerCase(), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter(({ quality }) => quality > 0)
    .sort((left, right) => right.quality - left.quality || left.index - right.index)
    .find(({ language }) => language === "zh" || language.startsWith("zh-") || language === "en" || language.startsWith("en-"));

  return preferredSupportedLanguage?.language.startsWith("zh") ? "zh-CN" : "en-US";
}
