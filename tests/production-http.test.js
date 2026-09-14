import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { openJoinContract } from '../server/open-contract.mjs';
import { readFileSync } from 'node:fs';

test('GET /api/open and /api/version on the real HTTP server', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'prod-http-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  store.initialize(initialRoom('commons'));
  const server = createRoomServer({ store });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(r => server.close(r));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const open = await (await fetch(origin + '/api/open')).json();
  assert.equal(open.ship, false);
  assert.equal(open.persistence, 'none');
  assert.equal(openJoinContract().ship, false);
  const version = await (await fetch(origin + '/api/version')).json();
  assert.equal(version.status, 'ok');
  assert.equal(typeof version.sourceRevision, 'string');
  assert.ok(version.sourceRevision.length > 0);
  const head = await fetch(origin + '/api/open', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const ready = await (await fetch(origin + '/api/ready')).json();
  assert.equal(ready.status, 'ready');
  const card = await (await fetch(origin + '/.well-known/mcp.json')).json();
  assert.equal(card.ship, false);
  assert.equal((await fetch(origin + '/mcp.json')).status, 200);
  const mcpHead = await fetch(origin + '/.well-known/mcp.json', { method: 'HEAD' });
  assert.equal(mcpHead.status, 200);
  assert.equal(await mcpHead.text(), '');
  const emptyDir = mkdtempSync(join(tmpdir(), 'prod-http-empty-'));
  const emptyStore = new RoomStore(join(emptyDir, 'room.sqlite'));
  const emptyServer = createRoomServer({ store: emptyStore, serviceMode: 'cloudflare-staging' });
  await new Promise(r => emptyServer.listen(0, '127.0.0.1', r));
  t.after(async () => {
    emptyServer.closeStreams(); emptyServer.closeAllConnections();
    await new Promise(r => emptyServer.close(r));
    emptyStore.close(); rmSync(emptyDir, { recursive: true, force: true });
  });
  const emptyOrigin = `http://127.0.0.1:${emptyServer.address().port}`;
  const emptyOpen = await (await fetch(emptyOrigin + '/api/open')).json();
  assert.equal(emptyOpen.ship, false);
  assert.equal(emptyOpen.persistence, 'none');
  assert.equal((await fetch(emptyOrigin + '/api/ready')).status, 503);
  const staged = await (await fetch(emptyOrigin + '/api/version')).json();
  assert.equal(staged.mode, 'cloudflare-staging');
  const prod = readFileSync(new URL('../cloudflare/wrangler.production.jsonc', import.meta.url), 'utf8');
  assert.match(prod, /ROOM_PRODUCTION": "1"/);
  assert.match(prod, /room\.trydemigod\.com/);
  assert.match(prod, /ROOM_OPERATOR_ACCOUNT_ID/);
  assert.doesNotMatch(prod, /ROOM_CLERK|sk_live|BEGIN PRIVATE KEY|pk_live_/);
});

test('GET /api/auth-config has no identity provider', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'prod-auth-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  const server = createRoomServer({ store });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(r => server.close(r));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = await (await fetch(origin + '/api/auth-config')).json();
  assert.equal(auth.provider, null);
  assert.equal((await (await fetch(origin + '/api/open')).json()).ship, false);
});

test('Room client does not load an identity-provider browser SDK', () => {
  const src = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /clerk\.browser\.js|@clerk\/clerk-js|@clerk\/ui/);
});
