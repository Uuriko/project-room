// One-use, loopback credential capture. No token is printed or placed in a URL.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createTelegramSetup({ file, username, fetchImpl = fetch }) {
  const parent = lstatSync(dirname(file));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) throw new Error('Private directory required');
  const nonce = randomBytes(32).toString('hex');
  let busy = false, saved = false;
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'Referrer-Policy': 'same-origin' }); res.end(body); };
    if (req.headers.host !== new URL(origin).host || req.url !== '/') return reply(403, 'Unavailable');
    if (req.method === 'GET') return reply(200, saved ? 'Saved. You can close this tab.' : `<h1>Project Room</h1><form method="post"><input type="hidden" name="nonce" value="${nonce}"><label>Telegram bot key <input type="password" name="token" autocomplete="off" maxlength="128" required></label><button>Connect</button></form>`);
    if (req.method !== 'POST' || req.headers.origin !== origin || busy || saved) return reply(403, 'Unavailable');
    busy = true;
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1024) throw new Error(); }
      const form = new URLSearchParams(body), token = form.get('token');
      if (form.get('nonce') !== nonce || !/^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(token || '') || token.length > 128) throw new Error();
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000) });
      const reader = response.body.getReader(); let size = 0; const chunks = [];
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16384) { await reader.cancel(); throw new Error(); } chunks.push(value); }
      const info = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok || info.ok !== true || info.result?.is_bot !== true || info.result.username !== username || !Number.isSafeInteger(info.result.id)) throw new Error();
      writeFileSync(file, JSON.stringify({ token, botId: info.result.id, username, challenge: randomBytes(24).toString('hex') }), { mode: 0o600, flag: 'wx' });
      saved = true; reply(200, 'Saved privately. You can close this tab.');
    } catch { reply(400, 'Connection not confirmed. No credentials displayed.'); }
    finally { busy = false; }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createTelegramSetup({ file: process.argv[2], username: 'ProjectRoomDemigodBot' });
  server.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/`));
  setTimeout(() => server.close(), 600000).unref();
}
