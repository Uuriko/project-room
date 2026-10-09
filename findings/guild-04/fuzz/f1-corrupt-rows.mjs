// F1 (fixed): hostile writes to events/rooms rows — the writer fence must reject
// non-JSON cleanly; valid-JSON-but-wrong-shape corruption must fail reads clean,
// never hang or serve torn data.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../../../server/store.mjs";
import { initialRoom } from "../../../server/bootstrap.mjs";
import { fuzz, scratchDir, throwsBounded } from "./lib.mjs";

fuzz("F1-corrupt-rows", async () => {
  const dir = scratchDir("g04-f1-");
  const file = join(dir, "room.sqlite");
  const store = new RoomStore(file);
  store.initialize(initialRoom("commons"));
  const roomId = "commons";
  assert.ok(store.room(roomId).state.room.id === roomId);

  // tryCorrupt: returns "fence-blocked" when the writer fence rejects the SQL,
  // "written" when it lands (then reads must fail clean).
  const tryCorrupt = (label, sql, ...params) => {
    try {
      store.db.prepare(sql).run(...params);
      return "written";
    } catch (e) {
      console.log(`  ${label}: fence blocked clean (${String(e.message).slice(0, 60)})`);
      return "fence-blocked";
    }
  };
  const readMustThrow = async (label, readFn) => {
    const dt = await throwsBounded(readFn ?? (() => store.room(roomId)), 10000);
    console.log(`  ${label} -> read throws clean in ${dt}ms`);
  };

  // 1) non-JSON event body: the fence must reject it (not the read path).
  const r1 = tryCorrupt("non-JSON event body", "UPDATE events SET body='{{{not-json' WHERE room_id=? AND sequence=1", roomId);
  assert.equal(r1, "fence-blocked", "fence accepted non-JSON event body");

  // 2) valid JSON, wrong shape: the cached projection still reads (no torn
  // state), but rebuild over the log must throw clean.
  const bad = JSON.stringify({ id: "e1", roomId, type: "room.created", at: new Date().toISOString(), actorId: "owner", data: { bogus: 1 } });
  if (tryCorrupt("wrong-shape event body", "UPDATE events SET body=? WHERE room_id=? AND sequence=1", bad, roomId) === "written") {
    assert.ok(store.room(roomId).state.room.id === roomId, "cached projection broke");
    await readMustThrow("wrong-shape event body (rebuild)", () => store.rebuildProjection(roomId));
  }

  // 3) broken projection JSON.
  if (tryCorrupt("broken projection", "UPDATE rooms SET projection='[broken' WHERE id=?", roomId) === "written")
    await readMustThrow("broken projection");

  // 4) NULL projection.
  if (tryCorrupt("NULL projection", "UPDATE rooms SET projection=NULL WHERE id=?", roomId) === "written")
    await readMustThrow("NULL projection");

  store.close();
  const db2 = new DatabaseSync(file);
  const qc = db2.prepare("PRAGMA quick_check").get();
  db2.close();
  console.log(`  quick_check after corruption: ${qc.quick_check}`);
});
