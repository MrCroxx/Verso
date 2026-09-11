import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

async function main() {
  const dir = path.resolve(process.argv[2]);
  const token = process.env.VERSO_DESKTOP_TOKEN;
  if (!token || !path.isAbsolute(process.env.VERSO_DATA_DIR || '')) {
    throw new Error('Desktop server requires a session token and an absolute data directory.');
  }
  process.env.NODE_ENV = 'production';
  process.chdir(dir);
  const { config } = JSON.parse(readFileSync(path.join(dir, '.next/required-server-files.json'), 'utf8'));
  // Match Next's standalone launcher while keeping the HTTP listener private.
  config.experimental.isrFlushToDisk = false;
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);
  const requireNext = createRequire(path.join(dir, 'package.json'));
  requireNext('next');
  const { getRequestHandlers } = requireNext('next/dist/server/lib/start-server');
  let handler;
  const server = createServer(async (request, response) => {
    if (request.headers.host !== `127.0.0.1:${server.address().port}` ||
        request.headers['x-verso-desktop-token'] !== token) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (!handler) {
      response.writeHead(503).end('Starting');
      return;
    }
    delete request.headers['x-verso-desktop-token'];
    try {
      await handler(request, response);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  process.env.PORT = String(port);
  process.env.__NEXT_PRIVATE_ORIGIN = `http://127.0.0.1:${port}`;
  ({ requestHandler: handler } = await getRequestHandlers({ dir, port, hostname: '127.0.0.1', isDev: false, server }));
  process.send?.({ type: 'ready', port });
}

// The detached process group also owns Poppler and OCR subprocesses.
process.on('disconnect', () => {
  if (process.platform !== 'win32') process.kill(-process.pid, 'SIGKILL');
  else process.exit(0);
});
main().catch((error) => { console.error(error); process.exit(1); });
