import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { launchBackend } from '../desktop/backend.mjs';
import { APP_URL, createProtocolHandler, isAppUrl } from '../desktop/protocol.mjs';

test('desktop serves an isolated library, rejects outside requests, and preserves data across restarts', { timeout: 90_000 }, async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'verso desktop '));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const serverRoot = path.join(temporary, 'server');
  const dataDirectory = path.join(temporary, 'Application Support/Verso/library');
  await cp('.next/standalone', serverRoot, { recursive: true });
  await cp('.next/static', path.join(serverRoot, '.next/static'), { recursive: true });
  await cp('public', path.join(serverRoot, 'public'), { recursive: true });
  const options = { nodePath: process.execPath, serverRoot, dataDirectory };
  const backend = launchBackend(options);
  t.after(() => backend.stop());
  const { origin, token } = await backend.ready;
  const headers = { 'X-Verso-Desktop-Token': token };
  const handle = createProtocolHandler({ origin, token, fetch });
  for (const route of ['/', '/api/books', '/api/settings/ai-provider', '/pdfjs/pdf.worker.min.mjs']) {
    assert.equal((await fetch(`${origin}${route}`)).status, 403);
    assert.equal((await fetch(`${origin}${route}`, { headers: { 'X-Verso-Desktop-Token': 'wrong' } })).status, 403);
  }
  const wrongHostStatus = await new Promise((resolve, reject) => {
    get(`${origin}/api/books`, { headers: { ...headers, Host: 'attacker.example' } }, (response) => {
      response.resume(); resolve(response.statusCode);
    }).once('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  const home = await fetch(origin, { headers });
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Verso/);
  assert.ok(!html.includes(token));
  const script = /src="([^\"]+\/_next\/[^\"]+|\/_next\/[^\"]+)"/.exec(html)?.[1];
  assert.ok(script, 'The desktop serves compiled UI assets');
  assert.equal((await fetch(new URL(script, origin), { headers })).status, 200);
  const library = await fetch(`${origin}/api/books`, { headers });
  assert.deepEqual(await library.json(), { books: [] });
  const requests = [];
  let redirect = false;
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const payload = raw ? JSON.parse(raw) : {};
    requests.push({ path: request.url, authorization: request.headers.authorization, payload });
    if (redirect) {
      response.writeHead(307, { Location: `http://localhost:${provider.address().port}/redirected` }).end();
      return;
    }
    const text = payload.stream ? JSON.stringify({ page: 1, blocks: [], sourceSummary: '', previousPageRevision: null }) : 'OK';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url.endsWith('/responses')
      ? { output: [{ content: [{ type: 'output_text', text }] }] }
      : { choices: [{ message: { content: text } }] }));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => provider.close(resolve)));
  const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
  const fixtureKey = 'sk-desktop-test-only';
  const settings = await handle(new Request(`${APP_URL}/api/settings/ai-provider`, {
    method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'openai', endpoint, apiKey: fixtureKey, model: 'desktop-test-model', reasoningEffort: 'medium' }),
  }));
  assert.equal(settings.status, 200, await settings.text());
  const trace = await handle(new Request(`${APP_URL}/api/traces?format=chrome`));
  assert.equal(trace.status, 200);
  assert.match(trace.headers.get('Content-Disposition'), /attachment/);
  await trace.json();
  assert.ok((await stat(path.join(dataDirectory, 'verso.sqlite'))).isFile());
  await assert.rejects(stat(path.join(serverRoot, '.data')), { code: 'ENOENT' });
  await backend.stop();
  await assert.rejects(fetch(`${origin}/api/books`, { headers, signal: AbortSignal.timeout(2000) }));
  const restarted = launchBackend(options);
  t.after(() => restarted.stop());
  const next = await restarted.ready;
  assert.notEqual(next.token, token);
  assert.equal((await fetch(`${next.origin}/api/books`, { headers })).status, 403);
  const saved = await fetch(`${next.origin}/api/settings/ai-provider`, { headers: { 'X-Verso-Desktop-Token': next.token } });
  const body = await saved.json();
  assert.equal(body.model, 'desktop-test-model');
  assert.equal(body.apiKeyConfigured, true);
  assert.ok(!JSON.stringify(body).includes(fixtureKey));
  const restartedHandle = createProtocolHandler({ ...next, fetch });
  for (const kind of ['openai', 'compatible']) {
    const update = await restartedHandle(new Request(`${APP_URL}/api/settings/ai-provider`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: kind, endpoint, apiKey: '', model: 'desktop-test-model', reasoningEffort: 'medium' }),
    }));
    assert.equal(update.status, 200);
    const connection = await restartedHandle(new Request(`${APP_URL}/api/settings/ai-provider/test`, { method: 'POST' }));
    assert.equal(connection.status, 200, await connection.text());
    const translation = await restartedHandle(new Request(`${APP_URL}/api/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ targetLanguage: 'English', page: 1, totalPages: 1, images: [{ page: 1, dataUrl: 'data:image/png;base64,AA==' }] }),
    }));
    const events = await translation.text();
    assert.match(events, /event: result/);
    assert.ok(!events.includes(fixtureKey));
    for (const request of requests.slice(-2)) {
      assert.equal(request.authorization, `Bearer ${fixtureKey}`);
      assert.equal(request.path, kind === 'openai' ? '/v1/responses' : '/v1/chat/completions');
    }
    assert.equal(requests.at(-1).payload.stream, true);
  }
  const count = requests.length;
  redirect = true;
  const redirected = await restartedHandle(new Request(`${APP_URL}/api/translate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetLanguage: 'English', page: 1, totalPages: 1, images: [{ page: 1, dataUrl: 'data:image/png;base64,AA==' }] }),
  }));
  assert.equal(redirected.status, 502);
  assert.match((await redirected.json()).error, /endpoint redirected.*final API URL/);
  assert.equal(requests.length, count + 1, 'Never follow a redirect that could strip the API key');
});

