import test from "node:test";
import assert from "node:assert/strict";
import { assembleNeedsYou, needsYouLimit } from "../src/needs-you.js";

function item(id, at, kind = "ask") {
  return { id, kind, at, subjectId: id.slice(kind.length + 1), title: id };
}

test("count is the full list and cursors do not overlap", () => {
  const items = [item("ask:c", "2026-10-25T00:00:03.000Z"), item("ask:a", "2026-10-25T00:00:01.000Z"), item("ask:b", "2026-10-25T00:00:02.000Z")];
  const first = assembleNeedsYou({ items, limit: 1 });
  assert.equal(first.count, 3);
  assert.deepEqual(first.items.map(entry => entry.id), ["ask:a"]);
  assert.equal(first.nextCursor, "ask:a");
  const second = assembleNeedsYou({ items, limit: 1, cursor: first.nextCursor });
  assert.equal(second.count, 3);
  assert.deepEqual(second.items.map(entry => entry.id), ["ask:b"]);
  const third = assembleNeedsYou({ items, limit: 1, cursor: second.nextCursor });
  assert.equal(third.nextCursor, null);
  assert.deepEqual(third.items.map(entry => entry.id), ["ask:c"]);
  const seen = new Set([...first.items, ...second.items, ...third.items].map(entry => entry.id));
  assert.equal(seen.size, 3);
});

test("empty inbox and rejected cursors", () => {
  const empty = assembleNeedsYou();
  assert.equal(empty.count, 0);
  assert.deepEqual([...empty.items], []);
  assert.equal(empty.nextCursor, null);
  assert.equal(needsYouLimit(undefined), 20);
  assert.throws(() => assembleNeedsYou({ items: [item("ask:a", "2026-10-25T00:00:01.000Z")], cursor: "ask:missing" }), error => error.code === "invalid_cursor");
  assert.throws(() => needsYouLimit(0), error => error.code === "invalid_cursor" && error.message === "Invalid limit");
  assert.throws(() => needsYouLimit(51), error => error.code === "invalid_cursor");
  assert.throws(() => assembleNeedsYou({ items: [{ id: "ask:a", kind: "nope", at: "2026-10-25T00:00:01.000Z" }] }), error => error.message === "Invalid item");
});
