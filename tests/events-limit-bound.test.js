// REL-10: GET /events with limit=200 gave a 422 that did not say why. The
// 422 keeps its code (invalid_cursor, no contract change, no silent clamp)
// but must name the offending field and its bound, and point the caller at
// next/hasMore or tail for the newest events (tail allows 1..200, /events
// limit caps at 100).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-events-limit-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.parse("2026-10-07T12:00:00Z") });
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ownerKey };
}

function cursorError(store, ownerKey, after, limit) {
  try {
    store.eventsAfter(ownerKey, "commons", after, limit);
  } catch (err) {
    return err;
  }
  assert.fail(`expected eventsAfter(after=${after}, limit=${limit}) to throw`);
}

test("limit above 100 is a 422 that names the field and the bound", t => {
  const { store, ownerKey } = fixture(t);
  const err = cursorError(store, ownerKey, 0, 200);
  assert.equal(err.status, 422);
  assert.equal(err.code, "invalid_cursor");
  assert.match(err.message, /limit/, "names the offending field");
  assert.match(err.message, /100/, "names the bound");
});

test("limit below 1 is a 422 naming the field", t => {
  const { store, ownerKey } = fixture(t);
  const err = cursorError(store, ownerKey, 0, 0);
  assert.equal(err.status, 422);
  assert.equal(err.code, "invalid_cursor");
  assert.match(err.message, /limit/);
});

test("the 422 message points at next/hasMore or tail", t => {
  const { store, ownerKey } = fixture(t);
  const err = cursorError(store, ownerKey, 0, 200);
  assert.ok(/next|hasMore|tail/.test(err.message), `message points onward, got: ${err.message}`);
});

test("a negative after is a 422 naming the field", t => {
  const { store, ownerKey } = fixture(t);
  const err = cursorError(store, ownerKey, -1, 100);
  assert.equal(err.status, 422);
  assert.equal(err.code, "invalid_cursor");
  assert.match(err.message, /after/);
});
