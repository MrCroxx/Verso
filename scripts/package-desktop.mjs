import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { packager } from '@electron/packager';
import { createPackagerOptions } from '../electron-packager.config.mjs';

if (process.platform !== 'darwin') throw new Error('Build the macOS app on a Mac, or use the macOS Desktop workflow.');
const args = process.argv.slice(2);
if (args.some((argument) => argument !== '--dir')) throw new Error('Only --dir is supported. Build each architecture on a matching Mac.');
const run = (command, arguments_) => execFileSync(command, arguments_, { stdio: 'inherit' });
run('npm', ['run', 'lint']);
run('npm', ['test']);
run('npm', ['run', 'desktop:prepare']);
run('npm', ['run', 'desktop:native']);
const [packaged] = await packager(createPackagerOptions());
const appDirectory = path.resolve(`dist/desktop/mac${process.arch === 'arm64' ? '-arm64' : ''}`);
await rm(appDirectory, { recursive: true, force: true });
await mkdir(path.dirname(appDirectory), { recursive: true });
await rename(packaged, appDirectory);
const appPath = path.join(appDirectory, 'Verso.app');
run(process.execPath, ['scripts/smoke-macos.mjs', appPath]);
if (!args.includes('--dir')) {
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const artifact = path.resolve(`dist/desktop/Verso-${version}-${process.arch}`);
  const staging = path.resolve('.desktop/dmg');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await cp(appPath, path.join(staging, 'Verso.app'), { recursive: true, verbatimSymlinks: true });
    await symlink('/Applications', path.join(staging, 'Applications'));
    run('/usr/bin/hdiutil', ['create', '-ov', '-format', 'UDZO', '-fs', 'HFS+', '-volname', 'Verso', '-srcfolder', staging, `${artifact}.dmg`]);
    await rm(`${artifact}.zip`, { force: true });
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, `${artifact}.zip`]);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
