// The unsubscribe link built by signUnsubscribe must land on a real route:
// GET confirms without opting out (link scanners), POST with a valid signed
// token records the opt-out, and a forged or missing token changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { RoomStore } from '../server/store.mjs';
import { createRoomServer } from '../server/http.mjs';
import { signUnsubscribe } from '../server/notify-email.mjs';
import { isEmailOptedOut } from '../server/email-unsubscribe.mjs';

const SECRET = 'unsubscribe-test-secret-0123456789';

async function boot(t, unsubscribeSecret = SECRET) {
  const store = new RoomStore(':memory:');
  const server = createRoomServer({ store, unsubscribeSecret });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, base };
}
const link = (memberId, scope = 'global') => new URL(signUnsubscribe({ memberId, scope, secret: SECRET, baseUrl: 'https://room.example' }).url);

test('GET shows a confirm form and records nothing', async t => {
  const { store, base } = await boot(t);
  const u = link('m1');
  const res = await fetch(base + u.pathname + u.search);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<form method="post"/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(isEmailOptedOut(store.db, 'm1'), false);
});

test('one-click POST with a valid token records a global opt-out', async t => {
  const { store, base } = await boot(t);
  const u = link('m1');
  const res = await fetch(base + u.pathname + u.search, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.status, 200);
  assert.equal(isEmailOptedOut(store.db, 'm1'), true);
  assert.equal(isEmailOptedOut(store.db, 'm2'), false);
  const again = await fetch(base + u.pathname + u.search, { method: 'POST' });
  assert.equal(again.status, 200);
});

test('a room-scoped token opts out of that room only', async t => {
  const { store, base } = await boot(t);
  const u = link('m1', 'room:alpha');
  await fetch(base + u.pathname + u.search, { method: 'POST' });
  assert.equal(isEmailOptedOut(store.db, 'm1', 'alpha'), true);
  assert.equal(isEmailOptedOut(store.db, 'm1', 'beta'), false);
  assert.equal(isEmailOptedOut(store.db, 'm1'), false);
});

test('forged, tampered or missing tokens are refused and record nothing', async t => {
  const { store, base } = await boot(t);
  const good = link('m1').searchParams.get('u');
  const [v, payload, sig] = good.split('.');
  const other = Buffer.from(JSON.stringify({ m: 'victim', s: 'global', t: 1 })).toString('base64url');
  for (const token of ['', 'v1.x.y', `${v}.${other}.${sig}`, `${v}.${payload}.${sig.slice(0, -2)}AA`]) {
    const res = await fetch(`${base}/unsubscribe?u=${encodeURIComponent(token)}`, { method: 'POST' });
    assert.equal(res.status, 400);
  }
  assert.equal(isEmailOptedOut(store.db, 'victim'), false);
  assert.equal(isEmailOptedOut(store.db, 'm1'), false);
});

test('without a configured secret the route answers 503, and other methods 405', async t => {
  const { base } = await boot(t, null);
  assert.equal((await fetch(`${base}/unsubscribe?u=x`, { method: 'POST' })).status, 503);
  const { base: b2 } = await boot(t);
  const res = await fetch(`${b2}/unsubscribe`, { method: 'DELETE' });
  assert.equal(res.status, 405);
});
