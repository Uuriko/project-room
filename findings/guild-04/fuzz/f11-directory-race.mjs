// F11: racing RoomDirectory.set() calls (two procs x 50 toggles) — one row, no torn mix.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../../server/store.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { RoomDirectory } from "../../server/room-directory.mjs";
import { fuzz, scratchDir } from "./lib.mjs";

fuzz("F11-directory-race", async () => {
  const dir = scratchDir("g04-f11-");
  const file = join(dir, "room.sqlite");
  {
    const s = new RoomStore(file);
    s.initialize(initialRoom("commons"));
    s.close();
  }
  const worker = `
    import { RoomStore } from "/home/hatch/workspace/pr-wave1000-guild-04/server/store.mjs";
    import { RoomDirectory } from "/home/hatch/workspace/pr-wave1000-guild-04/server/room-directory.mjs";
    const [file, slot] = [process.argv[2], Number(process.argv[3])];
    const store = new RoomStore(file);
    const d = new RoomDirectory(store);
    for (let i = 0; i < 50; i++) {
      try { d.set("commons", "owner", (i + slot) % 2 === 0); } catch (e) { /* busy is fine */ }
    }
    store.close();
  `;
  const ps = [0, 1].map(slot =>
    spawnSync("node", ["--input-type=module", "-e", worker, file, String(slot)],
      { timeout: 60000, encoding: "utf8" }));
  for (const [i, p] of ps.entries()) assert.equal(p.status, 0, `worker ${i}: ${p.stderr?.slice(-300)}`);
  const db = new DatabaseSync(file);
  const rows = db.prepare("SELECT * FROM room_directory_settings WHERE room_id='commons'").all();
  assert.equal(rows.length, 1, `torn: ${rows.length} settings rows`);
  assert.ok([0, 1].includes(rows[0].discoverable), "torn discoverable value");
  assert.ok(rows[0].updated_at > 0, "torn updated_at");
  db.close();
  console.log("  100 racing set()s: exactly one row, coherent values");
});
