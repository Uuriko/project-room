import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { event } from "../src/events.js";
import { runAnalyticsTail } from "../server/analytics/tail.mjs";

const COUNT = 20_000;
const AT = "2026-09-30T15:00:00.000Z";

test("a short budget stops after one batch and later runs finish without skipping", async t => {
  const dir = mkdtempSync(join(tmpdir(), "analytics-budget-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize([event({
    id: "bulk-created", type: "room.created", actorId: "owner", roomId: "bulkwrk", at: AT,
    data: { roomId: "bulkwrk", ownerId: "owner", title: "Bulk", purpose: "load", kind: "personal" }
  })]);
  store.db.exec("BEGIN");
  store.db.prepare("DELETE FROM events WHERE room_id='bulkwrk'").run();
  const insert = store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES(?,?,?,?)");
  for (let i = 1; i <= COUNT; i += 1) {
    const id = `bulk-${i}`;
    insert.run("bulkwrk", i, id, JSON.stringify({
      id, type: "work_claim.updated", actorId: "owner", roomId: "bulkwrk", at: AT,
      data: { workClaim: `c${i}`, action: "created", claimState: "unclaimed", ownerId: null, leaseExpiresAt: null, title: "t", paths: [] }
    }));
  }
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id='bulkwrk'").run(COUNT);
  store.db.exec("COMMIT");

  const partial = await runAnalyticsTail(store.db, { budgetMs: 0, batch: 500, now: Date.parse(AT) });
  assert.equal(partial.budgetHit, true);
  assert.equal(partial.rowsWritten, 500);
  assert.equal(store.db.prepare("SELECT last_seq FROM analytics_room_cursor WHERE room_id='bulkwrk'").get().last_seq, 500);

  let guard = 0;
  let done = false;
  while (!done && guard < 100) {
    const next = await runAnalyticsTail(store.db, { budgetMs: 60_000, batch: 500, now: Date.parse(AT) });
    done = next.done === true && next.budgetHit === false;
    guard += 1;
  }
  assert.equal(done, true);
  const stored = store.db.prepare("SELECT room_event_id, room_seq FROM analytics_events ORDER BY room_seq").all();
  assert.equal(stored.length, COUNT);
  assert.equal(new Set(stored.map(row => row.room_event_id)).size, COUNT);
  assert.equal(stored[0].room_seq, 1);
  assert.equal(stored.at(-1).room_seq, COUNT);
  const replay = await runAnalyticsTail(store.db, { budgetMs: 60_000, batch: 500, now: Date.parse(AT) });
  assert.equal(replay.rowsWritten, 0);
});
