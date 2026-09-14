import assert from 'node:assert/strict';
import { app, BrowserWindow, protocol, session } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchBackend } from '../../desktop/backend.mjs';
import { APP_URL, createProtocolHandler } from '../../desktop/protocol.mjs';

app.setPath('userData', path.join(process.env.VERSO_TEST_DIRECTORY, 'profile'));
app.on('window-all-closed', () => {});
const detail = "Expected ':' after property name in JSON at position 1560 (line 1 column 1561)";
const books = ['Detecting and countering misuse of AI', 'A very long book title that should wrap on a narrow screen'].map((name, index) => ({
  id: `book-${index}`, fingerprint: String(index + 1).repeat(64), name: `${name}.pdf`,
  pageCount: 154, size: 10485760, uploadedAt: Date.now(), contentType: 'application/pdf',
}));
let jobs = books.map((book, index) => ({ documentId: book.fingerprint, bookId: book.id, bookName: book.name,
  targetLanguage: 'Simplified Chinese', status: index ? 'running' : 'partial', error: index ? null : detail,
  nextPage: 17, activePages: index ? 1 : 0, retryCount: index ? 0 : 3, retryAt: 0, maxRetriesPerPage: 3, failedPageLimit: 3, failedPages: index ? 0 : 1,
  pageErrors: index ? [] : [{ page: 17, status: 'failed', retryCount: 3, error: detail }], completedPages: 16, totalPages: 154 }));
