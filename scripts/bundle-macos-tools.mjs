import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('Native desktop dependencies must be bundled on an arm64 or x64 Mac.');
}
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const root = path.resolve('.desktop/native');
rmSync(root, { recursive: true, force: true });
for (const directory of ['bin', 'lib', 'share/tessdata', 'share/poppler', 'etc', 'licenses']) mkdirSync(path.join(root, directory), { recursive: true });
const prefix = (formula) => run('brew', ['--prefix', formula]);
const poppler = prefix('poppler');
const tesseract = prefix('tesseract');
const languages = prefix('tesseract-lang');
const copied = new Map();
let relocatedDataPaths = 0;
const kegs = new Set([realpathSync(poppler), realpathSync(tesseract), realpathSync(languages)]);
const systemLibrary = (name) => name.startsWith('/usr/lib/') || name.startsWith('/System/Library/');

function dependencies(file) {
  return run('/usr/bin/otool', ['-L', file]).split('\n').slice(1)
    .map((line) => line.trim().split(' (')[0]).filter(Boolean);
}

function resolveDependency(name, source, executableDirectory) {
  const expand = (value) => value.replace('@loader_path', path.dirname(source)).replace('@executable_path', executableDirectory);
  if (path.isAbsolute(name)) return name;
  if (!name.startsWith('@rpath/')) return expand(name);
  const commands = run('/usr/bin/otool', ['-l', source]);
  const rpaths = [...commands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset/g)].map((match) => expand(match[1]));
  const found = rpaths.map((directory) => path.join(directory, name.slice(7))).find(existsSync);
  if (!found) throw new Error(`Cannot resolve ${name} referenced by ${source}`);
  return found;
}

function bundle(sourcePath, target, executableDirectory = path.dirname(sourcePath)) {
  const source = realpathSync(sourcePath);
  if (copied.has(source)) return copied.get(source);
  const architectures = run('/usr/bin/lipo', ['-archs', source]).split(/\s+/);
  const expected = process.arch === 'x64' ? 'x86_64' : 'arm64';
  if (!architectures.includes(expected)) throw new Error(`${source} does not support ${expected}. Use native Homebrew and Node.`);
  target ||= path.join(root, 'lib', `${createHash('sha256').update(source).digest('hex').slice(0, 12)}-${path.basename(source)}`);
  copied.set(source, target);
  const cellar = source.match(/^(.*\/Cellar\/[^/]+\/[^/]+)\//);
  if (cellar) kegs.add(cellar[1]);
  copyFileSync(source, target);
  chmodSync(target, 0o755);
  const edits = [];
  const libraryId = run('/usr/bin/otool', ['-D', source]).split('\n')[1]?.trim();
  for (const dependency of dependencies(source)) {
    if (systemLibrary(dependency) || dependency === libraryId) continue;
    const resolved = resolveDependency(dependency, source, executableDirectory);
    if (realpathSync(resolved) === source) continue;
    const bundled = bundle(resolved, undefined, executableDirectory);
    edits.push('-change', dependency, `@loader_path/${path.relative(path.dirname(target), bundled)}`);
  }
  if (target.endsWith('.dylib')) edits.push('-id', `@loader_path/${path.basename(target)}`);
  // Homebrew bottles are already signed; rewriting their load commands invalidates that signature.
  const unsigned = spawnSync('/usr/bin/codesign', ['--remove-signature', target], { encoding: 'utf8' });
  if (unsigned.status !== 0 && !unsigned.stderr?.includes('not signed at all')) throw new Error(unsigned.stderr || 'Unable to remove native code signature.');
  // Poppler embeds its data directory. Its children run from Resources/server,
  // so a shorter, NUL-padded relative path remains valid after moving the app.
  if (path.basename(source).includes('poppler')) {
    const bytes = readFileSync(target);
    for (const match of bytes.toString('latin1').matchAll(/\/(?:opt\/homebrew|usr\/local)\/[\x20-\x7e]*?\/share\/poppler(?=\0)|\/(?:opt\/homebrew|usr\/local)\/share\/poppler(?=\0)/g)) {
      const replacement = Buffer.from('../native/share/poppler');
      if (replacement.length > match[0].length) throw new Error('Poppler data path is too short to relocate.');
      bytes.fill(0, match.index, match.index + match[0].length);
      replacement.copy(bytes, match.index);
      relocatedDataPaths++;
    }
    writeFileSync(target, bytes);
  }
  if (edits.length) run('/usr/bin/install_name_tool', [...edits, target]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', target]);
  return target;
}

bundle(process.execPath, path.join(root, 'bin/node'));
for (const tool of ['pdftocairo', 'pdftotext', 'pdfinfo']) bundle(path.join(poppler, 'bin', tool), path.join(root, 'bin', tool));
bundle(path.join(tesseract, 'bin/tesseract'), path.join(root, 'bin/tesseract'));
for (const language of ['eng', 'chi_sim', 'chi_tra', 'jpn', 'osd']) {
  const source = [tesseract, languages].map((directory) => path.join(directory, 'share/tessdata', `${language}.traineddata`)).find(existsSync);
  if (!source) throw new Error(`Missing OCR language data: ${language}`);
  copyFileSync(source, path.join(root, 'share/tessdata', `${language}.traineddata`));
}
for (const directory of ['configs', 'tessconfigs']) {
  cpSync(path.join(tesseract, 'share/tessdata', directory), path.join(root, 'share/tessdata', directory), { recursive: true });
}
const popplerData = path.join(poppler, 'share/poppler');
if (!relocatedDataPaths) throw new Error('Cannot locate the embedded Poppler data path; update the relocation step for this Homebrew build.');
cpSync(popplerData, path.join(root, 'share/poppler'), { recursive: true, dereference: true });
writeFileSync(path.join(root, 'etc/fonts.conf'), `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>/System/Library/Fonts</dir>
  <dir>/Library/Fonts</dir>
  <dir prefix="xdg">fonts</dir>
  <cachedir prefix="xdg">fontconfig</cachedir>
</fontconfig>
`);

// Preserve installed package notices and build receipts alongside the binaries.
for (const keg of kegs) {
  const destination = path.join(root, 'licenses', `${path.basename(path.dirname(keg))}-${path.basename(keg)}`);
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(keg)) {
    if (/^(licen[cs]e|copying|notice|authors|copyright|readme)/i.test(name) || name === 'INSTALL_RECEIPT.json' || name === '.brew') {
      cpSync(path.join(keg, name), path.join(destination, name), { recursive: true, dereference: true });
    }
  }
}
const nodeLicense = new URL(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
const response = await fetch(nodeLicense);
if (!response.ok) throw new Error(`Cannot retrieve the Node.js license: ${response.status}`);
writeFileSync(path.join(root, 'licenses/Node-LICENSE'), await response.text());
writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
  architecture: process.arch, node: process.version,
  binaries: [...copied].map(([source, target]) => ({ source, path: path.relative(root, target) })),
  formulae: JSON.parse(run('brew', ['info', '--json=v2', ...[...kegs].map((keg) => path.basename(path.dirname(keg)))])),
}, null, 2) + '\n');

for (const target of copied.values()) {
  for (const dependency of dependencies(target)) {
    if (!systemLibrary(dependency) && !dependency.startsWith('@loader_path/')) throw new Error(`Unbundled dependency in ${target}: ${dependency}`);
  }
}
console.log(`Bundled ${copied.size} native binaries for ${process.arch}.`);
