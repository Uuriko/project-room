// F4 (wave300-fanout): read-path isolation for the SSE event stream.
//
// Measured verdict (perf/f4-read-isolation-sim.mjs): the lock-contention
// hypothesis is REFUTED —
//   * a CPU-burn control with no sqlite work degrades pump reads/timers the
//     same as real writes (event-loop queueing, not lock queueing),
//   * a cross-thread writer holding BEGIN IMMEDIATE open for 1.5s does not
//     stall main-thread eventsAfter (WAL readers never wait on RESERVED).
// The real write->read coupling in the pump path is the projection cache:
// every outermost write transaction (and the db.prepare watch) cleared the
// WHOLE cache, so under scratch-room write load each pump tick re-decoded
// the muse room's projection from scratch (SIM probe E: p99 0.20ms warm ->
// 7.37ms dropped). The lookup is already sequence-keyed, so the blanket
// clear is redundant for every hot-path writer (all bump rooms.sequence
// with the projection); only the no-sequence-bump repair paths need a
// targeted invalidation.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-f4-cache-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("muse"));
  store.initialize(initialRoom("scratch"));
  const museKey = store.issueAccessKey("muse", "owner");
  const scratchKey = store.issueAccessKey("scratch", "owner");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = (key, room, i) => store.command(key, room, {
    id: randomUUID(),
    type: T.CAPABILITIES_ADVERTISED,
    data: { capabilities: [`f4-${room}-${i}`] },
  });
  return { store, museKey, scratchKey, post };
}

test("F4: a write to another room does not invalidate this room's warm projection", t => {
  const { store, scratchKey, post } = fixture(t);
  const warm = store.room("muse");
  post(scratchKey, "scratch", 1); // outermost write txn on the OTHER room
  const after = store.room("muse");
  assert.strictEqual(after, warm,
    "muse projection must stay cached across an unrelated room's write (sequence-keyed lookup already guards staleness)");
});

test("F4: a write to the same room invalidates its projection", t => {
  const { store, museKey, post } = fixture(t);
  const warm = store.room("muse");
  post(museKey, "muse", 1);
  const after = store.room("muse");
  assert.notStrictEqual(after, warm, "same-room write bumps sequence, so the cache entry must miss");
  assert.equal(after.sequence, warm.sequence + 1);
});

test("F4: pump reads do not block behind a write transaction held open on another room", async t => {
  const { store, museKey } = fixture(t);
  // Hold a write lock open across an await on the scratch room, the way a
  // slow writer would. The pump's eventsAfter on the muse room must still
  // complete (WAL: readers never queue behind a RESERVED lock; same-thread
  // nesting must not deadlock either).
  store.db.exec("BEGIN IMMEDIATE");
  t.after(() => { try { store.db.exec("ROLLBACK"); } catch { /* already closed */ } });
  store.db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES('scratch', 999999, ?, ?)")
    .run(randomUUID(), JSON.stringify({ held: true }));
  await sleep(50);
  const t0 = performance.now();
  const page = store.eventsAfter(museKey, "muse", 0, 100, null);
  const elapsed = performance.now() - t0;
  assert.ok(Array.isArray(page.events), "eventsAfter returns during the held write lock");
  assert.ok(elapsed < 3000, `read completed promptly (${elapsed.toFixed(1)}ms), not after the 3s busy timeout`);
});