test('desktop rejects remote protocol hosts and malformed navigation targets', async () => {
  const handle = createProtocolHandler({ origin: 'http://127.0.0.1:1', token: 'unused', fetch: () => assert.fail('Untrusted URLs must never reach the backend') });
  for (const url of ['https://example.com', 'https://verso.localhost:3000/', 'https://user@verso.localhost/', 'http://verso.localhost/', 'file:///etc/passwd']) {
    assert.equal(isAppUrl(url), false);
    assert.equal((await handle({ url })).status, 403);
  }
  assert.equal(isAppUrl('invalid'), false);
  assert.equal(isAppUrl('https://verso.localhost/settings'), true);
});

test('desktop handles a missing Node executable without hanging on quit', { timeout: 5000 }, async () => {
  const backend = launchBackend({ nodePath: '/nonexistent-verso-node', serverRoot: process.cwd(), dataDirectory: tmpdir() });
  await assert.rejects(backend.ready, /ENOENT/);
  await backend.stop();
});

test('desktop reports startup errors without leaving a child running', { timeout: 10_000 }, async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'verso-bad-start-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const backend = launchBackend({ nodePath: process.execPath, serverRoot: temporary, dataDirectory: temporary });
  await assert.rejects(backend.ready, /local reader stopped/);
  await backend.stop();
  assert.notEqual(backend.child.exitCode, null);
});

test('desktop startup timeout terminates an unresponsive backend', { timeout: 10_000 }, async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'verso-timeout-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const serverEntry = path.join(temporary, 'hang.mjs');
  await writeFile(serverEntry, 'setInterval(() => {}, 1000);');
  const backend = launchBackend({ nodePath: process.execPath, serverRoot: temporary, dataDirectory: temporary, serverEntry, timeoutMs: 100 });
  await assert.rejects(backend.ready, /did not start/);
  await backend.stop();
  assert.ok(backend.child.exitCode !== null || backend.child.signalCode !== null);
});
