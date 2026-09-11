export const APP_URL = 'https://verso.localhost';

export function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === APP_URL && !url.username && !url.password;
  } catch { return false; }
}

// Keep long-lived translation streams out of Chromium's six-connection HTTP pool.
// This transport only forwards validated app URLs to the private loopback backend.
export function createProtocolHandler({ origin, token, fetch: fetchRequest = globalThis.fetch, getCookies }) {
  return async (request) => {
    if (!isAppUrl(request.url)) return new Response('Forbidden', { status: 403 });
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('X-Verso-Desktop-Token', token);
    if (getCookies) {
      const cookies = await getCookies(request.url);
      headers.set('Cookie', cookies.map(({ name, value }) => `${name}=${value}`).join('; '));
    }
    if (headers.has('origin')) headers.set('origin', origin);
    try {
      return await fetchRequest(`${origin}${url.pathname}${url.search}`, {
        method: request.method, headers, body: request.body, duplex: 'half', redirect: 'manual',
        signal: request.signal,
      });
    } catch {
      return new Response('The local reader is unavailable.', { status: 503 });
    }
  };
}
