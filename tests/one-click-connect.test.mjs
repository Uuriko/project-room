import test from 'node:test';
import assert from 'node:assert/strict';
import { oneClickEnabled, oneClickInstalls, oneClickSectionHtml, ONE_LINE_PROMPT } from '../server/one-click-connect.mjs';
import { downloadPageHtml } from '../server/download-page.mjs';

test('flag is off by default and only "1" turns it on', () => {
  assert.equal(oneClickEnabled({}), false);
  assert.equal(oneClickEnabled({ ROOM_ONE_CLICK_CONNECT: 'true' }), false);
  assert.equal(oneClickEnabled({ ROOM_ONE_CLICK_CONNECT: '1' }), true);
  assert.doesNotMatch(downloadPageHtml({ oneClick: false }), /id="one-click"/);
});

test('install links are OAuth-only: hosted URL, no header, no secret', () => {
  const byId = Object.fromEntries(oneClickInstalls().map(i => [i.id, i.value]));
  const cursorCfg = JSON.parse(Buffer.from(new URL(byId.cursor).searchParams.get('config'), 'base64').toString());
  assert.deepEqual(cursorCfg, { url: 'https://room.trydemigod.com/mcp' });
  assert.ok(byId.cursor.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?name=project-room&'));
  const vs = JSON.parse(decodeURIComponent(byId.vscode.slice('vscode:mcp/install?'.length)));
  assert.deepEqual(vs, { name: 'project-room', type: 'http', url: 'https://room.trydemigod.com/mcp' });
  assert.equal(byId['claude-code'], 'claude mcp add --transport http project-room https://room.trydemigod.com/mcp && claude mcp login project-room');
  assert.equal(byId.codex, 'codex mcp add project-room --url https://room.trydemigod.com/mcp && codex mcp login project-room');
  const claude = new URL(byId['claude-ai']);
  assert.equal(claude.origin + claude.pathname, 'https://claude.ai/customize/connectors');
  assert.equal(claude.searchParams.get('modal'), 'add-custom-connector');
  assert.equal(claude.searchParams.get('connectorUrl'), 'https://room.trydemigod.com/mcp');
  for (const v of Object.values(byId)) assert.doesNotMatch(v, /Authorization|PROJECT_ROOM_SECRET|Bearer/);
});

test('one line, two steps, rendered first on /download when on', () => {
  assert.equal(ONE_LINE_PROMPT.split(/(?<=\.)\s/).length, 1);
  assert.match(ONE_LINE_PROMPT, /https:\/\/room\.trydemigod\.com\/mcp/);
  const html = downloadPageHtml({ oneClick: true });
  assert.ok(html.indexOf('id="one-click"') > 0 && html.indexOf('id="one-click"') < html.indexOf('id="connect"'));
  assert.equal((oneClickSectionHtml().match(/<li>/g) || []).length, 8);
  assert.match(html, /href="cursor:\/\/anysphere\.cursor-deeplink/);
  assert.match(html, /href="vscode:mcp\/install\?/);
});

test('hosts can start OAuth: bare initialize gets 401 + resource_metadata, then PRM, AS metadata, DCR and the authorize page', async t => {
  const { RoomStore } = await import('../server/store.mjs');
  const { initialRoom } = await import('../server/bootstrap.mjs');
  const { createRoomServer } = await import('../server/http.mjs');
  const { createHash } = await import('node:crypto');
  const origin = 'https://room.example', cb = 'https://client.example/callback';
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  const server = createRoomServer({ store, origin, mcpOAuthClients: [{ clientId: 'one-click-test', name: 'Host', redirectUris: [cb] }] });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { request } = await import('node:http');
  const go = (path, init = {}) => new Promise((resolve, reject) => {
    const req = request(base + path, { method: init.method || 'GET', headers: { Host: 'room.example', ...(init.headers || {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: { get: k => res.headers[k.toLowerCase()] ?? null }, text, json: async () => JSON.parse(text) }); });
    });
    req.on('error', reject); req.end(init.body);
  });
  const init = await go('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'host', version: '1' } } }) });
  assert.equal(init.status, 401);
  const prmUrl = /resource_metadata="([^"]+)"/.exec(init.headers.get('www-authenticate'))?.[1];
  assert.equal(prmUrl, `${origin}/.well-known/oauth-protected-resource/mcp`);
  const prm = await (await go(new URL(prmUrl).pathname)).json();
  assert.equal(prm.resource, `${origin}/mcp`); assert.deepEqual(prm.authorization_servers, [origin]);
  const as = await (await go('/.well-known/oauth-authorization-server')).json();
  assert.ok(as.registration_endpoint && as.authorization_endpoint && as.code_challenge_methods_supported.includes('S256'));
  const reg = await go(new URL(as.registration_endpoint).pathname, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Host', redirect_uris: [cb], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  assert.equal(reg.status, 201); const { client_id } = await reg.json();
  const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: cb, scope: 'rooms:read chat:read chat:write work:read', state: 's',
    code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), code_challenge_method: 'S256', resource: prm.resource });
  const auth = await go(new URL(as.authorization_endpoint).pathname + '?' + q);
  assert.equal(auth.status, 200);
  assert.match(auth.text, /<title>Connect to Project Room<\/title>/);
});
