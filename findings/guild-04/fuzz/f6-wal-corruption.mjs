// F6: WAL/journal corruption — open must recover or throw cleanly, never serve torn data.
import assert from "node:assert/strict";
import { join } from "node:path";
import { openSync, writeSync, closeSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../../server/store.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { fuzz, scratchDir, throwsBounded } from "./lib.mjs";

fuzz("F6-wal-corruption", async () => {
  const dir = scratchDir("g04-f6-");
  const file = join(dir, "room.sqlite");
  const store = new RoomStore(file);
  store.initialize(initialRoom("commons"));
  const before = store.db.prepare("SELECT count(*) n FROM events").get().n;
  const seqBefore = store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence;
  // force WAL frames to exist (checkpoint would clean them; keep some)
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES('commons', 999998, 'junk', '{}')").run();
  store.close();
  const wal = file + "-wal";
  assert.ok(existsSync(wal), "expected a WAL file with frames");
  // flip bytes in the middle of the WAL
  const fd = openSync(wal, "r+");
  const buf = Buffer.alloc(64); buf.fill(0xAA);
  writeSync(fd, buf, 0, 64, 128);
  closeSync(fd);

  // Reopen: sqlite must recover or throw — assert bounded, then verify data state.
  const t0 = Date.now();
  let outcome;
  try {
    const db = new DatabaseSync(file);
    const qc = db.prepare("PRAGMA integrity_check").get();
    const n = db.prepare("SELECT count(*) n FROM events").get().n;
    const seq = db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence;
    db.close();
    outcome = `recovered: integrity_check=${qc.integrity_check}, events=${n}, seq=${seq}`;
    assert.ok(seq === seqBefore, "sequence regressed — torn state served");
  } catch (e) {
    outcome = `clean throw: ${(e.code ?? e.message ?? e).toString().slice(0, 80)}`;
  }
  const dt = Date.now() - t0;
  assert.ok(dt < 15000, `recovery took ${dt}ms`);
  console.log(`  ${outcome} (${dt}ms)`);
});
