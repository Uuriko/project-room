// Regression tests for the backup repair wave (2026-11-12):
// 1. overlapping consistent exports collided on the shared staging table;
// 2. materialized parts could exceed the per-part byte cap;
// 3. the operator / in-memory export path buffered without a bound;
// 4. the #6176 snapshot-size guard failed open on an unknown size.
// Every test in this file fails on origin/main (e5b6fa4cb) and passes
// with the repair in server/room-export.mjs + cloudflare/room-backup.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  exportNdjsonStream, exportNdjsonText, exportNdjsonConsistentStream, materializeExportParts,
  BACKUP_EXPORT_PARTS_TABLE, BACKUP_SNAPSHOT_TOO_LARGE,
  storeDatabaseBytes, operatorExportResponse
} from "../server/room-export.mjs";
import { writeDailyBackup, backupFailureDetail } from "../cloudflare/room-backup.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const OPERATOR = "operator-token-value";

function openStore(t, messages = 3, bodyPad = 300) {
  const directory = mkdtempSync(join(tmpdir(), "room-backup-repair-"));
  const store = new RoomStore(join(directory, "live.sqlite"));
  t.after(() => { try { store.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  for (let i = 0; i < messages; i += 1) {
    store.command(key, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `m-${i}`, body: `message ${i} ${"x".repeat(bodyPad)}` } });
  }
  return { directory, store };
}

// A mid-export write, injected the same way the existing tear tests do
// it: a raw event row, not store.command.
function insertPhantom(store, messageId, body) {
  const seq = store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence + 1;
  store.db.prepare("INSERT INTO events (room_id, sequence, id, body) VALUES ('commons', ?, ?, ?)")
    .run(seq, crypto.randomUUID(), JSON.stringify({ id: crypto.randomUUID(), type: T.MESSAGE_POSTED, roomId: "commons", actorId: "owner", at: new Date().toISOString(), data: { messageId, body } }));
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id='commons'").run(seq);
}

const normalize = text => text.replace(/"backedUpAt":\d+/, '"backedUpAt":0');

async function drainReader(reader) {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

test("overlapping consistent exports each stream their own snapshot, not each other's", async t => {
  const { store } = openStore(t, 3);
  const expectedA = normalize(exportNdjsonText(store.db));

  // Export A materializes and starts streaming.
  const streamA = exportNdjsonConsistentStream(store, { partBytes: 200 });
  const readerA = streamA.getReader();
  const first = await readerA.read();
  assert.equal(first.done, false, "export A has parts to stream");

  // A write lands, then export B materializes and streams, while A is
  // still mid-pull. On the shared-table code B's materialize replaced
  // A's parts and A's end-of-stream clear deleted B's parts.
  insertPhantom(store, "b-only", "only in the second snapshot");
  const streamB = exportNdjsonConsistentStream(store, { partBytes: 200 });

  const restA = await drainReader(readerA);
  const textA = normalize(new TextDecoder().decode(first.value) + restA);
  const textB = await new Response(streamB).text();

  assert.equal(textA, expectedA, "export A serves exactly the snapshot it materialized");
  assert.equal(textA.includes("b-only"), false);
  assert.equal(textB.includes("b-only"), true, "export B serves its own, later snapshot");
  assert.match(textB, /"kind":"trailer"/, "export B is whole, not truncated by A's clear");
  assert.equal(store.db.prepare(`SELECT count(*) AS n FROM "${BACKUP_EXPORT_PARTS_TABLE}"`).get().n, 0,
    "both exports cleared only their own staging rows");
});

test("materialized parts never exceed partBytes, even when one line is far longer than the cap", t => {
  const { store } = openStore(t, 2, 5000);
  const partBytes = 256;
  const parts = store.transaction(() => materializeExportParts(store.db, { partBytes }));
  assert.ok(parts > 10, `a multi-KB line must be sliced into many parts, got ${parts}`);
  const rows = store.db.prepare(`SELECT bytes FROM "${BACKUP_EXPORT_PARTS_TABLE}" ORDER BY part_index`).all();
  assert.equal(rows.length, parts);
  for (const row of rows) {
    const bytes = row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes);
    assert.ok(bytes.byteLength <= partBytes, `a stored part is ${bytes.byteLength} bytes, over the ${partBytes} cap`);
    assert.ok(bytes.byteLength > 0, "no empty parts");
  }
  const joined = Buffer.concat(rows.map(row => Buffer.from(row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes)))).toString();
  assert.equal(normalize(joined), normalize(exportNdjsonText(store.db)), "slicing loses and duplicates no bytes");
  assert.throws(() => materializeExportParts(store.db, { partBytes: 0 }), /positive integer/);
});

