import { app, BrowserWindow, dialog, Menu, protocol, session } from 'electron';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { launchBackend } from './backend.mjs';
import { APP_URL, createProtocolHandler, isAppUrl } from './protocol.mjs';
import { createFileMenu } from './file-menu.mjs';

app.setName('Verso');
let backend;
let window;
let origin;
let quitting = false;
let failed = false;
const smokeTest = process.argv.includes('--smoke-test');
const smokeData = process.argv.find((argument) => argument.startsWith('--smoke-data='))?.slice(13);
if (smokeTest && !smokeData) throw new Error('--smoke-test requires an isolated --smoke-data directory.');
if (smokeTest) app.setPath('userData', path.resolve(smokeData));

function fail(error) {
  if (failed || quitting) return;
  failed = true;
  if (smokeTest) console.error(error);
  else dialog.showErrorBox('Verso could not start', error.message);
  if (backend) app.quit();
  else app.exit(1);
}

async function openWindow(initialUrl = origin) {
  if (window) { window.show(); window.focus(); return window; }
  window = new BrowserWindow({
    title: 'Verso', width: 1440, height: 960, minWidth: 900, minHeight: 600, show: false,
    backgroundColor: '#f6f4ef',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guardNavigation = (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  };
  window.webContents.on('will-navigate', guardNavigation);
  window.webContents.on('will-redirect', guardNavigation);
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('closed', () => { window = undefined; });
  await window.loadURL(initialUrl);
  window.show();
  if (smokeTest) {
    const pdfPath = process.argv.find((argument) => argument.startsWith('--smoke-pdf='))?.slice(12);
    const pdf = pdfPath ? readFileSync(pdfPath).toString('base64') : null;
    const result = await window.webContents.executeJavaScript(`(async () => {
      const waitFor = async (check) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (await check()) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('Timed out waiting for the reader: ' + document.body.innerText);
      };
      await waitFor(() => document.documentElement.dataset.theme);
      const settings = await fetch('/api/settings/ai-provider', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', endpoint: 'https://example.invalid/v1', model: 'smoke-test', reasoningEffort: 'medium' }),
      });
      if (!settings.ok) throw new Error('Desktop settings update failed');
      localStorage.setItem('verso-desktop-smoke', 'saved');
      document.cookie = 'verso-desktop-smoke=saved; Path=/; SameSite=Lax';
      document.cookie = 'verso-ui-locale=zh-CN; Path=/; SameSite=Lax';
      const pdf = ${JSON.stringify(pdf)};
      if (pdf) {
        const input = document.querySelector('input[type=file]');
        const transfer = new DataTransfer();
        transfer.items.add(new File([Uint8Array.from(atob(pdf), (character) => character.charCodeAt(0))], 'Desktop smoke.pdf', { type: 'application/pdf' }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(async () => (await (await fetch('/api/books')).json()).books.length === 1);
        const book = (await (await fetch('/api/books')).json()).books[0];
        const range = await fetch('/api/books/' + book.id + '/file', { headers: { Range: 'bytes=0-4' } });
        if (range.status !== 206 || await range.text() !== '%PDF-') throw new Error('Desktop PDF range download failed');
        const image = await fetch('/api/books/' + book.id + '/pages/1');
        if (!image.ok || (await image.arrayBuffer()).byteLength < 1000) throw new Error('Desktop page rendering failed');
        const translation = await fetch('/api/translate', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ bookId: book.id, page: 1, totalPages: 1, contextPages: [1], targetLanguage: 'zh-CN' }),
        });
        const events = await translation.text();
        if (!translation.ok || !events.includes('event: progress') || !events.includes('event: error')) throw new Error('Desktop translation event stream failed');
      }
      const response = await fetch('/api/books');
      const body = await response.json();
      return { status: response.status, body, title: document.title, node: typeof window.require };
    })()`);
    if (result.status !== 200 || !Array.isArray(result.body.books) || !result.title.includes('Verso') || result.node !== 'undefined') {
      throw new Error(`Desktop smoke test failed: ${JSON.stringify(result)}`);
    }
    await window.loadURL(APP_URL);
    const saved = await window.webContents.executeJavaScript(`({ storage: localStorage.getItem('verso-desktop-smoke'), cookie: document.cookie, locale: document.documentElement.lang })`);
    if (saved.storage !== 'saved' || !saved.cookie.includes('verso-desktop-smoke=saved') || saved.locale !== 'zh-CN') {
      throw new Error('Desktop preferences did not survive navigation: ' + JSON.stringify(saved));
    }
    console.log('Verso desktop smoke test passed.');
    app.quit();
  }
  return window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (origin) void openWindow().catch(fail); });
  app.on('activate', () => { if (origin && !quitting) void openWindow().catch(fail); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !quitting) app.quit(); });
  app.on('before-quit', (event) => {
    if (!backend) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    session.defaultSession.flushStorageData();
    window?.destroy();
    void backend.stop().finally(() => app.exit(failed ? 1 : 0));
  });
  process.on('exit', () => backend?.kill());
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Verso', submenu: [{ role: 'about' }, { type: 'separator' },
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: async () => {
          if (!origin || quitting) return;
          try {
            if (!window) {
              await openWindow(new URL('/settings', origin).href);
              return;
            }
            await openWindow();
            await window.webContents.executeJavaScript("window.dispatchEvent(new Event('verso:open-settings'))");
          } catch (error) { fail(error); }
        } },
        { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      createFileMenu({ openWindow: () => origin && !quitting ? openWindow() : undefined, onError: fail }),
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]));
    const dataDirectory = path.join(app.getPath('userData'), 'library');
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const resourceRoot = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), '.desktop');
    app.dock?.setIcon(path.join(resourceRoot, 'icon.png'));
    const nativeRoot = app.isPackaged ? path.join(resourceRoot, 'native') : undefined;
    backend = launchBackend({
      nodePath: nativeRoot ? path.join(nativeRoot, 'bin/node') : process.env.VERSO_DESKTOP_NODE,
      ...(app.isPackaged ? { serverEntry: path.join(resourceRoot, 'server.mjs') } : {}),
      serverRoot: path.join(resourceRoot, 'server'), dataDirectory, nativeRoot, onExit: fail,
    });
    const ready = await backend.ready;
    origin = APP_URL;
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    protocol.handle('https', createProtocolHandler({
      ...ready, getCookies: (url) => session.defaultSession.cookies.get({ url }),
    }));
    await openWindow();
  }).catch(fail);
}
