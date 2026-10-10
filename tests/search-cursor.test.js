import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, encodeSearchCursor, decodeSearchCursor, SEARCH_CURSOR_MAX_LENGTH } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-search-cursor-"));
  // A fake clock that moves 2 s per post keeps the per-member chat flood
  // guard (burst 30, 1 post per 2 s) out of a 200+ message fixture.
  let clock = Date.parse("2026-10-10T00:00:00Z");
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const keys = { owner: ownerKey };
  const keyFor = member => (keys[member] ??= store.issueAccessKey("commons", member));
  const getAs = (member, path) => fetch(origin + path, { headers: { Origin: origin, Authorization: `Bearer ${keyFor(member)}` } });
  const get = path => getAs("owner", path);
  const send = (member, type, data) => (clock += 2000, store.command(keyFor(member), "commons", { id: randomUUID(), type, data }));
  const addHuman = memberId => { send("owner", T.MEMBER_ADDED, { memberId, displayName: `Test ${memberId}`, kind: "human", permissions: [] }); keyFor(memberId); };
  const post = (body, extra = {}) => send(extra.as ?? "owner", T.MESSAGE_POSTED, { messageId: extra.messageId ?? randomUUID(), body, ...(extra.toMemberId ? { toMemberId: extra.toMemberId } : {}) }).event.data.messageId;
  const reply = (body, replyToId, messageId) => send("owner", T.MESSAGE_POSTED, { messageId, body, replyToId, alsoSendToChannel: true }).event.data.messageId;
  return { get, getAs, post, send, keyFor, addHuman, reply };
}

const errorShape = body => ({ code: body.code ?? body.error?.code, message: body.message ?? body.error?.message });

const page = async (get, q, kind, limit, before) => {
  const res = await get(`/api/rooms/commons/search?q=${encodeURIComponent(q)}&kind=${kind}&limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`);
  return { status: res.status, body: await res.json() };
};

test("search cursor reaches every match, newest page first, with no duplicate or skip", async t => {
  const { get, post } = await serve(t);
  const ids = [];
  for (let i = 0; i < 205; i += 1) {
    ids.push(post(`deploy note ${i}`));
    if (i % 50 === 0) post("unrelated chatter");
  }
  const seen = [];
  let before = null;
  let pages = 0;
  do {
    const { status, body } = await page(get, "deploy", "messages", 50, before);
    assert.equal(status, 200);
    assert.equal(body.total, 205, "total is the full count on every page");
    assert.ok(body.messages.length <= 50);
    seen.unshift(...body.messages.map(m => m.id));
    before = body.nextCursor ?? null;
    pages += 1;
    assert.ok(pages < 10, "paging terminates");
  } while (before);
  assert.equal(pages, 5);
  assert.deepEqual(seen, ids, "every match once, in chronological order");
});

test("search cursor is bound to query and kind; bad cursors are 422", async t => {
  const { get, post } = await serve(t);
  for (let i = 0; i < 5; i += 1) post(`alpha beta ${i}`);
  const first = await page(get, "alpha", "messages", 2);
  assert.equal(first.status, 200);
  assert.ok(first.body.nextCursor);
  const cursor = first.body.nextCursor;
  for (const [q, kind, value] of [
    ["beta", "messages", cursor],
    ["alpha", "pinned", cursor],
    ["alpha", "all", cursor],
    ["alpha", "work", cursor],
    ["alpha", "messages", "not-a-cursor!"],
    ["alpha", "messages", Buffer.from(JSON.stringify({ v: 1, q: "alpha", k: "messages", a: first.body.messages[0].id })).toString("base64url")],
    ["alpha", "messages", Buffer.from("{not json").toString("base64url")],
    ["alpha", "messages", "a".repeat(600)],
  ]) {
    const res = await page(get, q, kind, 2, value);
    assert.equal(res.status, 422, `${q}/${kind} -> 422`);
  }
  const last = await page(get, "alpha", "messages", 10);
  assert.equal(last.body.nextCursor, undefined, "no cursor when everything fit");
});

test("kind=all keeps its newest-page shape and offers no cursor", async t => {
  const { get, post } = await serve(t);
  for (let i = 0; i < 4; i += 1) post(`gamma ${i}`);
  const res = await page(get, "gamma", "all", 2);
  assert.equal(res.status, 200);
  assert.equal(res.body.messages.length, 2);
  assert.equal(res.body.total, 4);
  assert.equal(res.body.nextCursor, undefined);
});

