// Lane B2 (P1 design §3.2/§3.3): the chunked, resumable serving-content
// scanner in server/write-integrity.mjs. The drift-verdict leg is chunked
// over the room's messages in message-id order under a dual bound (rows
// AND fetched bytes, paged by key range); the synchronous exports keep
// their contracts by driving the scanner to completion in one call.
// The durable checkpoint table is lane B4's scope — these tests assert
// the in-memory stepper legs only (progress across drives, deadline
// respect, no verdict from a partial scan, byte/row bounds per chunk).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  createServingContentScanner, driveServingContentScan,
  servingContentProof, servingProofDrift, projectionContentHash,
  CONTENT_SCAN_CHUNK_ROWS, CONTENT_SCAN_CHUNK_BYTES,
} from "../server/write-integrity.mjs";

function fixtureStore(t, { messages = 120, bodyBytes = 200 } = {}) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom("commons"));
  const owner = store.issueAccessKey("commons", "owner");
  let now = Date.now() + 10000;
  store.now = () => now;
  const body = "x".repeat(bodyBytes);
  for (let i = 0; i < messages; i++) {
    now += 2001;
    const id = `m-${String(i).padStart(5, "0")}`;
    store.command(owner, "commons", { id, type: "message.posted", data: { messageId: id, body } });
  }
  while (!store.backfillMessages({ limit: 1000 }).done) { /* fixture */ }
  assert.equal(store.checkMessagesParity({ roomId: "commons" }).ok, true);
  // Convert to the canonical (message-authority) projection form: the
  // form whose serving proof actually traverses the messages table.
  store.migrateMessageAuthority("commons");
  const row = store.db.prepare("SELECT sequence, projection FROM rooms WHERE id=?").get("commons");
  assert.equal(JSON.parse(row.projection).messageAuthority.count, messages);
  return { store, row };
}
const newScanner = (store, row, opts = {}) =>
  createServingContentScanner(store.db, "commons", row.sequence, row.projection, { verify: true, hashContent: true, ...opts });

test("sync exports keep their contracts and match the scanner driven to completion", t => {
  const { store, row } = fixtureStore(t, { messages: 25 });
  const proof = servingContentProof(store.db, "commons", row.sequence, row.projection);
  assert.equal(proof.drift, false);
  assert.match(proof.hash, /^[0-9a-f]{64}$/);
  assert.equal(proof.hash, projectionContentHash(store.db, "commons", row.sequence, row.projection));
  assert.equal(servingProofDrift(store.db, "commons", row.projection), false);
  const scanned = newScanner(store, row, { chunkRows: 5, chunkBytes: 4096 }).drive();
  assert.deepEqual(scanned, proof);
});

test("chunked progress across drives: cursor banks per chunk, no verdict from a partial scan", t => {
  const { store, row } = fixtureStore(t, { messages: 120 });
  const scanner = newScanner(store, row, { chunkRows: 10, chunkBytes: 1 << 20 });
  const first = driveServingContentScan(scanner, { deadline: Date.now() - 1 });
  // A drive on a spent budget banks exactly one chunk, then reports
  // progress — with no drift verdict and no hash.
  assert.equal(first.done, false);
  assert.equal(first.inProgress, 1);
  assert.equal(first.budgetExceeded, 1);
  assert.equal(first.drift, undefined);
  assert.equal(first.hash, undefined);
  assert.equal(first.scannedRows, 10);
  assert.equal(first.range_cursor, "m-00009");
  assert.equal(Number(first.scan_bound), row.sequence);
  const second = driveServingContentScan(scanner, { deadline: Date.now() - 1 });
  assert.equal(second.scannedRows, 20);
  assert.equal(second.range_cursor, "m-00019");
  const done = driveServingContentScan(scanner);
  assert.deepEqual(done, servingContentProof(store.db, "commons", row.sequence, row.projection));
  assert.equal(scanner.done, true);
});

test("no drive exceeds its deadline by more than one chunk", async t => {
  const { store, row } = fixtureStore(t, { messages: 120, bodyBytes: 800 });
  const scanner = newScanner(store, row, { chunkRows: 10, chunkBytes: 16384 });
  let drives = 0;
  for (;;) {
    const started = Date.now();
    const result = await driveServingContentScan(scanner, { deadline: started + 5, yieldBetween: async () => {} });
    const elapsed = Date.now() - started;
    drives++;
    assert.ok(elapsed <= 5 + 1500, `drive ${drives} took ${elapsed} ms, over deadline + one chunk of slack`);
    if (scanner.done) { assert.equal(result.drift, false); break; }
    assert.ok(drives < 50, "scan must complete in bounded drives");
  }
  assert.ok(drives >= 2, "a 120-message scan at chunkRows=10 cannot complete in one drive inside 5 ms budgets");
});

test("dual bound per chunk: rows and fetched bytes, segment counter never resets inside a chunk", t => {
  const { store, row } = fixtureStore(t, { messages: 60, bodyBytes: 1000 });
  const scanner = newScanner(store, row, { chunkRows: 200, chunkBytes: 8192 });
  let steps = 0;
  while (!scanner.done) {
    const before = scanner.count;
    scanner.step();
    steps++;
    if (scanner.phase !== "done" || scanner.count < 60) {
      assert.ok(scanner.count - before <= CONTENT_SCAN_CHUNK_ROWS);
      assert.ok(scanner.lastSegmentBytes <= 8192 + 4096,
        `segment bytes ${scanner.lastSegmentBytes} over chunk byte bound + one largest-row allowance`);
    }
    assert.ok(steps < 100);
  }
  assert.ok(steps >= 3, `byte bound must split 60 x ~1 KB rows at 8 KiB/chunk into multiple chunks, got ${steps}`);
  assert.equal(scanner.count, 60);
});

test("oversize row is processed alone and reported", t => {
  const { store, row } = fixtureStore(t, { messages: 5, bodyBytes: 5000 });
  const scanner = newScanner(store, row, { chunkRows: 200, chunkBytes: 1024 });
  const done = scanner.drive();
  assert.equal(done.drift, false);
  assert.equal(scanner.fetchOversize, 1);
  assert.equal(scanner.count, 5);
});

test("one bad row: a tampered message proof is drift, exactly as the sync export reports", t => {
  const { store, row } = fixtureStore(t, { messages: 10 });
  store.db.prepare("UPDATE messages SET entity_hash='deadbeef' WHERE room_id=? AND message_id=?").run("commons", "m-00004");
  assert.equal(servingContentProof(store.db, "commons", row.sequence, row.projection).drift, true);
  assert.equal(servingProofDrift(store.db, "commons", row.projection), true);
  const scanned = newScanner(store, row, { chunkRows: 3, chunkBytes: 4096 }).drive();
  assert.equal(scanned.drift, true);
});

test("defaults are the design family: 200 rows and 256 KiB per chunk", () => {
  assert.equal(CONTENT_SCAN_CHUNK_ROWS, 200);
  assert.equal(CONTENT_SCAN_CHUNK_BYTES, 256 * 1024);
});
