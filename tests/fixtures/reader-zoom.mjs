import assert from 'node:assert/strict';
import { app, BrowserWindow, protocol, session } from 'electron';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { launchBackend } from '../../desktop/backend.mjs';
import { APP_URL, createProtocolHandler } from '../../desktop/protocol.mjs';

app.setPath('userData', path.join(process.env.VERSO_TEST_DIRECTORY, 'profile'));
let backend;
let window;
let exitCode = 0;
const waitFor = async (check) => {
  const deadline = performance.now() + 15_000;
  while (!await check()) {
    assert.ok(performance.now() < deadline, 'Timed out waiting for reader zoom');
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
    protocol.handle('https', createProtocolHandler({ ...ready,
      getCookies: url => session.defaultSession.cookies.get({ url }) }));
    window = new BrowserWindow({ show: false, width: 1400, height: 900,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    const js = code => window.webContents.executeJavaScript(code);
    const act = code => js(`(async () => { ${code} })()`);
    await window.loadURL(`${APP_URL}?book=${metadata.fingerprint}`);
    await waitFor(() => js('document.querySelectorAll(".page-spread").length === 80 && !!document.querySelector(".reader-zoom")'));
    await js(`new Promise(resolve => setTimeout(resolve, 800))`);
    await act(`
      window.nextFrames = async (count = 3) => { for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame); };
      window.zoomLabel = () => document.querySelector('.reader-zoom .zoom-fit').textContent;
      window.zoomWheel = (deltaY, extra = {}) => document.querySelector('.reader-viewport').dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY, clientX: 800, clientY: 450, ...extra }));
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
      for (let i = 0; i < 24; i++) { zoomWheel(i < 12 ? -8 : 8); await nextFrames(2); }
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
          zoomWheel(i >= 35 && i < 70 ? -4 : 4, { clientX }); await nextFrames(2);
          const r = canvas.getBoundingClientRect();
          maxAnchorError = Math.max(maxAnchorError, Math.abs(r.left + fixedPoint * r.width - clientX));
        }
        await new Promise(resolve => setTimeout(resolve, 400));
        await nextFrames();
        const r = canvas.getBoundingClientRect();
        const v = viewport.getBoundingClientRect();
        const centeredError = Math.abs(r.left + r.width / 2 - v.left - viewport.clientWidth / 2);
        const overflow = viewport.scrollWidth - viewport.clientWidth;
        key('0'); await nextFrames();
        return { maxAnchorError, centeredError, overflow };
      })()`);
      assert.ok(edge.maxAnchorError < 1, `${side} edge changed the gesture anchor by ${edge.maxAnchorError}px`);
      assert.ok(edge.centeredError < 1, `${side} edge did not settle back to the center`);
      assert.ok(edge.overflow <= 1, `${side} edge left an empty horizontal scroll area after settling`);
      edgeResults.push({ side, ...edge });
    }
    window.setSize(1000, 900);
    await act('await nextFrames(6)');
    assert.ok(await js(`Math.abs(document.querySelector('.reader-canvas').getBoundingClientRect().width
      - document.querySelector('.reader-viewport').clientWidth + 16) < 1`), 'Fit width must track viewport resizing');
    await act(`document.querySelector('[data-page="80"]').style.minHeight = '1800px'; await nextFrames(6);`);
    assert.ok(await js(`Math.abs(document.querySelector('.reader-canvas').getBoundingClientRect().height
      - document.querySelector('.spreads').getBoundingClientRect().height) < 1`), 'Scroll height must follow newly rendered content');
    console.log(JSON.stringify({ pages: 80, burstEvents: 40, scaleWrites: burst.writes,
      pointerDrift: { x: continuous.x - before.anchor.x, y: continuous.y - before.anchor.y },
      intrinsicLayoutUnchanged: true, bounds: '50%-300%', controlsAndResize: 'passed', edges: edgeResults }));
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window?.destroy();
    await backend?.stop();
    app.exit(exitCode);
  }

}
void run();
