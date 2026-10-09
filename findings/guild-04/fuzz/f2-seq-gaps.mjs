// F2: out-of-order / gapped event sequences — replay must refuse, never silently accept.
import assert from "node:assert/strict";
import { join } from "node:path";
import { RoomStore } from "../../server/store.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { fuzz, scratchDir, throwsBounded } from "./lib.mjs";

fuzz("F2-seq-gaps", async () => {
  const dir = scratchDir("g04-f2-");
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const roomId = "commons";
  const n0 = store.db.prepare("SELECT count(*) n FROM events WHERE room_id=?").get(roomId).n;
  assert.ok(n0 >= 1, "expected seed events");

  // delete a middle event to create a gap
  if (n0 >= 3) {
    store.db.prepare("DELETE FROM events WHERE room_id=? AND sequence=2").run(roomId);
    await throwsBounded(() => store.room(roomId), 10000);
    console.log("  gapped log (missing seq 2) -> clean throw, not silent accept");
  } else {
    console.log(`  only ${n0} seed events; gap test needs >=3 — checking duplicate-sequence instead`);
  }

  // duplicate sequence numbers: two rows, same sequence
  const row = store.db.prepare("SELECT sequence, id, body FROM events WHERE room_id=? ORDER BY sequence LIMIT 1").get(roomId);
  store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES(?,?,?,?)")
    .run(roomId, row.sequence, row.id + "-dup", row.body);
  await throwsBounded(() => store.room(roomId), 10000);
  console.log("  duplicate sequence -> clean throw, not silent accept");
  store.close();
});
