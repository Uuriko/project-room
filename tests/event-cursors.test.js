// WAVE-500 W12: cursor survival across compaction/rotation.
// Fail-first: every test below must fail before server/event-cursors.mjs
// exists and pass after. Pure functions only — no DB, no store coupling.
//
// The enumeration of sequence consumers this design answers (grep of
// server/ on this branch, 2026-10-08):
//   1. SSE stream — server/http.mjs:849 stream(): pumps
//      store.eventsAfter(token, roomId, cursor, 100, binding) and writes
//      `id: ${item.sequence}` per frame (http.mjs:882). Resume is via
//      Last-Event-ID or ?after= at http.mjs:4853
//      (Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0)).
//   2. GET /api/rooms/:roomId/events — http.mjs:4832:
//      store.eventsAfter(token, roomId, Number(params.get("after") || 0), ...)
//      with the published next/hasMore paging contract (tests/
//      events-cursor-paging.test.js); afterSequence explicitly refused at
//      http.mjs:4821-4824.
//   3. store.eventsAfter itself — server/store.mjs:4309: validates `after` as
//      a safe non-negative integer, 409s cursor_ahead when after > sequence,
//      pages `WHERE room_id=? AND sequence>?`. The single choke point every
//      reader funnels through.
//   4. Export route — http.mjs:4161-4210: walks the log and RENUMBERS the
//      visible walk densely (importEvents demands dense line.sequence ===
//      i + 1), so export sequences are per-viewer and must never be fed back
//      as `after` — a cursor-translation hazard the epoch design sidesteps.
//   5. MCP readers — server/mcp-room-profile.mjs:528 (room_list_events,
//      args.after ?? 0) and server/mcp-full-profile.mjs:96,230
//      (eventsAfter(secret, roomId, cursor, pageLimit)).
//   6. Updates tail walk — server/updates.mjs:657
//      (store.eventsAfter(token, roomId, after, ...)) plus the documented
//      `next` link at updates.mjs:212 (`/events?after=0`).
//   7. /api/needs-me `since` — http.mjs:3129-3139 already accepts a sequence
//      number OR a cursor object, the closest thing today to a compound
//      cursor (parsed in server/needs-me.mjs:404 parseNeedsMeSince).
//   8. Route-table docs — server/routes/table.mjs:81,96
//      (`/api/rooms/{roomId}/events?after=0&limit=100`,
//      `/api/rooms/{roomId}/stream?after=0`).
//   9. Existing tests — tests/events-after-sequence.test.js,
//      tests/events-cursor-paging.test.js (plus many tests that page with
//      after=0); none know about epochs, all stay green because epoch 0
//      encodes as a bare integer.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeCursor, decodeCursor, compareCursors } from "../server/event-cursors.mjs";

test("legacy bare-integer cursor decodes to epoch 0", () => {
  assert.deepEqual(decodeCursor("123"), { epoch: 0, seq: 123 });
  assert.deepEqual(decodeCursor("0"), { epoch: 0, seq: 0 });
  assert.deepEqual(decodeCursor("1000000"), { epoch: 0, seq: 1000000 });
});

test("epoch-0 cursors encode as bare integers (byte-identical to today)", () => {
  assert.equal(encodeCursor({ epoch: 0, seq: 123 }), "123");
  assert.equal(encodeCursor({ epoch: 0, seq: 0 }), "0");
});

test("non-zero epochs encode as e<epoch>:<seq> and round-trip", () => {
  assert.equal(encodeCursor({ epoch: 2, seq: 45 }), "e2:45");
  for (const cursor of [{ epoch: 0, seq: 7 }, { epoch: 1, seq: 0 }, { epoch: 3, seq: 999999 }, { epoch: 41, seq: 1 }]) {
    assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  }
});

test("ordering: epoch dominates, then sequence", () => {
  const cmp = (a, b) => compareCursors(decodeCursor(a), decodeCursor(b));
  assert.equal(cmp("5", "9"), -1);
  assert.equal(cmp("9", "5"), 1);
  assert.equal(cmp("5", "5"), 0);
  // Any later-epoch cursor is after any earlier-epoch one, whatever the seqs.
  assert.equal(cmp("e1:0", "999999"), 1);
  assert.equal(cmp("999999", "e1:0"), -1);
  assert.equal(cmp("e1:3", "e2:1"), -1);
  assert.equal(cmp("e2:1", "e1:3"), 1);
  assert.equal(cmp("e2:1", "e2:1"), 0);
});

test("compareCursors also accepts raw {epoch, seq} objects", () => {
  assert.equal(compareCursors({ epoch: 0, seq: 4 }, { epoch: 0, seq: 4 }), 0);
  assert.equal(compareCursors("e1:0", { epoch: 0, seq: 999999 }), 1);
  assert.equal(compareCursors({ epoch: 1, seq: 0 }, "e0:5"), 1);
});

test("malformed cursors are rejected, never coerced", () => {
  for (const bad of [
    "", " ", "abc", "e", "e1", "e:5", ":5", "1:2", "e1:2:3",
    "-1", "+5", "1.5", "e-1:2", "e1:-2", " 5", "5 ", "e1:2 ",
    "E1:2", "0x10", "1e3", "NaN", "Infinity",
    "e9007199254740993:1", // epoch above Number.MAX_SAFE_INTEGER
    "e1:9007199254740993", // seq above Number.MAX_SAFE_INTEGER
  ]) {
    assert.throws(() => decodeCursor(bad), /invalid_cursor/, `expected rejection: ${JSON.stringify(bad)}`);
  }
  for (const bad of [null, undefined, 123, {}, [], true]) {
    assert.throws(() => decodeCursor(bad), /invalid_cursor/);
  }
  assert.throws(() => encodeCursor({ epoch: -1, seq: 5 }), /invalid_cursor/);
  assert.throws(() => encodeCursor({ epoch: 0, seq: 1.5 }), /invalid_cursor/);
  assert.throws(() => encodeCursor({ epoch: "1", seq: 5 }), /invalid_cursor/);
  assert.throws(() => encodeCursor(null), /invalid_cursor/);
  assert.throws(() => compareCursors("garbage", "5"), /invalid_cursor/);
});
