import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { archivedMessageRow, restoreArchivedMessages } from "../server/messages-store.mjs";
import { operatorArchive } from "../server/operator-archive.mjs";
import { relieveProjectionsIncrementally } from "../server/store-relief.mjs";
import { DurableDatabase } from "../cloudflare/storage.mjs";

const recovery = { key: "verified-fixture", target: "kv", ageDays: 0 };
function fixture(t, { bodiesAtRest = true, pad = 100 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bounded-relief-"));
  let clock = Date.now();
  const store = new RoomStore(join(dir, "room.sqlite"), { now: () => clock, bodiesAtRest });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  const send = (type, data) => { clock += 10_000; return store.command(key, "commons", { id: randomUUID(), type, data }); };
  const post = (from, count) => { for (let i = from; i < from + count; i++) send(T.MESSAGE_POSTED, { messageId: `m-${i}`, body: `bounded ${i}`.padEnd(pad, "x") }); };
  const cursor = () => store.db.prepare("SELECT state_seq FROM messages_backfill_cursor WHERE room_id='commons'").get()?.state_seq ?? 0;
  return { store, send, post, cursor };
}

test("automatic catch-up has a total event bound and yields between committed chunks", async t => {
  const f = fixture(t); f.post(0, 250);
  const seen = [], limits = [];
  const original = f.store.backfillMessages.bind(f.store);
  t.mock.method(f.store, "backfillMessages", options => { limits.push(options.limit); return original(options); });
  const result = await relieveProjectionsIncrementally(f.store, {
    limitBytes: 1, recovery, eventCap: 100, chunkSize: 25,
    yieldWork: async () => { seen.push(f.cursor()); }
  });
  assert.equal(result.catchUpEvents, 100);
  assert.deepEqual(limits, [25, 25, 25, 25], "the archive cannot start another synchronous catch-up");
  assert.equal(seen.length, 4);
  assert.ok(seen[1] > seen[0] && seen[3] > seen[2], "committed progress is visible at each yield");
  assert.equal(f.cursor(), 100);
});

test("incomplete catch-up can archive its verified prefix while retaining later edits and pins", async t => {
  const f = fixture(t); f.post(0, 200);
  while (!f.store.backfillMessages({ limit: 1000 }).done) { /* certify the prefix */ }
  f.post(200, 120);
  let yielded = false;
  const result = await relieveProjectionsIncrementally(f.store, {
    limitBytes: 1, recovery, keepNewest: 100, eventCap: 1, chunkSize: 1,
    yieldWork: async () => {
      yielded = true;
      f.send(T.MESSAGE_EDITED, { messageId: "m-1", body: "edited during catch-up", expectedMessageRevision: 0 });
      f.send(T.MESSAGE_PINNED, { messageId: "m-2" });
    }
  });
  assert.equal(yielded, true);
  assert.equal(result.relieved, 1);
  assert.ok(result.freedBytes > 0);
  const messages = f.store.room("commons").state.messages;
  assert.equal(messages.find(m => m.id === "m-1").body, "edited during catch-up");
  assert.ok(messages.some(m => m.id === "m-2"));
  assert.ok(messages.some(m => m.id === "m-319"));
  assert.ok(archivedMessageRow(f.store.db, "commons", "m-0")?.body);
});

test("a missing recovery point permits neither replay nor archive", async t => {
  const f = fixture(t); f.post(0, 110);
  t.mock.method(f.store, "backfillMessages", () => { throw new Error("must not replay"); });
  const result = await relieveProjectionsIncrementally(f.store, { limitBytes: 1, yieldWork: async () => { throw new Error("must not yield"); } });
  assert.equal(result.backupMissing, 1);
  assert.equal(result.catchUpEvents, 0);
  assert.equal(result.relieved, 0);
});

test("zero catch-up budget refuses an uncertified full archive without advancing replay", t => {
  const f = fixture(t); f.post(0, 110);
  const before = f.cursor();
  assert.throws(() => operatorArchive(f.store, { roomId: "commons", keepNewest: 100, reason: "bounded fixture" }, null, { eventCap: 0 }),
    error => error.code === "archive_not_ready");
  assert.equal(f.cursor(), before);
});

test("DurableDatabase iterator streams rows and accounts for early termination", () => {
  let rowsRead = 0, argumentsSeen;
  const db = new DurableDatabase({ sql: { exec: (...args) => {
    argumentsSeen = args;
    return { get rowsRead() { return rowsRead; }, *[Symbol.iterator]() {
      for (let n = 0; n < 3; n++) { rowsRead++; yield { n }; }
    } };
  } } });
  for (const row of db.prepare("SELECT n WHERE n > ?").iterate(7)) {
    assert.equal(row.n, 0);
    break;
  }
  assert.deepEqual(argumentsSeen, ["SELECT n WHERE n > ?", 7]);
  assert.equal(rowsRead, 1, "remaining rows were not materialized");
  assert.equal(db.rowsRead, 1);
  const refused = new DurableDatabase({ sql: { exec: () => { throw new Error("SQLITE_TOOBIG"); } } });
  assert.throws(() => [...refused.prepare("SELECT body").iterate()], error => error.code === "pilot_limit");
});

test("bounded relief of a 3.5 MB projection preserves pins and restores every message", { timeout: 180_000 }, async t => {
  const f = fixture(t, { bodiesAtRest: false, pad: 1500 });
  f.post(0, 900);
  while (!f.store.backfillMessages({ limit: 1000 }).done) { /* verified prefix */ }
  f.post(900, 1400);
  f.send(T.MESSAGE_PINNED, { messageId: "m-0" });
  const bytes = () => f.store.db.prepare("SELECT length(CAST(projection AS BLOB)) AS n FROM rooms WHERE id='commons'").get().n;
  const before = bytes();
  assert.ok(before > 3_500_000);
  const result = await relieveProjectionsIncrementally(f.store, { limitBytes: 3_500_000, recovery });
  assert.ok(result.catchUpEvents <= 500);
  assert.equal(result.relieved, 1, JSON.stringify(result));
  assert.ok(bytes() < 3_500_000, `${before} -> ${bytes()}`);
  assert.ok(f.store.room("commons").state.messages.some(m => m.id === "m-0"));
  assert.ok(archivedMessageRow(f.store.db, "commons", "m-1")?.body);
  while (!f.store.backfillMessages({ limit: 1000 }).done) { /* finish parity proof after relief */ }
  assert.equal(f.store.checkMessagesParity({ roomId: "commons" }).ok, true);
  restoreArchivedMessages(f.store, "commons");
  const restored = new Set(f.store.room("commons").state.messages.map(m => m.id));
  for (let i = 0; i < 2300; i++) assert.ok(restored.has(`m-${i}`), `m-${i} restored`);
});