test("cursor anchors honor visibility: missing, private, non-matching and deleted anchors get one identical 422", async t => {
  const { getAs, post, send, addHuman } = await serve(t);
  addHuman("alice");
  addHuman("bob");
  send("alice", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "hello from alice" });
  send("bob", T.MESSAGE_POSTED, { messageId: randomUUID(), body: "hello from bob" });
  const privateDm = post("delta private to bob", { toMemberId: "bob" });
  const nonMatching = post("unrelated words");
  for (let i = 0; i < 4; i += 1) post(`delta open ${i}`);
  const deleted = post("delta soon gone");
  send("owner", T.MESSAGE_DELETED, { messageId: deleted, expectedMessageRevision: 0, reason: "test" });
  const asAlice = (q, kind, limit, before) => page((path) => getAs("alice", path), q, kind, limit, before);
  const shapes = [];
  for (const anchor of ["missing-id", privateDm, nonMatching, deleted]) {
    const res = await asAlice("delta", "messages", 2, encodeSearchCursor("delta", "messages", anchor));
    assert.equal(res.status, 422, `anchor ${anchor === privateDm ? "private DM" : anchor} -> 422`);
    shapes.push(errorShape(res.body));
  }
  for (const shape of shapes) assert.deepEqual(shape, shapes[0], "the 422 does not reveal which kind of anchor it was");
  assert.equal(shapes[0].code, "invalid_search_cursor");
  // Bob is a party to the DM, so the same anchor is a real page boundary for him.
  const bob = await page((path) => getAs("bob", path), "delta", "messages", 2, encodeSearchCursor("delta", "messages", privateDm));
  assert.equal(bob.status, 200);
  assert.equal(bob.body.messages.length, 0, "nothing older than the DM matches");
  // Alice never sees the DM in totals or pages.
  const all = await asAlice("delta", "messages", 50);
  assert.equal(all.body.total, 4);
  assert.ok(!all.body.messages.some(m => m.id === privateDm || m.id === deleted));
});

test("an anchor that leaves the result set makes the cursor stale (deleted, redacted by edit, unpinned)", async t => {
  const { get, post, send } = await serve(t);
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push(post(`echo item ${i}`));
  const first = await page(get, "echo", "messages", 2);
  assert.deepEqual(first.body.messages.map(m => m.id), ids.slice(4));
  // Delete the real anchor (the oldest id of the page) through the normal command path.
  send("owner", T.MESSAGE_DELETED, { messageId: ids[4], expectedMessageRevision: 0, reason: "test" });
  const stale = await page(get, "echo", "messages", 2, first.body.nextCursor);
  assert.equal(stale.status, 422);
  assert.equal(errorShape(stale.body).code, "invalid_search_cursor");
  // Restarting the search works and the total drops by one.
  const again = await page(get, "echo", "messages", 2);
  assert.equal(again.body.total, 5);
  assert.deepEqual(again.body.messages.map(m => m.id), [ids[3], ids[5]]);
  // Editing the anchor so it no longer matches also makes the cursor stale.
  send("owner", T.MESSAGE_EDITED, { messageId: ids[3], body: "renamed", expectedMessageRevision: 0 });
  const edited = await page(get, "echo", "messages", 2, again.body.nextCursor);
  assert.equal(edited.status, 422);
});

test("kind=pinned pages every pinned match with no duplicate or skip; unpinning the anchor makes the cursor stale", async t => {
  const { get, post, send } = await serve(t);
  const pinned = [];
  for (let i = 0; i < 9; i += 1) {
    const id = post(`foxtrot ${i}`);
    if (i % 3 !== 1) { send("owner", T.MESSAGE_PINNED, { messageId: id }); pinned.push(id); }
  }
  const seen = [];
  let before = null;
  let pages = 0;
  const cursors = [];
  do {
    const res = await page(get, "foxtrot", "pinned", 2, before);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 6);
    seen.unshift(...res.body.messages.map(m => m.id));
    before = res.body.nextCursor ?? null;
    if (before) cursors.push(before);
    pages += 1;
  } while (before && pages < 10);
  assert.equal(pages, 3);
  assert.deepEqual(seen, pinned);
  // A pinned cursor does not page kind=messages.
  assert.equal((await page(get, "foxtrot", "messages", 2, cursors[0])).status, 422);
  // Unpin the first page's anchor: that cursor is now stale.
  const firstPage = await page(get, "foxtrot", "pinned", 2);
  send("owner", T.MESSAGE_UNPINNED, { messageId: firstPage.body.messages[0].id });
  assert.equal((await page(get, "foxtrot", "pinned", 2, cursors[0])).status, 422);
});

