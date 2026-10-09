import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// FIX-49: the event-log cursor contract, with teeth.
//
// The /events and /stream cursor contract (COLLIDE-5):
//   - a cursor AHEAD of the log head is a hard 409 `cursor_ahead` — the
//     server never silently returns an empty page and never fabricates a
//     page for a cursor that points past the end of history;
//   - a malformed cursor (non-integer/negative `after`, out-of-range
//     `limit`, bad actor filter, bad since/until) is a hard 422
//     `invalid_cursor`;
//   - a valid cursor pages normally: `next` from the previous page goes back
//     in as `after`, `after == sequence` yields an ordinary empty page.
//
// These tests pin the contract at the store level, which is where both the
// HTTP /events route and the /stream resume path bottom out
// (server/http.mjs `stream()` calls store.eventsAfter() first), so the
// guarantee holds for every reader of the log.

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "cursor-contract-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => store.close());
  store.initialize(initialRoom());
  const token = store.issueAccessKey("commons", "owner");
  const send = (type, data) =>
    store.command(token, "commons", { id: randomUUID(), type, data });
  send(T.MEMBER_ADDED, { memberId: "alice", displayName: "alice", kind: "human", permissions: ["steer"] });
  const aliceToken = store.issueAccessKey("commons", "alice");
  send(T.MESSAGE_POSTED, { messageId: "m-1", body: "one" });
  send(T.MESSAGE_POSTED, { messageId: "m-2", body: "two" });
  return { store, token, aliceToken };
}

const codeOf = fn => {
  try { fn(); } catch (error) { return { status: error.status, code: error.code, message: error.message }; }
  return "did-not-throw";
};

test("cursor ahead of the log head is a hard 409 cursor_ahead, never a silent page", t => {
  const { store, token } = fixture(t);
  const head = store.room("commons").sequence;
  assert.ok(head > 0, "fixture should have events");
  const result = codeOf(() => store.eventsAfter(token, "commons", head + 1, 100));
  assert.equal(result.code, "cursor_ahead", `expected cursor_ahead, got ${JSON.stringify(result)}`);
  assert.equal(result.status, 409);
  assert.match(result.message, /fresh snapshot/i);
});

test("cursor_ahead fires even when there are no new events (the teeth: no silent empty)", t => {
  const { store, token } = fixture(t);
  // Read to the very end first: `next == sequence` is a legal, honest empty
  // cursor. One past it is not — it must hard-fail instead of looking like
  // "nothing new".
  const page = store.eventsAfter(token, "commons", 0, 100);
  assert.equal(page.hasMore, false);
  assert.equal(page.next, store.room("commons").sequence);
  const result = codeOf(() => store.eventsAfter(token, "commons", page.next + 1, 100));
  assert.equal(result.code, "cursor_ahead");
  assert.equal(result.status, 409);
});

test("malformed cursors are a hard 422 invalid_cursor", t => {
  const { store, token } = fixture(t);
  const bad = [
    ["negative after", [-1, 100, null, {}]],
    ["fractional after", [1.5, 100, null, {}]],
    ["string after", ["5", 100, null, {}]],
    ["NaN after", [NaN, 100, null, {}]],
    ["limit 0", [0, 0, null, {}]],
    ["limit 101", [0, 101, null, {}]],
    ["negative limit", [0, -5, null, {}]],
    ["empty actor", [0, 100, null, { actor: "" }]],
    ["non-string actor", [0, 100, null, { actor: 42 }]],
    ["bad since", [0, 100, null, { since: "not-a-date" }]],
    ["bad until", [0, 100, null, { until: "also-not-a-date" }]],
  ];
  for (const [name, args] of bad) {
    const result = codeOf(() => store.eventsAfter(token, "commons", ...args));
    assert.equal(result.status, 422, `${name}: expected 422, got ${JSON.stringify(result)}`);
    assert.equal(result.code, "invalid_cursor", `${name}: expected invalid_cursor, got ${JSON.stringify(result)}`);
  }
});

test("a valid cursor pages normally; after == sequence is an honest empty page", t => {
  const { store, token } = fixture(t);
  const first = store.eventsAfter(token, "commons", 0, 1);
  assert.equal(first.events.length, 1);
  assert.ok(first.hasMore, "more events remain");
  const second = store.eventsAfter(token, "commons", first.next, 100);
  assert.ok(second.events.length > 0, "paging forward yields events");
  const tail = store.eventsAfter(token, "commons", store.room("commons").sequence, 100);
  assert.deepEqual(tail.events, []);
  assert.equal(tail.hasMore, false);
  assert.equal(tail.next, store.room("commons").sequence);
});

test("the ahead check runs before any filtering: an ahead cursor fails with filters too", t => {
  const { store, aliceToken } = fixture(t);
  const head = store.room("commons").sequence;
  const result = codeOf(() => store.eventsAfter(aliceToken, "commons", head + 50, 100, null, { actor: "alice" }));
  assert.equal(result.code, "cursor_ahead");
  assert.equal(result.status, 409);
});
