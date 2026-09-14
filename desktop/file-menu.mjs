async function openFileInWindow(window) {
  if (!window || window.isDestroyed()) return;
  // Native actions need a user gesture to open the web file chooser.
  await window.webContents.executeJavaScript(
    "if (window.dispatchEvent(new Event('verso:before-open-file', { cancelable: true }))) document.querySelector('[data-open-file-input]')?.click()", true);
}

export function installFileShortcut(window, onError) {
  window.webContents.on('before-input-event', (event, input) => {
    const primary = process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
    if (input.type !== 'keyDown' || !primary || input.alt || input.shift || input.key.toLowerCase() !== 'o') return;
    // macOS text editing can consume Command+O before a DOM keydown is dispatched.
    event.preventDefault();
    if (!input.isAutoRepeat) void openFileInWindow(window).catch(onError);
  });
}

export function createFileMenu({ openWindow, onError }) {
  return { label: 'File', submenu: [
    { label: 'Open…', accelerator: 'CommandOrControl+O', click: async () => {
      try { await openFileInWindow(await openWindow()); }
      catch (error) { onError(error); }
    } },
  ] };
}
