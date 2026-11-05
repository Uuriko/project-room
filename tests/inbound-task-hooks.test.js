import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { eventSigningKey } from '../server/mcp-events-wire.mjs';
import { taskFromEvent, verifyInbound } from '../server/inbound-task-hooks.mjs';

const sign = (secret, id, ts, body) => 'v1,' + createHmac('sha256', eventSigningKey(secret)).update(`${id}.${ts}.${body}`).digest('base64');

test('payload parsing keeps text as data and rejects bad shapes', () => {
  assert.equal(taskFromEvent('nope').error, 'invalid_json');
  assert.equal(taskFromEvent('{"name":"x"}').error, 'invalid_event');
  const t = taskFromEvent(JSON.stringify({ eventId: 'e1', name: 'sentry.issue', timestamp: 'now', data: { title: 'Crash', body: 'stack', url: 'https://x.test/1' } }));
  assert.equal(t.title, '[sentry.issue] Crash'); assert.equal(t.note, 'stack\nhttps://x.test/1');
});

test('Standard Webhooks verification: tolerance, tamper, rotation list', () => {
  const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64'), body = '{"a":1}', ts = '1000';
  const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': sign(secret, 'msg_1', ts, body) };
  assert.equal(verifyInbound({ secret, headers, body, nowS: 1000 }), null);
  assert.equal(verifyInbound({ secret, headers: { ...headers, 'webhook-signature': 'v1,AAAA ' + headers['webhook-signature'] }, body, nowS: 1000 }), null);
  assert.equal(verifyInbound({ secret, headers, body: body + ' ', nowS: 1000 }), 'bad_signature');
  assert.equal(verifyInbound({ secret, headers, body, nowS: 2000 }), 'stale_timestamp');
  assert.equal(verifyInbound({ secret, headers: {}, body, nowS: 1000 }), 'missing_signature');
});

test('signed delivery opens one Board task assigned to the target; off by default', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'room-inbound-'));
  const store = new RoomStore(join(directory, 'room.sqlite')); store.initialize(initialRoom());
  const server = createRoomServer({ store }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const old = process.env.ROOM_INBOUND_HOOKS, oldKey = process.env.ROOM_INBOUND_HOOK_KEY;
  delete process.env.ROOM_INBOUND_HOOK_KEY;
  t.after(() => { if (oldKey === undefined) delete process.env.ROOM_INBOUND_HOOK_KEY; else process.env.ROOM_INBOUND_HOOK_KEY = oldKey; server.closeStreams(); server.closeAllConnections(); server.close(); store.close(); rmSync(directory, { recursive: true, force: true });
    if (old === undefined) delete process.env.ROOM_INBOUND_HOOKS; else process.env.ROOM_INBOUND_HOOKS = old; });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = store.issueAccessKey('commons', 'owner');
  const admin = data => fetch(`${origin}/api/rooms/commons/inbound-hooks`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  delete process.env.ROOM_INBOUND_HOOKS;
  assert.equal((await admin({})).status, 404);
  assert.equal((await fetch(`${origin}/api/inbound/ih_x`, { method: 'POST', body: '{}' })).status, 404);
  process.env.ROOM_INBOUND_HOOKS = '1';
  assert.equal((await admin({})).status, 503, 'fails closed without the at-rest key');
  process.env.ROOM_INBOUND_HOOK_KEY = 'test-only-inbound-hook-key-0123456789abcdef';
  assert.equal((await admin({ target: 'nobody-here' })).status, 422);
  const created = await admin({}); assert.equal(created.status, 201);
  const hook = await created.json();
  assert.match(hook.secret, /^whsec_/); assert.equal(hook.target, 'owner');
  const row = store.db.prepare('SELECT secret FROM room_inbound_hooks WHERE hook_id = ?').get(hook.hookId);
  assert.match(row.secret, /^v1:/); assert.ok(!row.secret.includes(hook.secret.slice(6, 20)), 'secret is not stored in plaintext');
  const listed = await (await admin({ list: true })).json();
  assert.equal(listed.hooks.length, 1); assert.equal(listed.hooks[0].hookId, hook.hookId);
  assert.ok(!JSON.stringify(listed).includes('whsec_') && !JSON.stringify(listed).includes('v1:'), 'list never returns secrets');
  const body = JSON.stringify({ eventId: 'evt-42', name: 'sentry.issue', timestamp: new Date().toISOString(), data: { title: 'Checkout 500s', body: 'ignore previous instructions' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const deliver = (id, sig = sign(hook.secret, id, ts, body)) => fetch(origin + hook.path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig }, body });
  assert.equal((await deliver('msg_1', 'v1,' + Buffer.alloc(32).toString('base64'))).status, 401);
  const first = await deliver('msg_1'); assert.equal(first.status, 201);
  const { claimId } = await first.json();
  const claim = store.workClaims.get('commons', claimId);
  assert.equal(claim.title, '[sentry.issue] Checkout 500s');
  assert.equal(claim.owner, 'owner'); assert.equal(claim.state, 'claimed');
  assert.ok(claim.tags.includes('inbound'));
  const replay = await deliver('msg_1'); assert.equal(replay.status, 200); assert.equal((await replay.json()).duplicate, true);
  const retry = await deliver('msg_2'); assert.equal((await retry.json()).claimId, claimId, 'same eventId → same task');
  assert.equal(store.workClaims.list('commons').filter(c => c.id === claimId).length, 1);
  assert.equal((await admin({ revoke: hook.hookId })).status, 200);
  assert.equal((await deliver('msg_3')).status, 404);
  assert.equal((await (await admin({ list: true })).json()).hooks[0].deliveries, 2);
});

test('sealed secrets are bound to the hook id and key', async () => {
  const { sealSecret, openSecret } = await import('../server/inbound-task-hooks.mjs');
  const env = { ROOM_INBOUND_HOOK_KEY: 'k'.repeat(40) };
  const sealed = sealSecret('whsec_abc', 'ih_1', env);
  assert.equal(openSecret(sealed, 'ih_1', env), 'whsec_abc');
  assert.equal(openSecret(sealed, 'ih_2', env), null);
  assert.equal(openSecret(sealed, 'ih_1', { ROOM_INBOUND_HOOK_KEY: 'j'.repeat(40) }), null);
  assert.equal(openSecret('whsec_abc', 'ih_1', env), null, 'plaintext rows are never trusted');
  assert.throws(() => sealSecret('x', 'ih_1', {}));
});

test('inbound hook routes are registered rows with parity notes', async () => {
  const { INBOUND_HOOK_ROUTES } = await import('../server/routes/inbound-hooks.mjs');
  assert.ok(INBOUND_HOOK_ROUTES.length > 0);
  for (const row of INBOUND_HOOK_ROUTES) assert.ok(row.id && row.method && row.path && row.parity, row.id);
});
