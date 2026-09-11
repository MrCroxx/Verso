type SearchShortcutEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

export function isDocumentSearchShortcut(event: SearchShortcutEvent) {
  return event.key.toLocaleLowerCase() === "f"
    && (event.ctrlKey !== event.metaKey)
    && !event.altKey
    && !event.shiftKey;
}
