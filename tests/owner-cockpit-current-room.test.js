// Owner inbox opened from inside a room: that room's items come first,
// nothing is dropped, totals stay the server's, and the server order holds
// within each group.
import test from "node:test";
import assert from "node:assert/strict";
import { currentRoomFirst, withCurrentRoomFirst, perRoomAttention, attentionBadgeCount } from "../src/owner-cockpit.js";

const doc = () => ({
  decisions: { total: 5, waiting: 5, items: [
    { id: "a1", roomId: "alpha", roomName: "Alpha" }, { id: "b1", roomId: "beta", roomName: "Beta" },
    { id: "a2", roomId: "alpha", roomName: "Alpha" }, { id: "b2", roomId: "beta", roomName: "Beta" },
    { id: "c1", roomId: "gamma", roomName: "Gamma" }] },
  exceptions: { total: 2, items: [{ id: "x1", roomId: "alpha", severity: "warn" }, { id: "x2", roomId: "beta", severity: "warn" }] },
  rooms: { label: "3 rooms" },
});

test("the current room's decisions and exceptions come first, stable, nothing hidden", () => {
  const sorted = withCurrentRoomFirst(doc(), "beta");
  assert.deepEqual(sorted.decisions.items.map(item => item.id), ["b1", "b2", "a1", "a2", "c1"]);
  assert.deepEqual(sorted.exceptions.items.map(item => item.id), ["x2", "x1"]);
  assert.equal(sorted.decisions.total, 5);
  assert.equal(attentionBadgeCount(sorted), 5);
  assert.deepEqual(perRoomAttention(sorted).map(line => [line.roomId, line.count]), [["beta", 2], ["alpha", 2], ["gamma", 1]]);
});

test("no current room, or one with no items, keeps the server order", () => {
  const original = doc();
  assert.deepEqual(withCurrentRoomFirst(original, null).decisions.items.map(item => item.id), ["a1", "b1", "a2", "b2", "c1"]);
  assert.deepEqual(withCurrentRoomFirst(original, "delta").decisions.items.map(item => item.id), ["a1", "b1", "a2", "b2", "c1"]);
  assert.deepEqual(currentRoomFirst(original.decisions.items, "alpha").map(item => item.id), ["a1", "a2", "b1", "b2", "c1"]);
  assert.deepEqual(original.decisions.items.map(item => item.id), ["a1", "b1", "a2", "b2", "c1"], "input is not mutated");
});

test("the app wires the open room into the owner inbox", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /createOwnerCockpit\(\{[\s\S]{0,600}currentRoomId: \(\) => state\?\.room\?\.id \?\? null \}\)/);
});