const actions = [];
let concurrency = 4;
let backend;
let window;
let exitCode = 0;
const waitFor = async check => {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for queue UI');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
async function run() {
try {
  await app.whenReady();
  backend = launchBackend({ nodePath: process.env.VERSO_TEST_NODE, serverRoot: process.env.VERSO_TEST_SERVER,
    dataDirectory: path.join(process.env.VERSO_TEST_DIRECTORY, 'library') });
  const ready = await backend.ready;
  const fallback = createProtocolHandler({ ...ready, getCookies: url => session.defaultSession.cookies.get({ url }) });
  protocol.handle('https', async request => {
    const url = new URL(request.url);
    if (url.pathname === '/api/books' && request.method === 'GET') return Response.json({ books });
    if (url.pathname === '/api/translation-queue') {
      if (request.method !== 'GET') {
        const body = await request.json();
        if (body.action === 'configure') { concurrency = body.concurrency; return Response.json({ settings: { concurrency } }); }
        actions.push({ method: request.method, ...body });
        jobs = jobs.map(job => job.bookId === body.bookId ? { ...job, status: body.action === 'stop' ? 'stopped' : 'running', error: null, retryCount: 0, failedPages: 0, pageErrors: [] } : job);
      }
      return Response.json(request.method === 'GET' ? { jobs, settings: { concurrency } } : { ok: true });
    }
    return fallback(request);
  });
  window = new BrowserWindow({ show: false, width: 1100, height: 900,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  const js = source => window.webContents.executeJavaScript(source).catch(error => { throw new Error(`${source}: ${error.message}`); });
  await window.loadURL(APP_URL);
  await waitFor(() => js('document.querySelectorAll(".library-book-card").length === 2 && Boolean(document.querySelector(".book-translation-progress"))'));
  assert.equal(await js(`document.body.innerText.includes(${JSON.stringify(detail)})`), false);
  assert.equal(await js('document.querySelector("a.queue-link").getAttribute("href")'), '/queue');
  await js('document.querySelector("a.queue-link").click()');
  await waitFor(() => js('document.querySelectorAll(".queue-card").length === 2'));
  assert.equal(await js(`document.body.innerText.includes(${JSON.stringify(detail)})`), true);
  assert.equal(await js('document.querySelectorAll(".queue-card button").length'), 2);
  assert.equal(await js('Boolean(document.querySelector(".queue-status-partial"))'), true);
  assert.equal(await js('document.querySelector(".queue-page-errors").innerText.includes("Page 17 · Retries 3 / 3")'), true);
  assert.equal(await js('document.querySelector(".queue-card-actions").innerText.includes("Exhausted pages 1 / 3")'), true);
  assert.equal(await js('document.querySelector("#queue-concurrency").options.length'), 10);
  await js('document.querySelector("#queue-concurrency").value = "10"; document.querySelector("#queue-concurrency").dispatchEvent(new Event("change", { bubbles: true }))');
  await waitFor(() => concurrency === 10);
  await waitFor(() => js('!document.querySelector("#queue-concurrency").disabled'));
  assert.equal(await js('document.querySelector("#queue-concurrency").value'), '10');
  await js('document.querySelector("#queue-concurrency").value = "3"; document.querySelector("#queue-concurrency").dispatchEvent(new Event("change", { bubbles: true }))');
  await waitFor(() => concurrency === 3);
  await js('document.querySelectorAll(".queue-card button")[1].click()');
  await waitFor(() => actions.length === 1);
  assert.equal(actions[0].action, 'stop');
  await waitFor(() => js('Boolean(document.querySelector(".queue-status-stopped"))'));
  await js('document.querySelectorAll(".queue-card button")[1].click()');
  await waitFor(() => actions.length === 2);
  assert.equal(actions[1].method, 'POST');
  assert.equal(actions[1].targetLanguage, 'Simplified Chinese');
  await waitFor(() => js('!document.querySelectorAll(".queue-card button")[1].disabled'));
  await js('document.querySelectorAll(".queue-card button")[0].click()');
  await waitFor(() => actions.length === 3);
  assert.equal(actions[2].method, 'POST');
  await waitFor(() => js('document.querySelectorAll(".queue-status-running").length === 2'));
  assert.equal(await js(`document.body.innerText.includes(${JSON.stringify(detail)})`), false);
  // Exercise error wrapping and both locales at phone width.
  jobs[0] = { ...jobs[0], status: 'failed', error: detail, retryCount: 9, failedPages: 3, pageErrors: [17, 18, 19].map(page => ({ page, status: 'failed', retryCount: 3, error: detail })) };
  await waitFor(() => js('Boolean(document.querySelector(".queue-status-failed"))'));
  await writeFile('/tmp/verso-queue-desktop.png', (await window.webContents.capturePage()).toPNG());
  window.setContentSize(390, 844);
  await waitFor(() => js('window.innerWidth === 390'));
  assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'), true);
  await writeFile('/tmp/verso-queue-mobile.png', (await window.webContents.capturePage()).toPNG());
  await js('document.querySelector("header a").click()');
  await waitFor(() => js('Boolean(document.querySelector(".locale-button"))'));
  assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'), true);
  await js('document.querySelector(".locale-button").click()');
  await js('document.querySelector("a.queue-link").click()');
  await waitFor(() => js('document.querySelectorAll(".queue-card").length === 2'));
  assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'), true);
  assert.equal(await js('document.querySelector("#queue-title").innerText'), '翻译队列');
  await window.loadURL(`${APP_URL}/settings`);
  await waitFor(() => js('Boolean(document.querySelector("#concurrency"))'));
  assert.equal(await js('document.querySelector("#concurrency").max'), '10');
  await js('const input = document.querySelector("#concurrency"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "10"); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }))');
  await waitFor(() => js('JSON.parse(localStorage.getItem("verso-settings")).translationConcurrency === 10'));
  await window.loadURL(`${APP_URL}/settings`);
  await waitFor(() => js('document.querySelector("#concurrency")?.value === "10"'));
  assert.equal(concurrency, 3);
  console.log(JSON.stringify({ queueUi: 'passed', actions: actions.length, mobileWidth: 390, locales: ['en', 'zh-CN'] }));
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  // Keep Electron alive until async cleanup finishes; app.exit closes the windows.
  await backend?.stop();
  app.exit(exitCode);
}

}
void run();
