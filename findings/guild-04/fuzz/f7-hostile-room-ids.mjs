// F7: hostile room ids against RoomDirectory — 4xx never 500, no hangs.
import assert from "node:assert/strict";
import { join } from "node:path";
import { RoomStore } from "../../server/store.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { RoomDirectory } from "../../server/room-directory.mjs";
import { fuzz, scratchDir, throwsBounded } from "./lib.mjs";

const NASTY = [
  "../../etc/passwd", "..\\..\\windows", "", " ", "a".repeat(10000),
  "room\x00null", "room\nnewline", "réunion-🎉", "'; DROP TABLE rooms;--",
  "commons ", " COMMONS", "null", "undefined", ".", "..", "/",
  "\u202eRTL-override", "a".repeat(384) + "!", "{json}", "[array]",
];
fuzz("F7-hostile-room-ids", async () => {
  const dir = scratchDir("g04-f7-");
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec("INSERT INTO room_directory_settings(room_id, discoverable, listed_at, updated_at) VALUES('commons',1,1,1)");
  const d = new RoomDirectory(store);
  let checked = 0;
  for (const id of NASTY) {
    const t0 = Date.now();
    try {
      d.status(id, "owner");
      // status() on unknown rooms: _roomState -> store.room throws 404; that's fine
      console.log(`  status(${JSON.stringify(id).slice(0, 30)}) -> no throw (room may exist)`);
    } catch (e) {
      assert.ok([400, 401, 403, 404, 422].includes(e.status),
        `roomId ${JSON.stringify(id).slice(0,40)} gave status ${e.status} (expected 4xx, got ${e.status}: ${e.message})`);
    }
    const dt = Date.now() - t0;
    assert.ok(dt < 5000, `hang on roomId ${JSON.stringify(id).slice(0, 30)}`);
    checked++;
    // list() with hostile cursor/limit
    try { d.list({ after: id, limit: id }); } catch (e) {
      assert.ok([400, 404, 422].includes(e.status), `list() gave ${e.status} for hostile input`);
    }
  }
  // no stray rows created by hostile ids
  const n = store.db.prepare("SELECT count(*) n FROM room_directory_settings").get().n;
  assert.equal(n, 1, `hostile ids created settings rows: ${n}`);
  store.close();
  console.log(`  ${checked} hostile ids: all 4xx-or-clean, no hangs, no stray rows`);
});
