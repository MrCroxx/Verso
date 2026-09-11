import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderTimeoutError, withProviderResponse } from '../lib/server-provider-timeout.ts';
import { readProviderStream } from '../lib/server-provider-stream.ts';

const minute = 60_000;
const flush = () => new Promise(setImmediate);
const handlers = { event() {}, text() {}, reasoning() {} };

function provider({ abortErrorsBody = true } = {}) {
  let controller;
  let signal;
  let cancelled = false;
  const encoder = new TextEncoder();
  return {
    request(value) {
      signal = value;
      return Promise.resolve(new Response(new ReadableStream({
        start(stream) {
          controller = stream;
          signal.addEventListener('abort', () => {
            // Native fetch can discard the custom abort reason while reading.
            if (abortErrorsBody) stream.error(new DOMException('The operation was aborted.', 'AbortError'));
          }, { once: true });
        },
        cancel() { cancelled = true; },
      }), { headers: { 'Content-Type': 'text/event-stream' } }));
    },
    send(value) { controller.enqueue(encoder.encode(value)); },
    close() { controller.close(); },
    get signal() { return signal; },
    get cancelled() { return cancelled; },
  };
}

test('allows response headers after the old three-minute total deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let respond;
  let signal;
  const result = withProviderResponse((value) => {
    signal = value;
    return new Promise(resolve => { respond = resolve; });
  }, response => response.json());
  t.mock.timers.tick(4 * minute);
  assert.equal(signal.aborted, false);
  respond(new Response('{"ok":true}'));
  assert.deepEqual(await result, { ok: true });
  t.mock.timers.tick(60 * minute);
  assert.equal(signal.reason.name, 'AbortError');
});

test('aborts missing response headers with a specific timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = withProviderResponse(signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('fetch failed')), { once: true });
  }), response => response.text());
  const rejected = assert.rejects(result, error => error instanceof ProviderTimeoutError &&
    error.phase === 'headers' && /response headers within 5 minutes/.test(error.message));
  t.mock.timers.tick(5 * minute);
  await rejected;
});

for (const responses of [false, true]) {
  test(`keeps ${responses ? 'Responses' : 'Chat Completions'} reasoning, heartbeats, and fragmented events alive beyond three minutes`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const source = provider();
    const reasoning = [];
    const result = withProviderResponse(source.request, response => readProviderStream(response, responses,
      { ...handlers, reasoning(delta) { reasoning.push(delta); } }));
    await flush();
    t.mock.timers.tick(2 * minute);
    source.send(': keep-alive\n\n');
    await flush();
    t.mock.timers.tick(2 * minute);
    source.send('data: ');
    await flush();
    t.mock.timers.tick(2 * minute);
    source.send(JSON.stringify(responses
      ? { type: 'response.reasoning_text.delta', delta: 'still working' }
      : { choices: [{ index: 0, delta: { reasoning_content: 'still working' } }] }) + '\n\n');
    await flush();
    t.mock.timers.tick(2 * minute);
    assert.equal(source.signal.aborted, false);
    const output = '{"blocks":[]}';
    source.send(`data: ${JSON.stringify(responses
      ? { type: 'response.output_text.delta', delta: output }
      : { choices: [{ index: 0, delta: { content: output } }] })}\n\n`);
    source.send(responses ? 'data: {"type":"response.completed"}\n\n' : 'data: [DONE]\n\n');
    const translated = await result;
    assert.equal(responses ? translated.output_text : translated.choices[0].message.content, output);
    assert.deepEqual(reasoning, ['still working']);
    assert.equal(source.signal.aborted, true);
    t.mock.timers.tick(60 * minute);
    assert.equal(source.signal.reason.name, 'AbortError');
  });
}

test('aborts an idle body five minutes after its last bytes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = provider();
  const result = withProviderResponse(source.request, response => readProviderStream(response, false, handlers));
  const rejected = assert.rejects(result, error => error instanceof ProviderTimeoutError &&
    error.phase === 'idle' && /no response data for 5 minutes/.test(error.message));
  await flush();
  t.mock.timers.tick(4 * minute);
  source.send(': still connected\n\n');
  await flush();
  t.mock.timers.tick(4 * minute);
  assert.equal(source.signal.aborted, false);
  t.mock.timers.tick(minute);
  await rejected;
});

test('aborts a body that sends headers but never sends any data', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = provider();
  const result = withProviderResponse(source.request, response => response.json());
  const rejected = assert.rejects(result, error => error.phase === 'idle');
  await flush();
  t.mock.timers.tick(5 * minute);
  await rejected;
});

test('caps a continuously active heartbeat stream at thirty minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = provider();
  const result = withProviderResponse(source.request, response => readProviderStream(response, false, handlers));
  const rejected = assert.rejects(result, error => error instanceof ProviderTimeoutError &&
    error.phase === 'total' && /total translation limit of 30 minutes/.test(error.message));
  await flush();
  for (let index = 0; index < 7; index++) {
    t.mock.timers.tick(4 * minute);
    source.send(': keep-alive\n\n');
    await flush();
    assert.equal(source.signal.aborted, false);
  }
  t.mock.timers.tick(2 * minute);
  await rejected;
});

test('applies activity deadlines to non-streaming JSON fallback bodies', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = provider();
  const result = withProviderResponse(source.request, response => response.json());
  await flush();
  t.mock.timers.tick(4 * minute);
  source.send('{"ok":');
  await flush();
  t.mock.timers.tick(4 * minute);
  source.send('true}');
  source.close();
  assert.deepEqual(await result, { ok: true });
});

test('preserves provider failures and releases unread response bodies and timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failure = new Error('Provider rejected the request.');
  const source = provider({ abortErrorsBody: false });
  await assert.rejects(withProviderResponse(source.request, async () => { throw failure; }), error => error === failure);
  assert.equal(source.signal.aborted, true);
  await flush();
  assert.equal(source.cancelled, true);
  t.mock.timers.tick(60 * minute);
  assert.equal(source.signal.reason.name, 'AbortError');
  await assert.rejects(withProviderResponse(async () => { throw failure; }, response => response.json()), error => error === failure);
});
