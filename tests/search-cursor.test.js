import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
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
  const get = path => fetch(origin + path, { headers: { Origin: origin, Authorization: `Bearer ${ownerKey}` } });
  const post = body => (clock += 2000, store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body } }).event.data.messageId);
  return { get, post };
}

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
    ["alpha", "messages", Buffer.from(JSON.stringify({ v: 1, q: "alpha", k: "messages", a: "missing-id" })).toString("base64url")],
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
