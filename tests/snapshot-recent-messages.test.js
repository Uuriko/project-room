// The default room document is the newest 50 visible messages plus
// messagesPage { before, hasMore }. Older history is GET /messages?before=<seq>.
// `?messages=recent` stays the newest 100. `?full=1` is the legacy unbounded
// document, and only while ROOM_SNAPSHOT_FULL_COMPAT=1. Hidden DMs never
// count toward a window.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { snapshotFullCompatReads } from "../server/message-page.mjs";

const WINDOW = 100;
const PAGE = 50;

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

test("the default snapshot is the newest 50 visible messages plus a cursor", async t => {
  const f = await fixture(t);
  // Seeding history, not live chat: lift the per-member post budget.
  f.store.roomFlood = { consume() {} };
  for (let i = 0; i < 130; i++) {
    f.post(f.keys.producer, `public ${i}`);
    // A DM between two other members: hidden from the producer, never in its window.
    if (i % 10 === 0) f.post(f.keys.owner, `private ${i}`, { toMemberId: "reviewer" });
  }
  const beforeReads = snapshotFullCompatReads();
  const denied = await f.get("?full=1");
  assert.equal(denied.status, 422);
  assert.equal((await denied.json()).error.code, "invalid_snapshot_view");
  assert.equal(snapshotFullCompatReads(), beforeReads, "a refused full read is not served");

  process.env.ROOM_SNAPSHOT_FULL_COMPAT = "1";
  t.after(() => { delete process.env.ROOM_SNAPSHOT_FULL_COMPAT; });
  const fullResponse = await f.get("?full=1");
  assert.equal(fullResponse.headers.get("deprecation"), "true");
  const full = await fullResponse.json();
  assert.equal(snapshotFullCompatReads(), beforeReads + 1);
  const visible = full.state.messages;
  assert.ok(visible.length > WINDOW + 20, "the compat snapshot still carries every visible message");
  assert.equal(visible.some(message => message.body.startsWith("private")), false);
  assert.equal(Object.hasOwn(full, "messagesWindow"), false);
  assert.equal(Object.hasOwn(full, "messagesPage"), false);

  const response = await f.get();
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.state.messages.length, PAGE);
  assert.deepEqual(page.state.messages.map(message => message.id), visible.slice(-PAGE).map(message => message.id));
  assert.equal(page.state.messages.at(-1).body, "public 129");
  assert.equal(page.messagesPage.hasMore, true);
  assert.equal(typeof page.messagesPage.before, "number");
  assert.equal(page.messagesPage.before < page.sequence, true);
  assert.equal(page.sequence, full.sequence);
  assert.deepEqual(page.state.workItems, full.state.workItems);
  assert.ok(JSON.stringify(page.state.messages).length < JSON.stringify(visible).length);

  const recent = await (await f.get("?messages=recent")).json();
  assert.equal(recent.state.messages.length, WINDOW);
  assert.deepEqual(recent.state.messages.map(message => message.id), visible.slice(-WINDOW).map(message => message.id));
  assert.deepEqual(recent.messagesWindow, { mode: "recent", limit: WINDOW, omitted: visible.length - WINDOW, older: "conversation" });
  assert.equal(recent.messagesPage.hasMore, true);
  assert.equal(typeof recent.messagesPage.before, "number");

  const older = await (await f.get(`/messages?before=${page.messagesPage.before}&limit=${PAGE}`)).json();
  assert.equal(older.messages.length, PAGE);
  assert.deepEqual(older.messages.map(message => message.id), visible.slice(-2 * PAGE, -PAGE).map(message => message.id));
  assert.equal(older.messagesPage.hasMore, true);
  assert.ok(older.messagesPage.before < page.messagesPage.before);
  assert.equal(older.messages.some(message => message.body.startsWith("private")), false);
  const rest = await (await f.get(`/messages?before=${older.messagesPage.before}&limit=100`)).json();
  assert.deepEqual(rest.messages.map(message => message.id), visible.slice(0, visible.length - 2 * PAGE).map(message => message.id));
  assert.equal(rest.messagesPage.hasMore, false);

  const conversation = await (await f.get(`/conversation?limit=${WINDOW}`)).json();
  assert.deepEqual(conversation.messages.map(message => message.id), recent.state.messages.map(message => message.id),
    "the first conversation page is the recent window");
});

