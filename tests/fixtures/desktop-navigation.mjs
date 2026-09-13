import assert from 'node:assert/strict';
import { app, BrowserWindow, net, protocol, session } from 'electron';
import { createServer } from 'node:http';
import path from 'node:path';
import { launchBackend } from '../../desktop/backend.mjs';
import { APP_URL, createProtocolHandler } from '../../desktop/protocol.mjs';

// Exercise the real Chromium renderer and Next router with a local, held-open model.
app.setPath('userData', path.join(process.env.VERSO_TEST_DIRECTORY, 'profile'));
const reference = process.argv.includes('--chromium-reference');
const responses = new Set();
let received = 0;
let completed = 0;
function finish(response) {
  const content = JSON.stringify({ page: 1, blocks: [], sourceSummary: '', previousPageRevision: null });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
  completed++;
}
const provider = createServer(async (request, response) => {
  for await (const chunk of request) { void chunk; }
  received++;
  responses.add(response);
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const tick = () => response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'test ' } }] })}\n\n`);
  tick();
  const timer = setInterval(tick, 100);
  response.on('close', () => { clearInterval(timer); responses.delete(response); });
});
let backend;
let window;
const waitFor = async (check, timeout = 10_000) => {
  const deadline = performance.now() + timeout;
  while (!await check()) {
    assert.ok(performance.now() < deadline, 'Timed out waiting for desktop navigation fixture');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
async function run() {
  try {
    await app.whenReady();
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    backend = launchBackend({ nodePath: process.env.VERSO_TEST_NODE,
      serverRoot: process.env.VERSO_TEST_SERVER,
      dataDirectory: path.join(process.env.VERSO_TEST_DIRECTORY, 'library') });
    const ready = await backend.ready;
    const setup = await fetch(`${ready.origin}/api/settings/ai-provider`, {
      method: 'PUT', headers: { 'X-Verso-Desktop-Token': ready.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'compatible', endpoint: `http://127.0.0.1:${provider.address().port}/v1`,
        apiKey: 'sk-local-navigation-fixture', model: 'local-test', reasoningEffort: 'medium' }),
    });
    assert.equal(setup.status, 200);
    await setup.text();
    protocol.handle('https', createProtocolHandler({ ...ready,
      ...(reference ? { fetch: net.fetch } : {}),
      getCookies: url => session.defaultSession.cookies.get({ url }),
    }));
    window = new BrowserWindow({ show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    const js = code => window.webContents.executeJavaScript(code);
    await window.loadURL(APP_URL);
    await waitFor(() => js('Boolean(document.documentElement.dataset.theme && document.querySelector("a.settings-link"))'));
    await js(`window.streams = []; window.streamErrors = []; window.progressEvents = 0; window.translationResults = 0;
      for (let i = 0; i < 6; i++) {
        const abort = new AbortController(); window.streams.push(abort);
        void fetch('/api/translate', { method: 'POST', signal: abort.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ targetLanguage: 'English', translationConcurrency: 6, page: 1, totalPages: 1,
            images: [{ page: 1, dataUrl: 'data:image/png;base64,AA==' }] })
        }).then(async response => {
          const reader = response.body.getReader(); const decoder = new TextDecoder(); let content = '';
          while (true) { const chunk = await reader.read(); if (chunk.done) break;
            const text = decoder.decode(chunk.value, { stream: true }); content += text;
            window.progressEvents += (text.match(/event: progress/g) || []).length;
          }
          if (content.includes('event: result')) window.translationResults++;
          else window.streamErrors.push('Translation ended without a result: ' + content);
        }).catch(error => { if (error.name !== 'AbortError') window.streamErrors.push(error.message); });
      }`);
    await waitFor(() => received === 6);
    await waitFor(() => js('window.progressEvents >= 12'));
    const probeStarted = performance.now();
    const probe = await fetch(`${ready.origin}/api/settings/ai-provider`, {
      headers: { 'X-Verso-Desktop-Token': ready.token }, signal: AbortSignal.timeout(2000),
    });
    assert.equal(probe.status, 200);
    assert.equal((await probe.json()).model, 'local-test');
    const backendSettingsMs = Math.round(performance.now() - probeStarted);
    const started = performance.now();
    await js('document.querySelector("a.settings-link").click()');
    const navigated = () => js('location.pathname === "/settings" && Boolean(document.querySelector(".settings-card"))');
    if (reference) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.equal(await navigated(), false, 'The old transport must reproduce blocked navigation');
      finish([...responses][0]);
    }
    await waitFor(navigated, 5000);
    const navigationMs = Math.round(performance.now() - started);
    assert.equal(completed, reference ? 1 : 0);
    const completedBeforeNavigation = completed;
    for (const response of responses) if (!response.writableEnded) finish(response);
    await waitFor(() => js('window.translationResults === 6'));
    assert.deepEqual(await js('window.streamErrors'), []);
    console.log(JSON.stringify({ transport: reference ? 'chromium-reference' : 'node', navigationMs,
      backendSettingsMs, modelRequests: received, completedBeforeNavigation,
      translationResults: await js('window.translationResults'), progressEvents: await js('window.progressEvents') }));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    for (const response of responses) response.destroy();
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    // Keep Electron alive until async cleanup finishes; app.exit closes the windows.
    await backend?.stop();
    app.exit(process.exitCode || 0);
  }

}
void run();
