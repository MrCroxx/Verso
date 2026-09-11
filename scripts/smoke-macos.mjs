import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSmokePdf } from './smoke-pdf.mjs';

if (process.platform !== 'darwin' || !process.argv[2]?.endsWith('.app')) throw new Error('Usage: node scripts/smoke-macos.mjs path/to/Verso.app');
const temporary = await mkdtemp(path.join(tmpdir(), 'verso moved app '));
try {
  const appPath = path.join(temporary, 'Verso.app');
  await cp(path.resolve(process.argv[2]), appPath, { recursive: true, verbatimSymlinks: true });
  const resources = path.join(appPath, 'Contents/Resources');
  const iconFile = execFileSync('/usr/bin/plutil', [
    '-extract', 'CFBundleIconFile', 'raw', '-o', '-', path.join(appPath, 'Contents/Info.plist'),
  ], { encoding: 'utf8' }).trim();
  assert.equal(path.basename(iconFile), iconFile, 'The bundle icon must be a resource filename');
  const icon = await readFile(path.join(resources, iconFile.endsWith('.icns') ? iconFile : `${iconFile}.icns`));
  assert.equal(icon.toString('ascii', 0, 4), 'icns');
  assert.equal(icon.readUInt32BE(4), icon.length, 'The ICNS must not be truncated');
  assert.deepEqual(icon, await readFile('.desktop/icon.icns'), 'The app must contain the generated Verso icon');
  assert.deepEqual(await readFile(path.join(resources, 'icon.png')), await readFile('.desktop/icon.png'));
  const nativeRoot = path.join(resources, 'native');
  const env = {
    HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || tmpdir(), PATH: '/usr/bin:/bin',
    TESSDATA_PREFIX: path.join(nativeRoot, 'share/tessdata'),
    FONTCONFIG_FILE: path.join(nativeRoot, 'etc/fonts.conf'), XDG_CACHE_HOME: path.join(temporary, 'cache'),
  };
  const run = (tool, args) => execFileSync(path.join(nativeRoot, 'bin', tool), args, {
    env, cwd: path.join(resources, 'server'), encoding: 'utf8', timeout: 60_000,
  });
  assert.match(run('node', ['-e', 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(":memory:"); console.log(db.prepare("SELECT 42 AS answer").get().answer); db.close();']), /42/);
  const source = path.join(temporary, 'test.pdf');
  const rendered = path.join(temporary, 'rendered');
  await writeFile(source, createSmokePdf());
  assert.match(run('pdfinfo', [source]), /Pages:\s+1/);
  assert.match(run('pdftotext', [source, '-']), /Verso desktop reader/);
  assert.ok(run('pdftotext', ['-listenc']).trim().split('\n').length > 8, 'Bundled Poppler character maps are available');
  run('pdftocairo', ['-jpeg', '-singlefile', '-scale-to', '1600', source, rendered]);
  assert.ok((await stat(`${rendered}.jpg`)).size > 1000);
  const languages = run('tesseract', ['--list-langs']);
  for (const language of ['eng', 'chi_sim', 'chi_tra', 'jpn']) assert.ok(languages.split('\n').includes(language));
  assert.match(run('tesseract', [`${rendered}.jpg`, 'stdout', '-l', 'eng+chi_sim+chi_tra+jpn']), /Verso/i);
  const manifest = JSON.parse(await readFile(path.join(nativeRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.architecture, process.arch);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(path.join(appPath, 'Contents/MacOS/Verso'), ['--smoke-test', `--smoke-data=${path.join(temporary, 'profile')}`, `--smoke-pdf=${source}`], {
    env, cwd: temporary, stdio: 'inherit', timeout: 90_000,
  });
  console.log('Moved macOS app, bundled SQLite, PDF rendering, OCR, and desktop window passed.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
