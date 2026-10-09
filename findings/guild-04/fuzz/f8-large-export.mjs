// F8: large export stream — bounded time/memory, trailer verifies.
import assert from "node:assert/strict";
import { join } from "node:path";
import { RoomStore } from "../../server/store.mjs";
import { initialRoom } from "../../server/bootstrap.mjs";
import { exportNdjsonLines, exportTrailer, verifyTrailer } from "../../server/room-export.mjs";
import { fuzz, scratchDir } from "./lib.mjs";

fuzz("F8-large-export", async () => {
  const dir = scratchDir("g04-f8-");
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const NEVENTS = 5000;
  const t0 = Date.now();
  store.transaction(() => {
    const seq = store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence;
    const ins = store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES('commons', ?, ?, ?)");
    const big = "x".repeat(2000);
    for (let i = 1; i <= NEVENTS; i++) {
      ins.run(seq + i, `bulk-${i}`,
        JSON.stringify({ id: `bulk-${i}`, roomId: "commons", type: "message.posted", at: new Date().toISOString(), actorId: "owner", data: { messageId: `m-${i}`, body: big } }));
    }
    store.db.prepare("UPDATE rooms SET sequence=? WHERE id='commons'").run(seq + NEVENTS);
  });
  console.log(`  inserted ${NEVENTS} events in ${Date.now() - t0}ms`);
  const mem0 = process.memoryUsage().heapUsed;
  const s0 = Date.now();
  let lines = 0, bytes = 0;
  for (const line of exportNdjsonLines(store.db)) { lines++; bytes += line.length; }
  const dt = Date.now() - s0;
  const mem1 = process.memoryUsage().heapUsed;
  console.log(`  streamed ${lines} lines / ${(bytes / 1e6).toFixed(1)}MB in ${dt}ms, heap delta ${((mem1 - mem0) / 1e6).toFixed(1)}MB`);
  assert.ok(dt < 60000, "export too slow");
  assert.ok((mem1 - mem0) < 200 * 1e6, "export held too much in memory (not streaming?)");
  const trailer = exportTrailer(store.db);
  assert.equal(trailer.events, NEVENTS + store.db.prepare("SELECT count(*) n FROM events WHERE room_id='commons' AND id NOT LIKE 'bulk-%'").get().n);
  // parse-back check: verifyTrailer over parsed rows
  const byTable = new Map();
  for (const line of exportNdjsonLines(store.db)) {
    const rec = JSON.parse(line);
    if (rec.table === "events") (byTable.get("events") ?? byTable.set("events", []).get("events")).push(rec.row);
  }
  assert.ok(verifyTrailer(trailer, byTable));
  store.close();
  console.log("  trailer verifies over the full stream");
});
