import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('open-file shortcuts and the native menu upload PDFs from every screen', {
  timeout: 90_000,
  skip: process.platform !== 'darwin' && !process.env.DISPLAY,
}, async (t) => {
  let electron;
  try { electron = (await import('electron')).default; }
  catch (error) {
    if (!error.message.includes('Electron failed to install correctly')) throw error;
    t.skip('Electron binary is not installed; the macOS packaging job runs this test.');
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'verso-file-shortcuts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = path.join(directory, 'server');
  await cp('.next/standalone', server, { recursive: true });
  await cp('.next/static', path.join(server, '.next/static'), { recursive: true });
  await cp('public', path.join(server, 'public'), { recursive: true });
  const env = { ...process.env, VERSO_TEST_DIRECTORY: directory, VERSO_TEST_NODE: process.execPath, VERSO_TEST_SERVER: server };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, ['tests/fixtures/file-shortcuts.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, output);
  assert.match(output, /"fileOpen":"passed"/, output);
  t.diagnostic(output.trim());
});
