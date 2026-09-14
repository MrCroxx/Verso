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

export function isSidebarShortcut(event: ShortcutEvent) {
  return event.key.toLowerCase() === "b"
    && (event.ctrlKey !== event.metaKey) && !event.altKey && !event.shiftKey;
}

export function historyShortcutDirection(event: ShortcutEvent): "back" | "forward" | undefined {
  if (event.ctrlKey === event.metaKey || event.altKey || event.shiftKey) return undefined;
  return event.key === "[" ? "back" : event.key === "]" ? "forward" : undefined;
}

export function isShortcutHelpShortcut(event: ShortcutEvent) {
  return event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function isEditableShortcutTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]"));
}
