import assert from 'node:assert/strict';
import { app, BrowserWindow, protocol, session } from 'electron';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchBackend } from '../../desktop/backend.mjs';
import { APP_URL, createProtocolHandler } from '../../desktop/protocol.mjs';
import { translationCacheKey } from '../../lib/translation-cache.ts';

app.setPath('userData', path.join(process.env.VERSO_TEST_DIRECTORY, 'profile'));
let backend;
let window;
let exitCode = 0;
const waitFor = async (check, message = 'Timed out waiting for reader zoom') => {
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
    const bytes = makePdf(80);
    const metadata = { fingerprint: 'a'.repeat(64), name: 'Reader zoom fixture.pdf', size: bytes.length,
      pageCount: 80, contentType: 'application/pdf' };
    const upload = await request('/api/books/uploads', 'POST', JSON.stringify(metadata));
    const part = await request(`/api/books/uploads/${upload.uploadId}/parts/1`, 'PUT', bytes,
      { 'Content-Type': 'application/octet-stream', 'x-object-key': upload.objectKey });
    await request(`/api/books/uploads/${upload.uploadId}/complete`, 'POST',
      JSON.stringify({ ...metadata, objectKey: upload.objectKey, parts: [part] }));
    for (const page of [1, 10]) await request('/api/translations', 'PUT', JSON.stringify({
      key: translationCacheKey(metadata.fingerprint, page, 'Simplified Chinese'), documentId: metadata.fingerprint, page,
      translation: { page, blocks: [{ kind: 'paragraph', text: 'Usage display fixture.' }], cachedAt: Date.parse('2026-09-14T09:00:00+08:00'),
        usage: { inputTokens: 12000, outputTokens: 3000, totalTokens: 15000, cachedInputTokens: 9000, outputSeconds: 30,
          ...(page === 1 && { cost: { amount: 0.0345, currency: 'USD' } }) } },
    }));
    protocol.handle('https', createProtocolHandler({ ...ready,
      getCookies: url => session.defaultSession.cookies.get({ url }) }));
    // Native pointer events require a visible window for the usage tooltip checks.
    window = new BrowserWindow({ show: true, width: 1400, height: 900,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const js = code => window.webContents.executeJavaScript(code);
    const act = code => js(`(async () => { ${code} })()`);
    await window.loadURL(`${APP_URL}?book=${metadata.fingerprint}`);
    window.focus();
    await waitFor(() => js('document.querySelectorAll(".page-spread").length === 80 && !!document.querySelector(".reader-zoom")'));
    await waitFor(() => js(`document.querySelector('[data-page="1"] .translation-usage')?.textContent.includes('0.0345')`));
    const usage = await js(`document.querySelector('[data-page="1"] .translation-usage').textContent`);
    assert.match(usage, /In12,000/);
    assert.match(usage, /Out3,000/);
    assert.match(usage, /TPS100.0/);
    assert.match(usage, /75.0%/);
    assert.match(usage, /USD\s0.0345/);
    assert.equal(await js(`!!document.querySelector('[data-page="2"] .translation-usage')`), false);
    const usageHeadingHeight = await js(`document.querySelector('[data-page="1"] .translation-heading').offsetHeight`);
    assert.equal(await js(`document.querySelector('[data-page="1"] .translation-usage-tooltip').hidden`), true);
    assert.equal(await js(`!!document.querySelector('[data-page="1"] .translation-usage button .lucide-info')`), true);
    const infoPosition = await js(`(() => {
      const info = document.querySelector('[data-page="1"] .translation-usage button').getBoundingClientRect();
      const refresh = document.querySelector('[data-page="1"] .translation-heading-actions > button').getBoundingClientRect();
      return { x: Math.round(info.x + info.width / 2), y: Math.round(info.y + info.height / 2), beforeRefresh: info.right <= refresh.left };
    })()`);
    assert.equal(infoPosition.beforeRefresh, true);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: infoPosition.x, y: infoPosition.y });
    await waitFor(() => js(`!document.querySelector('[data-page="1"] .translation-usage-tooltip').hidden`));
    assert.equal(await js(`document.querySelector('[data-page="1"] .translation-heading').offsetHeight`), usageHeadingHeight,
      'Showing usage details must not change the header height');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 10, y: 10 });
    await waitFor(() => js(`document.querySelector('[data-page="1"] .translation-usage-tooltip').hidden`));
    await js(`document.querySelector('[data-page="1"] .translation-usage button').focus()`);
    await waitFor(() => js(`!document.querySelector('[data-page="1"] .translation-usage-tooltip').hidden`));
    await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(() => js(`document.querySelector('[data-page="1"] .translation-usage-tooltip').hidden`));
    await js(`document.activeElement.blur()`);
    await js(`new Promise(resolve => setTimeout(resolve, 800))`);
    await act(`
      window.nextFrames = async (count = 3) => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame); };
      window.zoomLabel = () => document.querySelector('.reader-zoom .zoom-fit').textContent;
      // Control only timers scheduled synchronously by wheel handling. Rendering,
      // network activity, and the settling animation keep their real clocks.
      const nativeSetTimeout = window.setTimeout.bind(window);
      const nativeClearTimeout = window.clearTimeout.bind(window);
      const timers = new Map();
      let time = 0;
      let timerId = 0;
      window.clearTimeout = id => timers.delete(id) || nativeClearTimeout(id);
      window.advanceZoomTime = elapsed => {
        time += elapsed;
        for (const [id, timer] of timers) {
          if (timer.deadline > time) continue;
          timers.delete(id);
          timer.callback(...timer.args);
        }
        return timers.size;
      };
      window.zoomWheel = (deltaY, extra = {}) => {
        window.setTimeout = (callback, delay = 0, ...args) => {
          const id = --timerId;
          timers.set(id, { callback, args, deadline: time + delay });
          return id;
        };
        try {
          return document.querySelector('.reader-viewport').dispatchEvent(
            new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY, clientX: 800, clientY: 450, ...extra }));
        } finally { window.setTimeout = nativeSetTimeout; }
      };
      window.rect = () => document.querySelector('[data-page="10"]').getBoundingClientRect();
      window.measureAnchor = () => { const r = rect(); return { x: (800 - r.left) / r.width, y: (450 - r.top) / r.height }; };
      window.key = key => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
      document.querySelector('[data-page="10"]').scrollIntoView({ block: 'start', behavior: 'instant' });
      await nextFrames();
    `);
    await js(`new Promise(resolve => setTimeout(resolve, 1200))`);
    const before = await js(`({ anchor: measureAnchor(), height: document.querySelector('.spreads').offsetHeight,
      width: document.querySelector('[data-page="10"]').offsetWidth })`);
    // High-frequency input is accumulated, with at most one scale write per display frame.
    const burst = await js(`(async () => {
      let writes = 0;
      const observer = new MutationObserver(records => { writes += records.length; });
      observer.observe(document.querySelector('.spreads'), { attributes: true, attributeFilter: ['style'] });
      for (let i = 0; i < 40; i++) zoomWheel(-4);
      await nextFrames(); observer.disconnect();
      return { writes, label: zoomLabel(), anchor: measureAnchor(), height: document.querySelector('.spreads').offsetHeight,
        width: document.querySelector('[data-page="10"]').offsetWidth };
    })()`);
    assert.equal(burst.label, '190%');
    assert.equal(burst.writes, 1, 'A burst must produce one visual zoom update');
    assert.equal(burst.height, before.height, 'Zoom must not reflow book content');
    assert.equal(burst.width, before.width, 'Page layout width must remain constant');
    assert.ok(Math.abs(burst.anchor.x - before.anchor.x) < 0.002, 'Horizontal pointer anchor moved');
    assert.ok(Math.abs(burst.anchor.y - before.anchor.y) < 0.002, 'Vertical pointer anchor moved');
    if (process.env.VERSO_TEST_SCREENSHOT) {
      await writeFile(process.env.VERSO_TEST_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    }
    // Continuous gestures must keep the same content under the pointer without accumulated drift.
    const continuous = await js(`(async () => {
      for (let i = 0; i < 24; i++) { zoomWheel(i < 12 ? -8 : 8); await nextFrames(2); advanceZoomTime(32); }
      return measureAnchor();
    })()`);
    assert.ok(Math.abs(continuous.x - before.anchor.x) < 0.003);
    assert.ok(Math.abs(continuous.y - before.anchor.y) < 0.003);
    await act(`key('0'); await nextFrames();`);
    assert.equal(await js('zoomLabel()'), '100%');
    await act(`document.querySelector('.reader-zoom button:last-child').click(); await nextFrames(); zoomWheel(-10, { deltaMode: 1 }); await nextFrames();`);
    assert.equal(await js('zoomLabel()'), '190%', 'Line-based wheel deltas must be normalized');
    await act(`zoomWheel(-10000); await nextFrames();`);
    assert.equal(await js('zoomLabel()'), '300%');
    await act(`zoomWheel(10000); await nextFrames();`);
    assert.equal(await js('zoomLabel()'), '50%');
    const small = await js(`({ client: document.querySelector('.reader-viewport').clientWidth,
      scroll: document.querySelector('.reader-viewport').scrollWidth,
      height: document.querySelector('.reader-canvas').getBoundingClientRect().height,
      contentHeight: document.querySelector('.spreads').getBoundingClientRect().height })`);
    assert.ok(small.scroll <= small.client + 1, 'Shrinking must not leave an unscaled horizontal scroll area');
    assert.ok(Math.abs(small.height - small.contentHeight) < 1, 'Scroll height must follow the displayed content');
    await act(`document.querySelector('.reader-zoom button:last-child').click(); await nextFrames();
      document.querySelector('.reader-zoom button:nth-child(3)').click(); await nextFrames();`);
    assert.equal(await js('zoomLabel()'), '120%', 'Toolbar zoom remains functional');
    await act(`key('-'); await nextFrames();`);
    assert.equal(await js('zoomLabel()'), '100%');
    await act(`zoomWheel(-100, { ctrlKey: false }); await nextFrames();`);
    assert.equal(await js('zoomLabel()'), '100%', 'Ordinary scrolling must not zoom');
    // Keep the same content under the pointer through both edges and an immediate reversal.
    const edgeResults = [];
    for (const side of ['left', 'right']) {
      const edge = await js(`(async () => {
        const viewport = document.querySelector('.reader-viewport');
        const canvas = document.querySelector('.reader-canvas');
        const clientX = ${side === 'left' ? 400 : 1200};
        key('0'); await nextFrames();
        zoomWheel(-90); await nextFrames();
        viewport.scrollLeft = ${side === 'left' ? '0' : 'viewport.scrollWidth'};
        await nextFrames();
        const fixedPoint = (clientX - canvas.getBoundingClientRect().left) / canvas.getBoundingClientRect().width;
        let maxAnchorError = 0;
        for (let i = 0; i < 105; i++) {
          // A slow runner must not turn a continuous synthetic gesture into two gestures.
          if (i === 34 && clientX === 1200) await new Promise(resolve => setTimeout(resolve, 400));
          zoomWheel(i >= 35 && i < 70 ? -4 : 4, { clientX }); await nextFrames(2);
          const r = canvas.getBoundingClientRect();
          maxAnchorError = Math.max(maxAnchorError, Math.abs(r.left + fixedPoint * r.width - clientX));
          if (i < 104) advanceZoomTime(32);
        }
        const pendingBeforeIdle = advanceZoomTime(179);
        await nextFrames();
        const active = canvas.getBoundingClientRect();
        maxAnchorError = Math.max(maxAnchorError, Math.abs(active.left + fixedPoint * active.width - clientX));
        const pendingAfterIdle = advanceZoomTime(1);
        const deadline = performance.now() + 15_000;
        while (true) {
          await nextFrames();
          const r = canvas.getBoundingClientRect();
          const v = viewport.getBoundingClientRect();
          if (Math.abs(r.left + r.width / 2 - v.left - viewport.clientWidth / 2) < 0.1
            && viewport.scrollWidth - viewport.clientWidth <= 1) break;
          if (performance.now() > deadline) throw new Error('Timed out waiting for zoom settling');
        }
        const r = canvas.getBoundingClientRect();
        const v = viewport.getBoundingClientRect();
        const centeredError = Math.abs(r.left + r.width / 2 - v.left - viewport.clientWidth / 2);
        const overflow = viewport.scrollWidth - viewport.clientWidth;
        key('0'); await nextFrames();
        return { maxAnchorError, centeredError, overflow, pendingBeforeIdle, pendingAfterIdle };
      })()`);
      assert.equal(edge.pendingBeforeIdle, 1, 'The gesture must remain active before its idle deadline');
      assert.equal(edge.pendingAfterIdle, 0, 'The gesture must settle at its idle deadline');
      assert.ok(edge.maxAnchorError < 1, `${side} edge changed the gesture anchor by ${edge.maxAnchorError}px`);
      assert.ok(edge.centeredError < 1, `${side} edge did not settle back to the center`);
      assert.ok(edge.overflow <= 1, `${side} edge left an empty horizontal scroll area after settling`);
      edgeResults.push({ side, ...edge });
    }
    window.setSize(1000, 900);
    // ResizeObserver and React commits can take more than a fixed number of frames on CI.
    await waitFor(() => js(`window.outerWidth === 1000 && Math.abs(document.querySelector('.reader-canvas').getBoundingClientRect().width
      - document.querySelector('.reader-viewport').clientWidth + 16) < 1`), 'Fit width must track viewport resizing');
    const previousHeight = await js(`document.querySelector('.spreads').getBoundingClientRect().height`);
    await act(`const page = document.querySelector('[data-page="80"]'); page.style.minHeight = (page.offsetHeight + 1000) + 'px';`);
    await waitFor(() => js(`(() => {
      const height = document.querySelector('.reader-canvas').getBoundingClientRect().height;
      return height > ${previousHeight} + 1
        && Math.abs(height - document.querySelector('.spreads').getBoundingClientRect().height) < 1;
    })()`), 'Scroll height must follow newly rendered content');
    // Font preferences and resizable columns must survive the shared-settings/zoom integration.
    await act(`
      document.querySelector('.reader-font-button').click();
      await nextFrames();
      const slider = document.querySelector('.reader-font-size input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '150');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      await nextFrames();
      document.querySelector('.reader-font-family input[value="sans"]').click();
      await nextFrames();
    `);
    assert.equal(await js(`getComputedStyle(document.querySelector('.spreads')).getPropertyValue('--translation-font-scale').trim()`), '1.5');
    assert.equal(await js(`document.querySelector('.reader-viewport').dataset.translationFont`), 'sans');
    await act(`
      const divider = document.querySelector('.reader-divider');
      divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
      await nextFrames();
    `);
    assert.equal(await js(`document.querySelector('.reader-divider').getAttribute('aria-valuenow')`), '55');
    const split = await js(`(() => {
      const page = document.querySelector('.page-spread');
      return page.querySelector('.source-page').getBoundingClientRect().width / page.getBoundingClientRect().width;
    })()`);
    assert.ok(Math.abs(split - 0.55) < 0.01, 'Column resizing must change the rendered source width');
    assert.equal(await js(`(() => {
      const heading = document.querySelector('[data-page="1"] .translation-heading').getBoundingClientRect();
      return [...document.querySelectorAll('[data-page="1"] .translation-heading-actions button')].every(span => {
        const rect = span.getBoundingClientRect();
        return rect.left >= heading.left - 1 && rect.right <= heading.right + 1 && rect.bottom <= heading.bottom + 1;
      });
    })()`), true, 'Usage and refresh buttons must fit within the resized page header');
    await act(`document.querySelector('.reader-divider').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await nextFrames();`);
    assert.equal(await js(`document.querySelector('.reader-divider').getAttribute('aria-valuenow')`), '50');
    await window.webContents.reload();
    await waitFor(() => js(`document.querySelector('.reader-viewport')?.dataset.translationFont === 'sans'
      && getComputedStyle(document.querySelector('.spreads')).getPropertyValue('--translation-font-scale').trim() === '1.5'`),
    'Font preferences must persist across a desktop reload');
    await window.loadURL(`${APP_URL}?book=${metadata.fingerprint}&page=10`);
    await waitFor(() => js(`!!document.querySelector('[data-page="10"] .translation-usage')`));
    assert.doesNotMatch(await js(`document.querySelector('[data-page="10"] .translation-usage').textContent`), /USD/);
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true, cancelable: true }))`);
    await waitFor(() => js(`!!document.querySelector('#pricing-inputPerMillion')`));
    const settingsUrl = await js('location.href');
    assert.equal(new URL(settingsUrl).searchParams.get('returnTo'), `/?book=${metadata.fingerprint}&page=10`);
    await js(`document.querySelector('#pricing-inputPerMillion').focus();
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true, cancelable: true }))`);
    assert.equal(await js('location.href'), settingsUrl, 'Repeated shortcuts in Settings must preserve the return path');
    for (const [id, value] of [['pricing-inputPerMillion', '2.5'], ['pricing-outputPerMillion', '8'], ['pricing-cachedInputPerMillion', '0.5']]) {
      await js(`(() => {
        const input = document.getElementById(${JSON.stringify(id)});
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    }
    await waitFor(async () => (await request('/api/settings/ai-provider', 'GET')).pricing?.cachedInputPerMillion === 0.5);
    assert.deepEqual((await request('/api/settings/ai-provider', 'GET')).pricing,
      { currency: 'USD', inputPerMillion: 2.5, outputPerMillion: 8, cachedInputPerMillion: 0.5 });
    await js(`document.querySelector('.settings-shell .topbar > a.secondary-button').click()`);
    await waitFor(() => js(`!!document.querySelector('[data-page="10"] .translation-usage')`));
    assert.match(await js(`document.querySelector('[data-page="10"] .translation-usage').textContent`), /USD\s0.036/);
    await js(`window.dispatchEvent(new Event('verso:open-settings'))`);
    await waitFor(() => js(`!!document.querySelector('#pricing-currency')`));
    for (const [id, value] of [['pricing-currency', 'CNY'], ['pricing-schedule', 'deepseek-peak']]) {
      await js(`(() => {
        const select = document.getElementById(${JSON.stringify(id)});
        select.value = ${JSON.stringify(value)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    }
    await waitFor(async () => (await request('/api/settings/ai-provider', 'GET')).pricing?.schedule === 'deepseek-peak');
    assert.equal((await request('/api/settings/ai-provider', 'GET')).pricing.currency, 'CNY');
    await window.loadURL(`${APP_URL}/settings`);
    await waitFor(() => js(`document.querySelector('#pricing-inputPerMillion')?.value === '2.5'`));
    assert.equal(await js(`document.querySelector('#pricing-schedule').value`), 'deepseek-peak');
    assert.equal(await js(`document.querySelector('#pricing-currency').value`), 'CNY');
    await window.loadURL(`${APP_URL}?book=${metadata.fingerprint}`);
    await waitFor(() => js(`/USD\\s0.0345/.test(document.querySelector('[data-page="1"] .translation-usage')?.textContent ?? '')`));
    await window.loadURL(`${APP_URL}?book=${metadata.fingerprint}&page=10`);
    await waitFor(() => js(`!!document.querySelector('[data-page="10"] .translation-usage')`));
    assert.match(await js(`document.querySelector('[data-page="10"] .translation-usage').textContent`), /CNY\s0.072/);
    const historical = await request(`/api/translations?key=${encodeURIComponent(translationCacheKey(metadata.fingerprint, 10, 'Simplified Chinese'))}`, 'GET');
    assert.equal(historical.translation.usage.cost, undefined, 'Estimates must leave the original tokens and costs intact');
    await window.loadURL(APP_URL);
    await waitFor(() => js(`!!document.querySelector('.settings-link')`));
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true, cancelable: true }))`);
    await waitFor(() => js(`!!document.querySelector('#pricing-inputPerMillion')`));
    // Help is a styled, nonmodal peek that follows the held key without moving focus.
    await js(`window.shortcutKey = (key, extra = {}) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key, metaKey: false, ctrlKey: false, bubbles: true, cancelable: true, ...extra,
    })); document.querySelector('#pricing-inputPerMillion').focus(); shortcutKey('?');`);
    assert.equal(await js(`!!document.querySelector('#shortcut-help-panel')`), false);
    const settingsBeforeTyping = await js('location.href');
    await js(`shortcutKey('[', { metaKey: true });`);
    assert.equal(await js('location.href'), settingsBeforeTyping);
    await js(`document.querySelector('.shortcut-help-button').focus();`);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: '?', modifiers: ['shift'] });
    await waitFor(() => js(`!!document.querySelector('#shortcut-help-panel')`));
    assert.equal(await js(`document.activeElement.classList.contains('shortcut-help-button')`), true);
    const help = await js(`document.querySelector('#shortcut-help-panel').textContent`);
    assert.match(help, /Keyboard shortcuts/);
    assert.match(help, /(?:⌘|Ctrl\+)B/);
    assert.match(help, /(?:⌘|Ctrl\+)\[/);
    assert.doesNotMatch(help, /Esc|Close keyboard shortcuts/);
    assert.equal(await js(`!!document.querySelector('dialog[open], #shortcut-help-panel button')`), false);
    const panelStyle = await js(`(() => {
      const panel = document.querySelector('#shortcut-help-panel');
      const style = getComputedStyle(panel), box = panel.getBoundingClientRect();
      return { position: style.position, radius: style.borderRadius, width: box.width, height: box.height,
        left: box.left, right: box.right, bottom: box.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight,
        paper: style.backgroundColor, pagePaper: getComputedStyle(document.querySelector('.settings-card')).backgroundColor };
    })()`);
    assert.equal(panelStyle.position, 'fixed', 'The overlay CSS must be included in the production build');
    assert.equal(panelStyle.radius, '12px');
    assert.ok(panelStyle.width <= 560 && panelStyle.height < 400);
    assert.ok(panelStyle.left >= 16 && panelStyle.right <= panelStyle.viewportWidth - 16 && panelStyle.bottom <= panelStyle.viewportHeight);
    assert.equal(panelStyle.paper, panelStyle.pagePaper, 'The overlay must use the existing surface color');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    assert.equal(await js(`!!document.querySelector('#shortcut-help-panel')`), true, 'Help remains visible while ? is held');
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: '/', modifiers: [] });
    await waitFor(() => js(`!document.querySelector('#shortcut-help-panel')`));

    // Releasing Shift first, releasing over a form field, and losing the window must all dismiss it.
    await js(`shortcutKey('?', { code: 'Slash', shiftKey: true });`);
    await waitFor(() => js(`!!document.querySelector('#shortcut-help-panel')`));
    await js(`window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft' }));`);
    await waitFor(() => js(`!document.querySelector('#shortcut-help-panel')`));
    await js(`shortcutKey('?', { code: 'Slash', shiftKey: true });`);
    await waitFor(() => js(`!!document.querySelector('#shortcut-help-panel')`));
    await js(`document.querySelector('#pricing-inputPerMillion').focus();
      document.activeElement.addEventListener('keyup', event => event.stopPropagation(), { once: true });
      document.activeElement.dispatchEvent(new KeyboardEvent('keyup', { key: '/', code: 'Slash', bubbles: true }));`);
    await waitFor(() => js(`!document.querySelector('#shortcut-help-panel')`));
    await js(`document.querySelector('.shortcut-help-button').focus(); shortcutKey('?', { code: 'Slash' });`);
    await waitFor(() => js(`!!document.querySelector('#shortcut-help-panel')`));
    await js(`window.dispatchEvent(new Event('blur')); shortcutKey('?', { code: 'Slash', repeat: true });`);
    await waitFor(() => js(`!document.querySelector('#shortcut-help-panel')`));

    const helpPosition = await js(`(() => {
      const box = document.querySelector('.shortcut-help-button').getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...helpPosition, button: 'left', clickCount: 1 });
    await waitFor(() => js(`!!document.querySelector('#shortcut-help-panel')`));
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 10, y: 10 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: 10, y: 10, button: 'left', clickCount: 1 });
    await waitFor(() => js(`!document.querySelector('#shortcut-help-panel')`));
    await js(`document.querySelector('.shortcut-help-button').focus(); shortcutKey(' ');`);
    await waitFor(() => js(`!!document.querySelector('#shortcut-help-panel')`));
    await js(`window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));`);
    await waitFor(() => js(`!document.querySelector('#shortcut-help-panel')`));

    await window.loadURL(`${APP_URL}?book=${metadata.fingerprint}&page=10`);
    await waitFor(() => js(`document.querySelector('.page-stepper strong')?.textContent === '10'
      && !!document.querySelector('[data-page="10"] .translation-usage')`));
    await js(`window.shortcutKey = (key, extra = {}) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key, metaKey: true, bubbles: true, cancelable: true, ...extra,
    })); document.activeElement.blur(); shortcutKey('b'); shortcutKey('b', { repeat: true });`);
    await waitFor(() => js(`document.querySelector('.sidebar').classList.contains('collapsed')`));
    assert.match(await js(`document.querySelector('.reader-sidebar-button').title`), /(?:⌘|Ctrl\+)B/);
    await js(`shortcutKey('b');`);
    await waitFor(() => js(`!document.querySelector('.sidebar').classList.contains('collapsed')`));
    await js(`document.querySelector('#sidebar-tab-search').click();`);
    await waitFor(() => js(`!!document.querySelector('#sidebar-search input')`));
    await js(`document.querySelector('#sidebar-search input').focus(); shortcutKey('b'); shortcutKey('?', { metaKey: false });`);
    assert.equal(await js(`document.querySelector('.sidebar').classList.contains('collapsed')`), false);
    assert.equal(await js(`!!document.querySelector('#shortcut-help-panel')`), false);
    await js(`document.activeElement.blur(); shortcutKey('b');`);
    await waitFor(() => js(`document.querySelector('.sidebar').classList.contains('collapsed')`));
    await js(`shortcutKey('b');`);
    await waitFor(() => js(`document.querySelector('#sidebar-tab-search')?.getAttribute('aria-selected') === 'true'`));
    window.setSize(600, 900);
    await waitFor(() => js(`innerWidth <= 900`));
    await js(`document.activeElement.blur(); shortcutKey('b');`);
    await waitFor(() => js(`document.querySelector('.sidebar').classList.contains('mobile-open')`));
    await js(`shortcutKey('b');`);
    await waitFor(() => js(`!document.querySelector('.sidebar').classList.contains('mobile-open')`));
    window.setSize(1400, 900);
    await waitFor(() => js(`innerWidth > 900`));

    // History traverses actual app entries and preserves the book's page on repeated visits.
    await js(`document.querySelector('#sidebar-tab-pages').click();`);
    await waitFor(() => js(`!!document.querySelector('#sidebar-pages button:nth-child(10)')`));
    await js(`document.querySelector('#sidebar-pages button:nth-child(10)').click();`);
    await waitFor(() => js(`document.querySelector('.page-stepper strong')?.textContent === '10'`));
    await js(`document.querySelector('.reader-settings-button').click();`);
    await waitFor(() => js(`location.pathname === '/settings' && !!document.querySelector('#pricing-inputPerMillion')`));
    await js(`document.activeElement.blur(); shortcutKey('[');`);
    await waitFor(() => js(`location.pathname === '/' && document.querySelector('.page-stepper strong')?.textContent === '10'`));
    assert.match(await js(`document.querySelector('.history-forward-button').title`), /(?:⌘|Ctrl\+)\]/);
    await js(`document.querySelector('.history-forward-button').click();`);
    await waitFor(() => js(`location.pathname === '/settings'`));
    await js(`document.activeElement.blur(); shortcutKey('[');`);
    await waitFor(() => js(`document.querySelector('.page-stepper strong')?.textContent === '10'`));
    await js(`document.querySelector('.reader-identity .brand-button').click();`);
    await waitFor(() => js(`!!document.querySelector('.library-shell')`));
    await js(`document.activeElement.blur(); shortcutKey('[');`);
    await waitFor(() => js(`document.querySelector('.page-stepper strong')?.textContent === '10'`));
    await js(`document.activeElement.blur(); shortcutKey(']');`);
    await waitFor(() => js(`!!document.querySelector('.library-shell')`));
    // Capture both themes from the actual production renderer and check the compact layout.
    await window.loadURL(APP_URL);
    await waitFor(() => js(`!!document.querySelector('.library-shell .library-book')`));
    await js(`document.documentElement.dataset.theme = 'light';
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }));`);
    await waitFor(() => js(`!!document.querySelector('#shortcut-help-panel')`));
    const captureDirectory = process.env.VERSO_TEST_SHORTCUT_SCREENSHOTS;
    await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    if (captureDirectory) {
      await mkdir(captureDirectory, { recursive: true });
      await writeFile(path.join(captureDirectory, 'shortcuts-light.png'), (await window.webContents.capturePage()).toPNG());
    }
    await js(`document.documentElement.dataset.theme = 'dark'; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    assert.equal(await js(`getComputedStyle(document.querySelector('#shortcut-help-panel')).backgroundColor`), 'rgb(27, 33, 29)');
    if (captureDirectory) await writeFile(path.join(captureDirectory, 'shortcuts-dark.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(390, 700);
    await waitFor(() => js(`innerWidth <= 390`));
    assert.equal(await js(`(() => { const box = document.querySelector('#shortcut-help-panel').getBoundingClientRect();
      return box.left >= 16 && box.right <= innerWidth - 16 && box.bottom <= innerHeight; })()`), true);
    if (captureDirectory) await writeFile(path.join(captureDirectory, 'shortcuts-mobile.png'), (await window.webContents.capturePage()).toPNG());
    await js(`window.dispatchEvent(new KeyboardEvent('keyup', { key: '/' }));`);
    await waitFor(() => js(`!document.querySelector('#shortcut-help-panel')`));
    console.log(JSON.stringify({ pages: 80, burstEvents: 40, scaleWrites: burst.writes,
      pointerDrift: { x: continuous.x - before.anchor.x, y: continuous.y - before.anchor.y },
      intrinsicLayoutUnchanged: true, bounds: '50%-300%', controlsAndResize: 'passed', usageAndPricing: 'passed', appShortcuts: 'passed', edges: edgeResults }));
  } catch (error) {
    console.error(error);
    if (window && !window.isDestroyed()) console.error(await window.webContents.executeJavaScript(`JSON.stringify({
      url: location.href, page: document.querySelector('.page-stepper strong')?.textContent,
      sidebar: document.querySelector('.sidebar')?.className, active: document.activeElement.outerHTML.slice(0, 200),
      helpVisible: !!document.querySelector('#shortcut-help-panel'),
    })`));
    exitCode = 1;
  } finally {
    // Keep Electron alive until async cleanup finishes; app.exit closes the windows.
    await backend?.stop();
    app.exit(exitCode);
  }

}
void run();
