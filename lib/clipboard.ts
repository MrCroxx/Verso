// Clipboard API requires a secure context; LAN HTTP readers need a DOM fallback.
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch { /* Permission failures may still allow a user-initiated DOM copy. */ }
  const active = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;font-size:16px";
  document.body.appendChild(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard copy was rejected.");
  } finally {
    field.remove();
    if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
