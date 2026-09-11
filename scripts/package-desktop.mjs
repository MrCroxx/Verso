import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.platform !== 'darwin') throw new Error('Build the macOS app on a Mac, or use the macOS Desktop workflow.');
const args = process.argv.slice(2);
if (args.some((argument) => argument !== '--dir')) throw new Error('Only --dir is supported. Build each architecture on a matching Mac.');
const run = (command, arguments_) => execFileSync(command, arguments_, { stdio: 'inherit' });
run('npm', ['run', 'lint']);
run('npm', ['test']);
run('npm', ['run', 'desktop:prepare']);
run('npm', ['run', 'desktop:native']);
const require = createRequire(import.meta.url);
run(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', 'electron-builder.config.cjs', '--mac', `--${process.arch}`, '--publish', 'never', ...args]);
run(process.execPath, ['scripts/smoke-macos.mjs', `dist/desktop/mac${process.arch === 'arm64' ? '-arm64' : ''}/Verso.app`]);
