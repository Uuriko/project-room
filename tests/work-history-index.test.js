// Work history reads one work item's events through an index rather than
// scanning and JSON-parsing every event in the room.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const HISTORY_SQL = "SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.data.workItemId')=? ORDER BY sequence";

test("work history uses events_room_work and returns the same changes", () => {
  const f = createAcceptanceFixture(); f.store.roomFlood = { consume() {} };
  try {
    f.store.command(f.keys.owner, "commons", { id: "w1", type: "work.proposed", data: { workItemId: "wk-index", title: "Index", definitionOfDone: "Fast", accountableMemberId: "producer", mode: "read" } });
    for (let i = 0; i < 30; i++) f.store.command(f.keys.owner, "commons", { id: `m${i}`, type: "message.posted", data: { messageId: `m${i}`, body: "noise" } });
    const plan = f.store.db.prepare(`EXPLAIN QUERY PLAN ${HISTORY_SQL}`).all("commons", "wk-index").map(row => row.detail).join(" | ");
    assert.match(plan, /events_room_work/);
    assert.doesNotMatch(plan, /TEMP B-TREE/, "sequence order comes from the index");
    const history = f.store.workItemHistory(f.keys.owner, "commons", "wk-index");
    assert.equal(history.changes.length, 1);
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
