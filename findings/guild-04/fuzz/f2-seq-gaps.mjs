// F2 (fixed): out-of-order / gapped / duplicate event sequences — the event log
// is append-only; rebuild must reject gaps cleanly, never serve a torn projection.
import assert from "node:assert/strict";
import { join } from "node:path";
import { RoomStore } from "../../../server/store.mjs";
import { initialRoom } from "../../../server/bootstrap.mjs";
import { fuzz, scratchDir, throwsBounded } from "./lib.mjs";

fuzz("F2-seq-gaps", async () => {
  const dir = scratchDir("g04-f2-");
  const file = join(dir, "room.sqlite");
  const store = new RoomStore(file);
  store.initialize(initialRoom("commons"));
  const roomId = "commons";
  const before = store.db.prepare("SELECT count(*) n FROM events WHERE room_id=?").get(roomId).n;
  assert.ok(before >= 2, `need >=2 seed events, got ${before}`);

  const mkBody = (id) => JSON.stringify({
    id, roomId, type: "message.posted", at: new Date().toISOString(),
    actorId: "owner", data: { messageId: id, body: "fuzz" },
  });

  // 1) duplicate sequence insert: PRIMARY KEY must reject cleanly.
  let dupThrew = null;
  try {
    store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, 1, "dup-id", mkBody("dup-id"));
  } catch (e) { dupThrew = e; }
  assert.ok(dupThrew, "duplicate (room_id, sequence) accepted");
  assert.match(String(dupThrew.message), /UNIQUE|PRIMARY/i, `unclean: ${dupThrew.message}`);
  console.log("  duplicate sequence -> clean UNIQUE rejection");

  // 2) create a gap: insert sequence max+2, skipping max+1.
  const maxSeq = store.db.prepare("SELECT max(sequence) m FROM events WHERE room_id=?").get(roomId).m;
  store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, maxSeq + 2, "gap-id", mkBody("gap-id"));
  // bump the room head so rebuild walks over the gap
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id=?").run(maxSeq + 2, roomId);
  const dt = await throwsBounded(() => store.rebuildProjection(roomId), 10000);
  assert.throws(() => store.rebuildProjection(roomId), /not contiguous/i);
  console.log(`  sequence gap -> rebuild throws "not contiguous" in ${dt}ms`);

  // 3) deleting an event: the writer fence must keep the log append-only.
  let delThrew = null;
  try {
    store.db.prepare("DELETE FROM events WHERE room_id=? AND sequence=?").run(roomId, 1);
  } catch (e) { delThrew = e; }
  if (delThrew) console.log(`  event delete -> fence blocked clean (${String(delThrew.message).slice(0, 60)})`);
  else {
    const dt3 = await throwsBounded(() => store.rebuildProjection(roomId), 10000);
    console.log(`  event deleted -> rebuild throws clean in ${dt3}ms`);
  }
  store.close();
  console.log("  no torn projection served, no hangs");
});
