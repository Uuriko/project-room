// PERF2-MEASURE (PERF-2 §4.5): the store-growth gauge's warm-tier
// breakdown — projection bodies at rest and stored attachment bytes — so
// the production census reads them from the health surface instead of a
// wrangler session. A store missing a table reports 0 for it, never throws.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { measureStoreGrowth } from "../server/jobs.mjs";

function fixture() {
  const db = new DatabaseSync(":memory:");
  const store = new RoomStore(":memory:", { database: db });
  store.initialize(initialRoom("commons"));
  return { db, store };
}

test("empty store: warm-tier gauges read 0 and the standing gauges still read", (t) => {
  const { store } = fixture();
  t.after(() => store.close());
  const gauges = measureStoreGrowth(store);
  assert.equal(gauges.bodyBytes, 0);
  assert.equal(gauges.attachmentBytes, 0);
  assert.equal(gauges.rooms, 1);
  assert.ok(gauges.maxProjectionBytes > 0);
  assert.ok(gauges.dbBytes > 0);
});

test("seeded bodies and attachments are counted exactly; byte-less rows are not", (t) => {
  const { db, store } = fixture();
  t.after(() => store.close());
  db.prepare("INSERT INTO projection_bodies (room_id, sha, body) VALUES ('commons', ?, ?)").run("a".repeat(64), "x".repeat(1000));
  db.prepare("INSERT INTO projection_bodies (room_id, sha, body) VALUES ('commons', ?, ?)").run("b".repeat(64), "y".repeat(250));
  const sha = "c".repeat(64);
  // Room attachment with bytes stored (committed): counts.
  db.prepare(`INSERT INTO room_attachments (room_id, id, uploader_id, filename, media_type, byte_length, sha256, bytes, state, created_at, expires_at)
    VALUES ('commons', 'a1', 'u', 'f.txt', 'text/plain', 500, ?, ?, 'committed', 1, 2)`).run(sha, Buffer.alloc(500));
  // Discarded room attachment: bytes are NULL by the schema CHECK — the
  // declared byte_length must NOT be counted as stored bytes.
  db.prepare(`INSERT INTO room_attachments (room_id, id, uploader_id, filename, media_type, byte_length, sha256, bytes, state, created_at, expires_at)
    VALUES ('commons', 'a2', 'u', 'f.txt', 'text/plain', 700, ?, NULL, 'discarded', 1, 2)`).run(sha);
  // Inbox attachment with bytes stored (staged): counts.
  db.prepare(`INSERT INTO inbox_attachment_bytes (identity_id, id, filename, media_type, byte_length, sha256, bytes, state, created_at, expires_at)
    VALUES ('u', 'i1', 'f.txt', 'text/plain', 250, ?, ?, 'staged', 1, 2)`).run(sha, Buffer.alloc(250));
  const gauges = measureStoreGrowth(store);
  assert.equal(gauges.bodyBytes, 1250);
  assert.equal(gauges.attachmentBytes, 750);
});
