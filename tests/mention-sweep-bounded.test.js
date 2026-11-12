// #6164 residual: the sweep's overdue-mention queries must be ordered by an
// index (no temp B-tree that walks every tied row), and a wake send that never
// reached its durable journal must not stay "sent" in the coalescer.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { WakeCoalescer } from "../server/wake-adapters.mjs";

test("overdue-mention queries are index-ordered: no temp B-tree for the room sweep or the per-room batch", () => {
  const store = new RoomStore(":memory:");
  const db = store.db;
  const plan = (sql, ...params) => db.prepare("EXPLAIN QUERY PLAN " + sql).all(...params).map(row => row.detail).join(" | ");
  const sweep = plan(`SELECT room_id AS roomId FROM mention_states WHERE state='delivered' AND timeout_at<=? ORDER BY timeout_at LIMIT ?`, 1, 100);
  const batch = plan(`SELECT message_event_id AS eventId, mentioned_member_id AS memberId FROM mention_states
    WHERE room_id=? AND state='delivered' AND timeout_at<=? ORDER BY timeout_at, message_event_id, mentioned_member_id LIMIT ?`, "r", 1, 50);
  assert.match(sweep, /mention_states_due/); assert.doesNotMatch(sweep, /TEMP B-TREE/);
  assert.match(batch, /mention_states_room_due/); assert.doesNotMatch(batch, /TEMP B-TREE/);
  store.close();
});

test("the SQL the store really runs stays on those plans", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../server/store.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("WHERE state='delivered' AND timeout_at<=? ORDER BY timeout_at LIMIT ?"), "room sweep selects by timeout_at only");
  assert.ok(source.includes("WHERE room_id=? AND state='delivered' AND timeout_at<=? ORDER BY timeout_at, message_event_id, mentioned_member_id LIMIT ?"), "per-room batch order matches mention_states_room_due");
});

test("a retracted send is not coalesced into: the retry becomes a fresh send", () => {
  let now = 1000;
  const c = new WakeCoalescer(() => now);
  const first = c.offer("a", { roomId: "r", signalId: "s1" });
  assert.equal(first.send, true);
  assert.equal(c.retract("a", "r", "s1"), true);
  now += 1000;
  assert.equal(c.offer("a", { roomId: "r", signalId: "s1" }).send, true, "journal never written, so the retry sends");
  // Without a retract the same retry is coalesced (the pre-existing, intended behaviour).
  now += 1000;
  assert.equal(c.offer("a", { roomId: "r", signalId: "s1" }).send, false);
  // A stale retract (a newer send owns the entry) is a no-op.
  now += 60000;
  assert.equal(c.offer("a", { roomId: "r", signalId: "s2" }).send, true);
  assert.equal(c.retract("a", "r", "s1"), false);
  assert.equal(c.offer("a", { roomId: "r", signalId: "s3" }).send, false);
  // Retracting a send that replaced an older window restores the older entry.
  now += 60000;
  assert.equal(c.offer("a", { roomId: "r", signalId: "s4" }).send, true);
  assert.equal(c.retract("a", "r", "s4"), true);
  assert.notEqual(c.status("a", "r"), "idle", "the older generation is back");
});
