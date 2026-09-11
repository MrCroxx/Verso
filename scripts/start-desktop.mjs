import { spawn } from 'node:child_process';
import electron from 'electron';

const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, VERSO_DESKTOP_NODE: process.execPath },
});
child.once('error', (error) => { console.error(error); process.exitCode = 1; });
child.once('exit', (code) => { process.exitCode = code ?? 1; });
