// WAVE-400 index audit: workItemHistory scanned every event row of the room,
// filtering json $.data.workItemId per row (32.5ms median on a 10k-event
// room). The events_workitem_id expression index turns it into an ordered
// range scan (~0.08ms). This test pins the index's presence and the plan.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

test("work-item history reads use an ordered index, not a room-wide scan", t => {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "room-workitem-index-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons", "owner"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  const index = store.db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='index' AND name='events_workitem_id'"
  ).get();
  assert.ok(index, "events_workitem_id expression index is created at store init");

  const plan = store.db.prepare(
    `EXPLAIN QUERY PLAN SELECT body FROM events
     WHERE room_id=? AND json_extract(body,'$.data.workItemId')=? ORDER BY sequence`
  ).all().map(row => row.detail).join(" | ");
  assert.match(plan, /events_workitem_id/, `planner uses the index, got: ${plan}`);
  assert.doesNotMatch(plan, /TEMP B-TREE/, `index yields sequence order without a sort, got: ${plan}`);
});