test("a small room's default snapshot is the whole history with nothing older", async t => {
  const f = await fixture(t);
  f.post(f.keys.producer, "hello");
  const page = await (await f.get()).json(), recent = await (await f.get("?messages=recent")).json();
  assert.deepEqual(recent.state.messages, page.state.messages);
  assert.equal(recent.messagesWindow.omitted, 0);
  assert.equal(page.messagesPage.hasMore, false);
  assert.equal(typeof page.messagesPage.before, "number");
  const older = await f.get(`/messages?before=${page.messagesPage.before}`);
  assert.equal(older.status, 200);
  assert.deepEqual((await older.json()).messages, []);
});

test("the recent selector is strict", async t => {
  const f = await fixture(t);
  for (const query of ["?messages=", "?messages=all", "?messages=recent&messages=recent", "?messages=recent&view=work", "?messages=recent&limit=5", "?full=1&messages=recent", "?full=", "?full=1&view=work"]) {
    const response = await f.get(query);
    assert.equal(response.status, 422, query);
    assert.equal((await response.json()).error.code, "invalid_snapshot_view", query);
  }
  for (const query of ["/messages?limit=101", "/messages?limit=0", "/messages?before=-1", "/messages?before=nope"]) {
    const response = await f.get(query);
    assert.equal(response.status, 422, query);
    assert.equal((await response.json()).error.code, "invalid_message_page", query);
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


test("recent and full snapshots preserve visible history, counts and older pins after compaction", async t => {
 const f=await fixture(t);f.store.roomFlood={consume(){}};
 const pinned=f.post(f.keys.producer,'An old pinned message.').event.data.messageId;
 f.store.command(f.keys.owner,'commons',{id:randomUUID(),type:'message.pinned',data:{messageId:pinned}});
 for(let i=0;i<115;i++)f.post(f.keys.producer,`Archived public ${i}.`);
 for(let i=0;i<3;i++)f.post(f.keys.owner,'Hidden private message.',{toMemberId:'reviewer'});
 const recent=await(await f.get('?messages=recent')).json(),page=await(await f.get()).json();
 assert.equal(page.state.messages.length,PAGE);
 assert.equal(page.messagesPage.hasMore,true);
 while(!f.store.backfillMessages({limit:1000}).done){}
 assert.equal(f.store.checkMessagesParity().ok,true);
 assert.equal(f.store.archiveMessages('commons',{keepNewest:2,dryRun:false}).ok,true);
 const after=await(await f.get('?messages=recent')).json(),windowed=await(await f.get()).json();
 assert.deepEqual(after.state.messages,recent.state.messages);
 assert.deepEqual(after.messagesWindow,recent.messagesWindow);
 assert.deepEqual(after.messagesPage,recent.messagesPage);
 assert.deepEqual(after.state.pins,recent.state.pins);
 assert.ok(after.state.pins.some(pin=>pin.messageId===pinned));
 assert.deepEqual(windowed.state.messages,page.state.messages);
 assert.equal(windowed.messagesPage.hasMore,true);
 process.env.ROOM_SNAPSHOT_FULL_COMPAT='1';
 t.after(()=>{delete process.env.ROOM_SNAPSHOT_FULL_COMPAT;});
 const all=await(await f.get('?full=1')).json();
 assert.ok(all.state.messages.length>page.state.messages.length);
 assert.equal(JSON.stringify(after).includes('Hidden private message.'),false);
 assert.equal(JSON.stringify(all).includes('Hidden private message.'),false);
});