test("exportNdjsonStream refuses to buffer an export past its byte bound", t => {
  const { store } = openStore(t, 3);
  assert.throws(() => exportNdjsonStream(store.db, { maxBytes: 512 }), new RegExp(BACKUP_SNAPSHOT_TOO_LARGE));
  // Under the bound the same store still streams whole.
  return new Response(exportNdjsonStream(store.db, { maxBytes: 64 * 1024 * 1024 })).text()
    .then(text => assert.match(text, /"kind":"trailer"/));
});

test("the operator export answers 413 for an oversized export instead of buffering it", async t => {
  const { store } = openStore(t, 3);
  const url = "https://room.example/api/operator/export";
  const headers = { authorization: `Bearer ${OPERATOR}` };
  const refused = operatorExportResponse(new Request(url, { headers }), OPERATOR, store.db, { maxExportBytes: 512 });
  assert.equal(refused.status, 413);
  const body = JSON.parse(await refused.text());
  assert.equal(body.error.code, "snapshot_too_large");
  const ok = operatorExportResponse(new Request(url, { headers }), OPERATOR, store.db);
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /"kind":"trailer"/);
});

test("storeDatabaseBytes reports an unmeasurable store as unknown, and the consistent export fails closed", async t => {
  // Sanity in the other direction: a real store still measures and exports.
  const { store: realStore } = openStore(t, 2);
  const realBytes = storeDatabaseBytes(realStore.db);
  assert.ok(Number.isSafeInteger(realBytes) && realBytes > 0, "the fixture store reports a size");
  assert.match(await new Response(exportNdjsonConsistentStream(realStore, { maxSnapshotBytes: 1 << 30 })).text(), /"kind":"trailer"/);

  // A db whose size sources are all absent/invalid: PRAGMA reads return
  // no row fields and there is no native databaseSize.
  const fakeDb = { prepare: () => ({ get: () => ({}) }) };
  assert.equal(storeDatabaseBytes(fakeDb), null, "unknown size must not be reported as 0");
  const fakeDbThrowing = { prepare: () => { throw new Error("no pragmas here"); } };
  assert.equal(storeDatabaseBytes(fakeDbThrowing), null);

  const stubStore = { db: fakeDb, transaction: fn => fn() };
  assert.throws(() => exportNdjsonConsistentStream(stubStore, {}), /backup_snapshot_size_unknown/);

  // The backup job maps the refusal to a bounded reason token, not a
  // generic (or, worse, successful) outcome, and writes no manifest.
  const kvMap = new Map();
  const kv = {
    async get(key) { return kvMap.has(key) ? kvMap.get(key) : null; },
    async put(key, value) { kvMap.set(key, value); }
  };
  const room = { exportRoomNdjson: () => exportNdjsonConsistentStream(stubStore, {}) };
  let failure;
  try { await writeDailyBackup({ ROOM_BACKUPS_KV: kv }, room, new Date(Date.UTC(2026, 9, 8, 9))); } catch (error) { failure = error; }
  assert.ok(failure, "an unmeasurable store must fail the backup job, not pass the guard");
  assert.deepEqual(backupFailureDetail(failure), { code: "backup_export_failed", component: "export", errorClass: "backup_failure", reason: "snapshot_size_unknown" });
  assert.equal(kvMap.size, 0, "no manifest or part is written");
});
