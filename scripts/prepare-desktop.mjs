import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const destination = path.join(root, '.desktop/server');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(path.join(root, '.next/standalone'), destination, {
  recursive: true, dereference: true,
  filter: (source) => !['.data', '.env', '.env.local', '.env.production', '.env.production.local'].includes(path.basename(source)),
});
await cp(path.join(root, '.next/static'), path.join(destination, '.next/static'), { recursive: true });
await cp(path.join(root, 'public'), path.join(destination, 'public'), { recursive: true });
const appRoot = path.join(root, '.desktop/app');
await rm(appRoot, { recursive: true, force: true });
await mkdir(appRoot, { recursive: true });
await cp(path.join(root, 'desktop'), path.join(appRoot, 'desktop'), { recursive: true });
const { name, version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({
  name, version, main: 'desktop/main.mjs', type: 'module',
  description: 'A local AI parallel reader for PDF books', author: 'mrcroxx',
}, null, 2) + '\n');
console.log(`Prepared desktop server: ${destination}`);
await sharp(path.join(root, 'desktop/icon.svg'))
  .resize(1024, 1024).png().toFile(path.join(root, '.desktop/icon.png'));
if (process.platform === 'darwin') {
  const iconset = path.join(root, '.desktop/Verso.iconset');
  await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      await sharp(path.join(root, '.desktop/icon.png')).resize(size * scale, size * scale)
        .toFile(path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(root, '.desktop/icon.icns')], { stdio: 'inherit' });
}
