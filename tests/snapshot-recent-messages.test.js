// `GET /api/rooms/{id}?messages=recent`: a room snapshot without the whole
// message history. A busy room's full snapshot ships every message on each
// open (muse-room: 5,300+ messages, ~5 MB). The recent view keeps the newest
// 100 visible messages, never counts hidden DMs, says how many it left out,
// and the first /conversation page lines up with it so older history pages
// from there. The default snapshot is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const WINDOW = 100;

async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path = "", key = f.keys.producer, headers = {}) => fetch(`${origin}/api/rooms/commons${path}`, { headers: { Authorization: `Bearer ${key}`, ...headers } });
  const post = (key, body, extra = {}) => f.store.command(key, "commons", { id: randomUUID(), type: "message.posted",
    data: { messageId: randomUUID(), body, ...extra } });
  return { ...f, get, post };
}

test("the recent snapshot carries only the newest 100 visible messages and counts the rest", async t => {
  const f = await fixture(t);
  // Seeding history, not live chat: lift the per-member post budget.
  f.store.roomFlood = { consume() {} };
  for (let i = 0; i < 130; i++) {
    f.post(f.keys.producer, `public ${i}`);
    // A DM between two other members: hidden from the producer, never in its window.
    if (i % 10 === 0) f.post(f.keys.owner, `private ${i}`, { toMemberId: "reviewer" });
  }
  const full = await (await f.get()).json();
  const visible = full.state.messages;
  assert.ok(visible.length > WINDOW + 20, "the full snapshot still carries every visible message");
  assert.equal(visible.some(message => message.body.startsWith("private")), false);
  assert.equal(Object.hasOwn(full, "messagesWindow"), false, "the default snapshot is unchanged");

  const response = await f.get("?messages=recent");
  assert.equal(response.status, 200);
  const recent = await response.json();
  assert.equal(recent.state.messages.length, WINDOW);
  assert.deepEqual(recent.state.messages.map(message => message.id), visible.slice(-WINDOW).map(message => message.id),
    "the window is the newest visible messages, in order");
  assert.equal(recent.state.messages.at(-1).body, "public 129");
  assert.deepEqual(recent.messagesWindow, { mode: "recent", limit: WINDOW, omitted: visible.length - WINDOW, older: "conversation" });
  assert.equal(recent.sequence, full.sequence, "same head: live sync continues from it");
  assert.deepEqual(recent.state.workItems, full.state.workItems, "everything but messages is the full snapshot");
  assert.deepEqual(recent.state.members, full.state.members);
  assert.ok(JSON.stringify(recent).length < JSON.stringify(full).length);

  const page = await (await f.get(`/conversation?limit=${WINDOW}`)).json();
  assert.deepEqual(page.messages.map(message => message.id), recent.state.messages.map(message => message.id),
    "the first conversation page is the window, so older history pages from its cursor");
  assert.equal(typeof page.nextCursor, "string");
  const older = await (await f.get(`/conversation?limit=${WINDOW}&cursor=${encodeURIComponent(page.nextCursor)}`)).json();
  assert.deepEqual(older.messages.map(message => message.id), visible.slice(-2 * WINDOW, -WINDOW).map(message => message.id));
});

test("a small room's recent snapshot is the whole history with nothing omitted", async t => {
  const f = await fixture(t);
  f.post(f.keys.producer, "hello");
  const full = await (await f.get()).json(), recent = await (await f.get("?messages=recent")).json();
  assert.deepEqual(recent.state.messages, full.state.messages);
  assert.equal(recent.messagesWindow.omitted, 0);
});

test("the recent selector is strict", async t => {
  const f = await fixture(t);
  for (const query of ["?messages=", "?messages=all", "?messages=recent&messages=recent", "?messages=recent&view=work", "?messages=recent&limit=5"]) {
    const response = await f.get(query);
    assert.equal(response.status, 422, query);
    assert.equal((await response.json()).error.code, "invalid_snapshot_view", query);
  }
  assert.equal((await f.get("?messages=recent", "not-a-key")).status, 401);
});

test("negotiated chat activity avoids duplicate message bodies while preserving decisions and work", async t => {
  const f = await fixture(t); f.store.roomFlood = { consume() {} };
  for (let i = 0; i < 30; i++) f.post(f.keys.producer, `Shared message ${i}: ${'content '.repeat(250)}`);
  const source = f.post(f.keys.owner, 'Keep the pilot invitation only.').event.data.messageId;
  f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'decision.recorded', data: { sourceMessageId: source, statement: 'Invitation-only pilot.' } });
  f.store.command(f.keys.owner, 'commons', { id: randomUUID(), type: 'work.proposed', data: { workItemId: 'lean-work', title: 'Pilot brief', definitionOfDone: 'A usable brief', accountableMemberId: 'producer', verifierMemberId: 'reviewer', humanDecisionMakerId: 'owner' } });
  const full = await (await f.get('?messages=recent')).json();
  const lean = await (await f.get('?messages=recent', f.keys.producer, { 'X-Project-Room-Audit-View': 'activity-v1' })).json();
  assert.equal(lean.auditView, 'activity'); assert.equal(lean.auditVersion, 1);
  assert.deepEqual(lean.state.messages, full.state.messages);
  assert.deepEqual(lean.state.workItems, full.state.workItems);
  assert.deepEqual(lean.state.eventLog, full.state.eventLog.filter(e => e.type === 'decision.recorded' || e.data?.workItemId !== undefined));
  assert.equal(lean.sequence, full.sequence); assert.equal(lean.cursor, full.cursor);
  assert.ok(Buffer.byteLength(JSON.stringify(lean)) < Buffer.byteLength(JSON.stringify(full)) * .7, 'fixture payload drops substantially without losing projected messages');
  const fullBody = JSON.stringify(full), leanBody = JSON.stringify(lean);
  t.diagnostic(JSON.stringify({ workload: '30 seeded messages plus decision/work activity', fullBytes: Buffer.byteLength(fullBody), activityBytes: Buffer.byteLength(leanBody), fullGzipBytes: gzipSync(fullBody).length, activityGzipBytes: gzipSync(leanBody).length }));
  assert.equal(Object.hasOwn(full, 'auditView'), false, 'legacy response remains unchanged');
  const restored = await (await f.get('?messages=recent')).json();
  assert.deepEqual(restored.state.eventLog, full.state.eventLog, 'full Record read remains available');
});

test("activity negotiation preserves private-message filtering and rejects invalid versions", async t => {
  const f = await fixture(t);
  f.post(f.keys.owner, 'Private for reviewer', { toMemberId: 'reviewer' });
  for (const key of [f.keys.owner, f.keys.producer, f.keys.reviewer]) {
    const full = await (await f.get('?messages=recent', key)).json();
    const lean = await (await f.get('?messages=recent', key, { 'X-Project-Room-Audit-View': 'activity-v1' })).json();
    assert.deepEqual(lean.state.messages, full.state.messages);
    assert.deepEqual(lean.state.pins, full.state.pins);
  }
  for (const [path, value] of [['', ''], ['', 'activity-v2'], ['?view=work', 'activity-v1']])
    assert.equal((await f.get(path, f.keys.owner, { 'X-Project-Room-Audit-View': value })).status, 422);
  assert.equal((await f.get('', 'revoked-or-invalid', { 'X-Project-Room-Audit-View': 'activity-v1' })).status, 401);
});
