export const DEFAULT_TYPEWRITER_CHARACTERS_PER_SECOND = 80;

export function typewriterDuration(
  characterCount: number,
  charactersPerSecond = DEFAULT_TYPEWRITER_CHARACTERS_PER_SECOND,
) {
  if (characterCount <= 0) return 0;
  return (characterCount / Math.max(1, charactersPerSecond)) * 1000;
}

export function typewriterProgress(
  elapsedMs: number,
  characterCount: number,
  charactersPerSecond = DEFAULT_TYPEWRITER_CHARACTERS_PER_SECOND,
) {
  if (characterCount <= 0) return 0;
  const revealed = Math.floor((Math.max(0, elapsedMs) * Math.max(1, charactersPerSecond)) / 1000);
  return Math.min(characterCount, revealed);
}
