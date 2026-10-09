// F1: corrupt JSON in events/projection rows — reads must fail clean, never hang or serve torn data.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../../server/store.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { fuzz, scratchDir, throwsBounded } from "./lib.mjs";

fuzz("F1-corrupt-rows", async () => {
  const dir = scratchDir("g04-f1-");
  const file = join(dir, "room.sqlite");
  const store = new RoomStore(file);
  store.initialize(initialRoom("commons"));
  const roomId = "commons";
  // sanity: room reads fine before corruption
  assert.ok(store.room(roomId).state.room.id === roomId);

  // 1) corrupt one event body
  store.db.prepare("UPDATE events SET body='{{{not-json' WHERE room_id=? AND sequence=1").run(roomId);
  const dt1 = await throwsBounded(() => store.room(roomId), 10000);
  console.log(`  corrupt event body -> clean throw in ${dt1}ms`);

  // restore, then corrupt the projection JSON
  store.db.prepare("UPDATE events SET body=(SELECT body FROM events WHERE room_id=? AND sequence=2) WHERE room_id=? AND sequence=1").run(roomId, roomId);
  // (sequence 2 may not exist; write a valid minimal event instead)
  store.db.prepare("UPDATE events SET body=? WHERE room_id=? AND sequence=1")
    .run(JSON.stringify({ id: "e1", roomId, type: "room.created", at: new Date().toISOString(), actorId: "owner", data: {} }), roomId);
  store.db.prepare("UPDATE rooms SET projection='[broken' WHERE id=?").run(roomId);
  const dt2 = await throwsBounded(() => store.room(roomId), 10000);
  console.log(`  corrupt projection -> clean throw in ${dt2}ms`);

  // 3) corrupt archived_at-adjacent column read path: NULL projection
  store.db.prepare("UPDATE rooms SET projection=NULL WHERE id=?").run(roomId);
  await throwsBounded(() => store.room(roomId), 10000);
  console.log("  null projection -> clean throw");

  store.close();
  // DB file itself must still open and report its own integrity state
  const db2 = new DatabaseSync(file);
  const qc = db2.prepare("PRAGMA quick_check").get();
  db2.close();
  console.log(`  quick_check after corruption: ${qc.quick_check}`);
});
