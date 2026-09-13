import assert from 'node:assert/strict';
import { app, BrowserWindow, protocol, session } from 'electron';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { launchBackend } from '../../desktop/backend.mjs';
import { APP_URL, createProtocolHandler } from '../../desktop/protocol.mjs';

app.setPath('userData', path.join(process.env.VERSO_TEST_DIRECTORY, 'profile'));
app.on('window-all-closed', () => {});
let backend;
let window;
let exitCode = 0;
const waitFor = async (check, message = 'Timed out waiting for translation transfer') => {
  const deadline = performance.now() + 15_000;
  while (!await check()) {
    assert.ok(performance.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

// A real, locally generated multipage PDF exercises lazy rendering without a model service.
function makePdf(pageCount) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, i) => `${i + 3} 0 R`).join(' ')}] >>`,
    ...Array.from({ length: pageCount }, () => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> >>')];
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
    console.log('Translation transfer: starting Electron and backend');
    await app.whenReady();
    backend = launchBackend({ nodePath: process.env.VERSO_TEST_NODE,
      serverRoot: process.env.VERSO_TEST_SERVER,
      dataDirectory: path.join(process.env.VERSO_TEST_DIRECTORY, 'library') });
    const ready = await backend.ready;
    const request = async (route, method, body, headers = {}) => {
      const response = await fetch(`${ready.origin}${route}`, { method, body,
        headers: { 'X-Verso-Desktop-Token': ready.token, 'Content-Type': 'application/json', ...headers } });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const bytes = makePdf(2);
    const metadata = { fingerprint: 'a'.repeat(64), name: 'Translation transfer fixture.pdf', size: bytes.length,
      pageCount: 2, contentType: 'application/pdf' };
    const upload = await request('/api/books/uploads', 'POST', JSON.stringify(metadata));
    const part = await request(`/api/books/uploads/${upload.uploadId}/parts/1`, 'PUT', bytes,
      { 'Content-Type': 'application/octet-stream', 'x-object-key': upload.objectKey });
    await request(`/api/books/uploads/${upload.uploadId}/complete`, 'POST',
      JSON.stringify({ ...metadata, objectKey: upload.objectKey, parts: [part] }));
    protocol.handle('https', createProtocolHandler({ ...ready,
      getCookies: url => session.defaultSession.cookies.get({ url }) }));
    window = new BrowserWindow({ show: false, width: 1400, height: 900,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const js = code => window.webContents.executeJavaScript(code).catch(error => { throw new Error(`${code}: ${error.message}`); });
    const act = code => js(`(async () => { ${code} })()`);
    await window.loadURL(APP_URL);
    console.log('Translation transfer: library loaded');
    await waitFor(() => js('document.querySelectorAll(".library-book").length === 1'));
    assert.equal(await js('Boolean(document.querySelector(".translation-transfer"))'), false);
    await js('document.querySelector("a.settings-link").click()');
    await waitFor(() => js('Boolean(document.querySelector(".settings-card#library .translation-transfer"))'));
    assert.equal(await js('document.querySelector(".translation-transfer-actions").innerText.includes("Import library translations")'), true);
    assert.equal(await js('document.querySelector(".translation-transfer-actions").innerText.includes("Export library translations")'), true);
    await js('document.querySelector(".settings-card#library").scrollIntoView({ block: "center", behavior: "instant" })');
    const archive = page => ({ format: 'verso-translations', version: 1, books: [{
      fingerprint: metadata.fingerprint, name: metadata.name, pageCount: 2,
      translations: [{ key: `layout-v4::${metadata.fingerprint}::${page}::server-v2::Simplified Chinese`, page,
        translation: { page, markdown: `Restored translation page ${page}`, blocks: [{ kind: 'paragraph', text: `Restored translation page ${page}` }], cachedAt: 1 }, updatedAt: 1 }],
      navigation: { observations: [], manualOffset: null },
    }] });
    const importArchive = async value => {
      await act(`
      const input = document.querySelector('.translation-transfer input');
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(JSON.stringify(value))}], 'translations.json', { type: 'application/json' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(requestAnimationFrame);
    `);
      await waitFor(() => js('document.querySelector(".translation-transfer").getAttribute("aria-busy") === "false"'));
    };
    let downloaded;
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSavePath(path.join(process.env.VERSO_TEST_DIRECTORY, item.getFilename()));
      item.once('done', (_event, state) => { downloaded = { state, path: item.getSavePath() }; });
    });
    const exportArchive = async () => {
      downloaded = null;
      await js('document.querySelectorAll(".translation-transfer-actions button")[1].click()');
      await waitFor(() => downloaded);
      assert.equal(downloaded.state, 'completed');
      await waitFor(() => js('document.querySelector(".translation-transfer").getAttribute("aria-busy") === "false"'));
      assert.equal(await js('Boolean(document.querySelector(".translation-transfer-notice"))'), false);
      return JSON.parse(await readFile(downloaded.path, 'utf8'));
    };
    const libraryDownload = await exportArchive();
    console.log('Translation transfer: library export completed');
    assert.equal(libraryDownload.books.length, 1);
    assert.equal(libraryDownload.books[0].fingerprint, metadata.fingerprint);
    assert.equal(libraryDownload.books[0].translations.length, 0);
    await importArchive(archive(2));
    console.log('Translation transfer: library import completed');
    assert.equal(await js('Boolean(document.querySelector(".translation-transfer-notice"))'), false);
    await act('document.querySelector(".settings-card#library").scrollIntoView({ block: "center", behavior: "instant" }); for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);');
    await writeFile('/tmp/verso-transfer-settings.png', (await window.webContents.capturePage()).toPNG());
    console.log('Translation transfer: desktop settings captured');
    window.setContentSize(390, 844);
    await waitFor(() => js('window.innerWidth === 390'));
    await waitFor(() => js('document.documentElement.scrollWidth <= window.innerWidth'), 'The layout overflows at phone width');
    await act('for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);');
    await act('document.querySelector(".settings-card#library").scrollIntoView({ block: "center", behavior: "instant" }); for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);');
    await writeFile('/tmp/verso-transfer-settings-mobile.png', (await window.webContents.capturePage()).toPNG());
    console.log('Translation transfer: mobile settings captured');
    window.setContentSize(1400, 900);
    await js('document.querySelector("header a.secondary-button").click()');
    await waitFor(() => js('Boolean(document.querySelector(".library-book"))'));
    await js('document.querySelector(".library-book").click()');
    await waitFor(() => js('document.querySelectorAll(".page-spread").length === 2 && !document.querySelector(".translation-transfer button").disabled'));
    assert.equal(await js('Boolean(document.querySelector(".reader > .translation-transfer"))'), false);
    assert.equal(await js('document.querySelector("#reader-overflow-menu").hidden'), true);
    await js('document.querySelector(".reader-menu-button").click()');
    await waitFor(() => js('!document.querySelector("#reader-overflow-menu").hidden'));
    assert.equal(await js('document.querySelector("#reader-overflow-menu .translation-transfer button").getAttribute("role")'), 'menuitem');
    assert.equal(await js('document.querySelector(".translation-transfer-actions").innerText.includes("Import translations")'), true);
    assert.equal(await js('document.querySelector(".translation-transfer-actions").innerText.includes("Export translations")'), true);
    const wrong = archive(1);
    wrong.books[0].fingerprint = 'b'.repeat(64);
    wrong.books[0].translations[0].key = wrong.books[0].translations[0].key.replace(metadata.fingerprint, 'b'.repeat(64));
    await importArchive(wrong);
    await waitFor(() => js('Boolean(document.querySelector(".translation-transfer-notice.failed"))'));
    assert.equal(await js('document.querySelector(".translation-transfer-notice")?.innerText.includes("do not match")'), true);
    const pendingImport = importArchive(archive(1));
    await js('document.querySelector(".reader-menu-button").click()');
    await pendingImport;
    console.log('Translation transfer: reader import completed');
    assert.equal(await js('Boolean(document.querySelector(".translation-transfer-notice"))'), false);
    await waitFor(() => js(`document.querySelector('[data-page="1"]').innerText.includes("Restored translation page 1")`), 'Imported page did not appear without reloading');
    assert.equal(await js('document.querySelector("#reader-overflow-menu").hidden'), true);
    await js('document.querySelector(".reader-menu-button").click()');
    const bookDownload = await exportArchive();
    console.log('Translation transfer: book export completed');
    assert.equal(bookDownload.books.length, 1);
    assert.equal(bookDownload.books[0].translations.length, 2);
    await act('for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);');
    await writeFile('/tmp/verso-transfer-reader.png', (await window.webContents.capturePage()).toPNG());
    console.log('Translation transfer: desktop reader captured');
    window.setContentSize(390, 844);
    await waitFor(() => js('window.innerWidth === 390'));
    await waitFor(() => js('getComputedStyle(document.querySelector(".reader")).marginLeft === "0px"'));
    await waitFor(() => js('document.documentElement.scrollWidth <= window.innerWidth'), 'The layout overflows at phone width');
    await js('document.querySelector(".locale-button").click()');
    await js('if (document.querySelector("#reader-overflow-menu").hidden) document.querySelector(".reader-menu-button").click()');
    await waitFor(() => js('document.querySelector(".translation-transfer").innerText.includes("导入翻译信息")'));
    await act('for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);');
    await writeFile('/tmp/verso-transfer-reader-mobile.png', (await window.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ translationTransfer: 'passed', libraryDownload: 'passed', bookDownload: 'passed', readerRefresh: 'passed', mobileWidth: 390 }));
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    console.log('Translation transfer: destroying window');
    window?.destroy();
    console.log('Translation transfer: stopping backend');
    await backend?.stop();
    console.log('Translation transfer: exiting Electron');
    app.exit(exitCode);
  }
}
void run();
