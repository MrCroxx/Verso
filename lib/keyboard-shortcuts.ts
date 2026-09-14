type ShortcutEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

export function isDocumentSearchShortcut(event: ShortcutEvent) {
  return event.key.toLocaleLowerCase() === "f"
    && (event.ctrlKey !== event.metaKey)
    && !event.altKey
    && !event.shiftKey;
}

export function isSettingsShortcut(event: ShortcutEvent) {
  return event.key === ","
    && (event.ctrlKey !== event.metaKey)
    && !event.altKey
    && !event.shiftKey;
}

export function isOpenFileShortcut(event: ShortcutEvent) {
  return event.key.toLowerCase() === "o"
    && (event.ctrlKey !== event.metaKey)
    && !event.altKey
    && !event.shiftKey;
}