test("cursor encode/decode round-trips at the input bounds and always fits the decoder limit", () => {
  const maxId = "a" + "b:._-9".repeat(22).slice(0, 127);
  assert.equal(maxId.length, 128);
  const queries = [
    "\u{1F600}".repeat(40),            // 80 UTF-16 units, 4 UTF-8 bytes each
    "\u4E2D".repeat(80),               // 80 BMP CJK, 3 bytes each
    "\"\\\u0001".repeat(26) + "\"\\", // quotes, backslashes, control chars
    "\u0130".repeat(80),               // lowercases to 160 units
    "x",
  ];
  for (const raw of queries) {
    assert.ok(raw.length <= 80, "a valid query is at most 80 units");
    const needle = raw.trim().toLowerCase();
    for (const kind of ["messages", "pinned"]) {
      for (const anchor of [maxId, `${maxId}:channel`, `${maxId.slice(0, 120)}:channel`, "m1"]) {
        const cursor = encodeSearchCursor(needle, kind, anchor);
        assert.ok(cursor.length <= SEARCH_CURSOR_MAX_LENGTH, `cursor ${cursor.length} fits`);
        assert.deepEqual(decodeSearchCursor(cursor, needle, kind), { anchor });
      }
    }
  }
});

test("a max-length Unicode query with max-length message ids pages end to end over HTTP", async t => {
  const { get, post } = await serve(t);
  const q = "\u{1F680}\u4E2D".repeat(26) + "\u{1F680}"; // 80 units
  assert.equal(q.length, 80);
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push(post(`${q} ${i}`, { messageId: `m${i}` + "z".repeat(126) }));
  const seen = [];
  let before = null;
  do {
    const res = await page(get, q, "messages", 1, before);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    seen.unshift(...res.body.messages.map(m => m.id));
    before = res.body.nextCursor ?? null;
  } while (before && seen.length < 10);
  assert.deepEqual(seen, ids);
});

test("a thread reply sent to the channel with a max-length source id is a valid anchor", async t => {
  const { get, post, reply } = await serve(t);
  const root = post("thread root");
  const older = [post("deploy one"), post("deploy two")];
  const sourceId = "r" + "x".repeat(127);
  assert.equal(sourceId.length, 128);
  reply("deploy from the thread", root, sourceId);
  const first = await page(get, "deploy", "messages", 1);
  assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 200));
  const anchorId = first.body.messages.at(-1).id;
  assert.equal(anchorId, `${sourceId}:channel`, "the newest match is the generated channel copy");
  assert.equal(anchorId.length, 136);
  assert.ok(first.body.nextCursor.length <= SEARCH_CURSOR_MAX_LENGTH);
  const seen = first.body.messages.map(m => m.id);
  let before = first.body.nextCursor;
  while (before) {
    const res = await page(get, "deploy", "messages", 1, before);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    seen.push(...res.body.messages.map(m => m.id));
    before = res.body.nextCursor ?? null;
    assert.ok(seen.length < 10);
  }
  for (const id of older) assert.ok(seen.includes(id), `older match ${id} is reachable`);
  assert.equal(new Set(seen).size, seen.length, "no duplicates");
});

test("a channel-copy shaped anchor still needs a valid source id", () => {
  for (const anchor of [":channel", `${"y".repeat(129)}:channel`, "bad id:channel"]) {
    const cursor = encodeSearchCursor("deploy", "messages", anchor);
    assert.throws(() => decodeSearchCursor(cursor, "deploy", "messages"), err => err.code === "invalid_search_cursor" || err.status === 422 || /invalid_search_cursor/.test(String(err.message) + JSON.stringify(err)));
  }
});
