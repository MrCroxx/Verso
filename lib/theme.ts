export type ThemeMode = "system" | "light" | "dark";

export function parseTheme(value: unknown): ThemeMode {
  return value === "light" || value === "dark" ? value : "system";
}

export function applyTheme(theme: ThemeMode, prefersDark: boolean) {
  document.documentElement.dataset.theme = theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}

export function watchTheme(theme: ThemeMode) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const update = () => applyTheme(theme, media.matches);
  update();
  if (theme !== "system") return;
  media.addEventListener("change", update);
  return () => media.removeEventListener("change", update);
}

// Apply the saved preference before the page paints, including when storage is blocked.
export const THEME_INIT_SCRIPT = `(() => {
  let theme = "system";
  try { theme = (${parseTheme.toString()})(localStorage.getItem("verso-theme")); } catch {}
  (${applyTheme.toString()})(theme, window.matchMedia("(prefers-color-scheme: dark)").matches);
})();`;
