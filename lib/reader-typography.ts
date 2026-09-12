export const MIN_TRANSLATION_FONT_SIZE = 50;
export const MAX_TRANSLATION_FONT_SIZE = 300;
export const TRANSLATION_FONT_SIZE_STEP = 5;

export type ReaderTypography = {
  translationFontSize: number;
  translationFontFamily: "serif" | "sans";
};

export const DEFAULT_READER_TYPOGRAPHY: ReaderTypography = {
  translationFontSize: 100,
  translationFontFamily: "serif",
};

export function normalizeReaderTypography(value: Partial<ReaderTypography>): ReaderTypography {
  const size = value.translationFontSize;
  return {
    translationFontSize: typeof size === "number" && Number.isFinite(size)
      ? Math.min(MAX_TRANSLATION_FONT_SIZE, Math.max(MIN_TRANSLATION_FONT_SIZE,
        Math.round(size / TRANSLATION_FONT_SIZE_STEP) * TRANSLATION_FONT_SIZE_STEP))
      : DEFAULT_READER_TYPOGRAPHY.translationFontSize,
    translationFontFamily: value.translationFontFamily === "sans" ? "sans" : "serif",
  };
}
