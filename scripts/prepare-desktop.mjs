import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

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
await sharp(path.join(root, 'public/favicon.svg'), { density: 3072 })
  .resize(1024, 1024).png().toFile(path.join(root, '.desktop/icon.png'));
