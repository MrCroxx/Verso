import assert from 'node:assert/strict';
import { app, BrowserWindow, Menu, protocol, session } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchBackend } from '../../desktop/backend.mjs';
import { createFileMenu, installFileShortcut } from '../../desktop/file-menu.mjs';
import { APP_URL, createProtocolHandler } from '../../desktop/protocol.mjs';

app.setPath('userData', path.join(process.env.VERSO_TEST_DIRECTORY, 'profile'));
let backend;
let window;
let exitCode = 0;
const waitFor = async (check, message) => {
  const deadline = performance.now() + 15_000;
  while (!await check()) {
    assert.ok(performance.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

function makePdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> >>'];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(`${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

async function run() {
  try {
    await app.whenReady();
    backend = launchBackend({ nodePath: process.env.VERSO_TEST_NODE,
      serverRoot: process.env.VERSO_TEST_SERVER,
      dataDirectory: path.join(process.env.VERSO_TEST_DIRECTORY, 'library') });
    const ready = await backend.ready;
    protocol.handle('https', createProtocolHandler({ ...ready,
      getCookies: url => session.defaultSession.cookies.get({ url }) }));
    window = new BrowserWindow({ show: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const js = (code, userGesture = false) => window.webContents.executeJavaScript(code, userGesture);
    const loadPage = async url => {
      await window.loadURL(url);
      await waitFor(() => js(`document.querySelector('[data-open-file-input]')?.dataset.shortcutsReady === 'true'`),
        'App keyboard listeners must be ready after navigation');
    };
    const menuErrors = [];
    installFileShortcut(window, error => menuErrors.push(error));
    const menu = Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      createFileMenu({ openWindow: async () => window, onError: error => menuErrors.push(error) }),
      { role: 'editMenu' },
    ]);
    Menu.setApplicationMenu(menu);
    const openItem = menu.items.find(item => item.label === 'File').submenu.items[0];
    const inputEvents = [];
    window.webContents.on('before-input-event', (_event, input) => {
      inputEvents.push({ type: input.type, key: input.key, meta: input.meta, control: input.control });
    });
    const focusWindow = async () => {
      app.focus({ steal: true });
      window.focus();
      window.webContents.focus();
      await waitFor(() => window.isFocused() && js('document.hasFocus()'), 'The test window must have keyboard focus');
    };
    const debuggerClient = window.webContents.debugger;
    const choosers = [];
    debuggerClient.on('message', (_event, method, params) => {
      if (method === 'Page.fileChooserOpened') choosers.push(params);
    });
    const timed = async (operation, label) => {
      let timer;
      try {
        return await Promise.race([operation, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000);
        })]);
      } finally { clearTimeout(timer); }
    };
    const choose = async (trigger, files = []) => {
      const count = choosers.length;
      await timed(Promise.resolve(trigger()), `file chooser trigger ${count + 1}`);
      await waitFor(() => choosers.length === count + 1, 'The action must open exactly one file chooser')
        .catch(error => { throw new Error(`${error.message}: ${JSON.stringify({ before: count, received: choosers.length, input: inputEvents.slice(-4), menuErrors: menuErrors.map(error => error.message) })}`); });
      const chooser = choosers.at(-1);
      assert.equal(chooser.mode, 'selectSingle');
      await timed(debuggerClient.sendCommand('DOM.setFileInputFiles', { files, backendNodeId: chooser.backendNodeId }), `file chooser selection ${count + 1}`);
    };
    const key = async (modifiers, keyCode = 'O') => {
      await focusWindow();
      await js(`if (!window.shortcutEvents) {
        window.shortcutEvents = [];
        addEventListener('keydown', event => setTimeout(() => shortcutEvents.push({
          key: event.key, meta: event.metaKey, control: event.ctrlKey, prevented: event.defaultPrevented,
          target: event.target.id || event.target.tagName,
        }), 0), true);
      }`);
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    const modifier = process.platform === 'darwin' ? 'meta' : 'control';
    const pdfPath = path.join(process.env.VERSO_TEST_DIRECTORY, 'Shortcut upload.pdf');
    await writeFile(pdfPath, makePdf());
    await loadPage(APP_URL);
    debuggerClient.attach('1.3');
    await debuggerClient.sendCommand('Page.enable');
    await debuggerClient.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
    window.focus();
    await waitFor(() => js('!!document.documentElement.dataset.theme && !!document.querySelector(".library-upload-button")'), 'Library must be ready');
    assert.equal(await js('document.querySelector("[data-open-file-input]").accept'), 'application/pdf');
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));`);
    await waitFor(() => js(`!!document.querySelector('#shortcut-help-panel')`), 'Shortcut help must open');
    await key([modifier]);
    await waitFor(() => js(`!document.querySelector('#shortcut-help-panel')`), 'Native open shortcut must dismiss help');
    assert.equal(choosers.length, 0, 'Dismissing help must not open a chooser');
    await choose(() => key([modifier]));
    assert.equal(await js('location.pathname'), '/');
    assert.equal(await js('!!document.querySelector(".library-shell")'), true, 'Cancelling must preserve the library');
    await choose(() => js('document.querySelector(".library-upload-button").click()', true));

    await loadPage(`${APP_URL}/settings`);
    await waitFor(() => js('!!document.querySelector("#ai-model")'), 'Settings must be ready');
    await js('document.querySelector("#ai-model").focus()');
    await choose(() => key([modifier]));
    assert.equal(await js('location.pathname'), '/settings', 'Cancelling must preserve Settings');
    await choose(() => key([modifier]), [pdfPath]);
    await waitFor(() => js('!!document.querySelector(".reader-shell") && !!document.querySelector(".reader-upload-button")'), 'Selecting a file in Settings must open the reader');
    await waitFor(() => js(`fetch('/api/books').then(r => r.json()).then(r => r.books.length === 1)`), 'The selected PDF must be stored locally');
    await waitFor(() => js('location.search.includes("book=")'), 'The uploaded book must have a stable reader URL');
    const readerUrl = await js('location.href');
    await choose(() => key([modifier]));
    assert.equal(await js('location.href'), readerUrl, 'Cancelling must preserve the current book');
    await choose(() => js('document.querySelector(".reader-upload-button").click()', true));
    await choose(() => key([modifier]), [pdfPath]);
    await waitFor(() => js('location.search.includes("book=")'), 'The same file must be selectable again');
    assert.equal(await js(`fetch('/api/books').then(r => r.json()).then(r => r.books.length)`), 1, 'Reopening must reuse the existing local upload');

    assert.equal(openItem.accelerator, 'CommandOrControl+O');
    await choose(() => openItem.click());
    assert.deepEqual(menuErrors, []);
    assert.equal(await js('location.href'), readerUrl, 'Cancelling the native menu action must preserve the reader');
    await loadPage(`${APP_URL}/settings`);
    await waitFor(() => js('!!document.querySelector("#ai-model")'), 'Settings must reload');
    await choose(() => openItem.click(), [pdfPath]);
    await waitFor(() => js('!!document.querySelector(".reader-shell")'), 'The native menu must open a PDF from Settings');
    console.log(JSON.stringify({ fileOpen: 'passed', screens: ['library', 'reader', 'settings'], nativeMenu: 'passed', cancel: 'passed', repeatedFile: 'passed' }));
  } catch (error) {
    console.error(error);
    if (window && !window.isDestroyed()) console.error(await window.webContents.executeJavaScript(
      "JSON.stringify({ url: location.href, focused: document.hasFocus(), active: document.activeElement?.id, input: window.shortcutEvents, files: document.querySelector('[data-open-file-input]')?.files.length })"));
    exitCode = 1;
  } finally {
    await backend?.stop();
    app.exit(exitCode);
  }
}
void run();
