export function createFileMenu({ openWindow, onError }) {
  return { label: 'File', submenu: [
    { label: 'Open…', accelerator: 'CommandOrControl+O', click: async () => {
      try {
        const window = await openWindow();
        if (!window || window.isDestroyed()) return;
        // Native menu actions need a user gesture to open the web file chooser.
        await window.webContents.executeJavaScript(
          "document.querySelector('[data-open-file-input]')?.click()", true);
      } catch (error) { onError(error); }
    } },
  ] };
}
