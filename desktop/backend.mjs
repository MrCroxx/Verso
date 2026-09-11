import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function launchBackend({ nodePath, serverRoot, dataDirectory, nativeRoot, serverEntry = fileURLToPath(new URL('./server.mjs', import.meta.url)), onExit = () => {}, timeoutMs = 60_000 }) {
  if (!nodePath) throw new Error('Node runtime is missing. Start desktop development with npm run desktop:dev.');
  const token = randomBytes(32).toString('hex');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('DYLD_') || key.startsWith('NEXT_') || key.startsWith('__NEXT_') ||
        key.startsWith('NODE_') || key.startsWith('ELECTRON_') || key.startsWith('VERSO_')) delete env[key];
  }
  Object.assign(env, {
    NODE_ENV: 'production', HOSTNAME: '127.0.0.1',
    VERSO_DATA_DIR: dataDirectory, VERSO_DESKTOP_TOKEN: token,
  });
  if (nativeRoot) {
    env.PATH = `${path.join(nativeRoot, 'bin')}:/usr/bin:/bin`;
    env.TESSDATA_PREFIX = path.join(nativeRoot, 'share/tessdata');
    env.FONTCONFIG_FILE = path.join(nativeRoot, 'etc/fonts.conf');
    env.XDG_CACHE_HOME = path.join(dataDirectory, 'cache');
  }
  const child = fork(serverEntry, [serverRoot], {
    execPath: nodePath, execArgv: [], env, cwd: serverRoot,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stopping = false;
  let output = '';
  let stopPromise;
  const collect = (chunk) => { output = (output + chunk).slice(-16_384); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const kill = (signal = 'SIGKILL') => {
    try {
      if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const stop = () => stopPromise ??= new Promise((resolve) => {
    stopping = true;
    if (!child.pid) { resolve(); return; }
    if (child.exitCode !== null || child.signalCode !== null) { kill(); resolve(); return; }
    const timer = setTimeout(() => { kill(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); kill(); resolve(); });
    kill('SIGTERM');
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The local reader did not start within ${timeoutMs / 1000} seconds.\n${output}`));
      void stop();
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      kill();
      const error = new Error(`The local reader stopped (${signal || code}).\n${output}`);
      reject(error);
      if (!stopping) onExit(error);
    });
    child.on('message', (message) => {
      if (message.type !== 'ready' || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
      clearTimeout(timer);
      resolve({ origin: `http://127.0.0.1:${message.port}`, token });
    });
  });
  return { ready, stop, kill, child };
}
