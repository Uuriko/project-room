// #4975 successor regression (supersedes the partial cure in #6121):
// a LEGACY backup — taken before #4975, when the exporter still pinned the
// six retired tables in its trailer — whose retired tables are POPULATED
// must restore. #6121 made replay skip the retired rows and stopped the
// current exporter pinning them, but the restore-side digest computation
// skipped them too, so contentVerificationLevel saw a trailer pin with no
// computed digest and refused every populated legacy backup with
// "Export trailer pins table … but the export holds no rows for it"
// (HTTP 422 at the operator door). The cure separates the dispositions:
// restore-side digests verify the old pin; replay still skips the rows;
// a genuinely altered retired row still fails the pin.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { exportNdjsonText, replayNdjson, createTableDigests, RETIRED_4975_TABLES } from "../server/room-export.mjs";
import { replayNdjsonInto, createBackupReplaySession, operatorRestoreResponse } from "../server/restore-ndjson.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const OPERATOR_TOKEN = "operator-token-for-restore-tests";

// One populated row-set per retired table, as a pre-#4975 store would hold.
const RETIRED_ROWS = Object.freeze({
  board_vtwo_claims: [
    { id: "claim-1", room_id: "commons", title: "old claim" },
    { id: "claim-2", room_id: "commons", title: "older claim" },
  ],
  board_vtwo_events: [{ id: "bve-1", room_id: "commons", kind: "claimed" }],
  board_vtwo_idempotency: [{ id: "bvi-1", key: "idem-1" }],
  board_vtwo_mirror: [{ id: "bvm-1", room_id: "commons" }],
  analytics_firsts: [{ id: "af-1", actor: "agent", first_at: 1 }],
  guest_link_exchanges: [{ id: "gle-1", room_id: "commons", code: "abc" }],
});

function openStore(t, name) {
  const directory = mkdtempSync(join(tmpdir(), name));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seedExport(t) {
  const store = openStore(t, "restore-4975-seed-");
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "legacy history that must survive" } });
  return exportNdjsonText(store.db);
}

// The pre-#4975 exporter's pin for one table: sha256 over
// JSON.stringify(row) + "\n" per row, in stream order — the exact
// createTableDigests construction from before the tables were skipped.
function legacyPin(rows) {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  return { rows: rows.length, sha256: hash.digest("hex") };
}

// Rebuild a current export as the legacy backup it stands in for: append
// the populated retired-table rows and (by default) pin them in the
// trailer exactly as the old exporter did.
function legacyBackup(baseExport, { pinRetired = true, tamperTable = null } = {}) {
  const records = baseExport.trim().split("\n").map(line => JSON.parse(line));
  const out = [];
  let trailer = null;
  for (const record of records) {
    if (record.kind === "trailer") { trailer = record; continue; }
    out.push(JSON.stringify(record));
  }
  const tables = { ...(trailer.tables ?? {}) };
  for (const table of RETIRED_4975_TABLES) {
    const rows = RETIRED_ROWS[table];
    assert.ok(rows?.length, `fixture covers retired table ${table}`);
    const streamed = table === tamperTable
      ? rows.map((row, index) => index === 0 ? { ...row, tampered: "altered after the pin was taken" } : row)
      : rows;
    for (const row of streamed) out.push(JSON.stringify({ table, row }));
    if (pinRetired) tables[table] = legacyPin(rows); // pin over the ORIGINAL rows
  }
  out.push(JSON.stringify({ ...trailer, version: 2, tables }));
  return out.join("\n") + "\n";
}

test("the fixture really covers all six #4975-retired tables", () => {
  assert.deepEqual([...RETIRED_4975_TABLES].sort(), Object.keys(RETIRED_ROWS).sort());
});

test("digest disposition is separate from replay disposition", () => {
  const row = RETIRED_ROWS.board_vtwo_claims[0];
  const current = createTableDigests();
  current.add("board_vtwo_claims", row);
  assert.equal(current.finish().board_vtwo_claims, undefined,
    "the current exporter never pins a retired table");
  const restoreSide = createTableDigests({ verifyRetired4975Pins: true });
  restoreSide.add("board_vtwo_claims", row);
  assert.deepEqual(restoreSide.finish().board_vtwo_claims, legacyPin([row]),
    "restore-side digests reproduce the legacy pin for the same rows");
});

test("a populated legacy backup restores through replayNdjsonInto; retired rows are verified but not loaded", t => {
  const ndjson = legacyBackup(seedExport(t));
  const target = openStore(t, "restore-4975-populated-into-");
  const result = replayNdjsonInto(ndjson, target);
  assert.equal(result.verified, true);
  assert.equal(result.contentVerification, "full");
  for (const table of RETIRED_4975_TABLES)
    assert.equal(result.skippedTables[table], RETIRED_ROWS[table].length, `${table} rows counted as skipped`);
  const names = target.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  for (const table of RETIRED_4975_TABLES)
    assert.ok(!names.includes(table), `retired table ${table} was not recreated by the restore`);
  assert.ok(target.room("commons").state.messages.some(m => m.body === "legacy history that must survive"),
    "the room's real history landed");
});

test("a populated legacy backup restores through the streaming replay session (the KV/production path)", t => {
  const ndjson = legacyBackup(seedExport(t));
  const target = openStore(t, "restore-4975-populated-session-");
  const session = createBackupReplaySession(target);
  session.writeText(ndjson);
  const result = session.finish();
  assert.equal(result.verified, true);
  assert.equal(result.contentVerification, "full");
  for (const table of RETIRED_4975_TABLES)
    assert.equal(result.skippedTables[table], RETIRED_ROWS[table].length, `${table} rows counted as skipped`);
});

test("a populated legacy backup restores through the file replay (replayNdjson)", t => {
  const ndjson = legacyBackup(seedExport(t));
  const directory = mkdtempSync(join(tmpdir(), "restore-4975-populated-file-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = replayNdjson(ndjson, join(directory, "restored.sqlite"));
  assert.equal(result.verified, true);
  assert.equal(result.contentVerification, "full");
  for (const table of RETIRED_4975_TABLES)
    assert.equal(result.skippedTables[table], RETIRED_ROWS[table].length, `${table} rows counted as skipped`);
});

test("a populated retired-table backup whose trailer does not pin them (post-#4975 exporter shape) still restores", t => {
  const ndjson = legacyBackup(seedExport(t), { pinRetired: false });
  const target = openStore(t, "restore-4975-unpinned-");
  const result = replayNdjsonInto(ndjson, target);
  assert.equal(result.verified, true);
  assert.equal(result.contentVerification, "full");
});

test("tamper retention: altering a pinned retired row still refuses the restore, by digest mismatch", t => {
  const ndjson = legacyBackup(seedExport(t), { tamperTable: "board_vtwo_claims" });
  const target = openStore(t, "restore-4975-tampered-");
  assert.throws(() => replayNdjsonInto(ndjson, target),
    /Export table digest does not match for board_vtwo_claims/);
  assert.ok(!target.db.prepare("SELECT 1 FROM rooms LIMIT 1").get(), "failed replay leaves the store empty");
});

test("tamper retention at the operator door: the tampered populated backup is HTTP 422 restore_verification_failed", async t => {
  const ndjson = legacyBackup(seedExport(t), { tamperTable: "guest_link_exchanges" });
  const target = openStore(t, "restore-4975-tampered-http-");
  const headers = new Headers({ "content-type": "application/x-ndjson", authorization: `Bearer ${OPERATOR_TOKEN}` });
  const response = await operatorRestoreResponse(
    { method: "POST", url: "https://room.example/api/operator/restore", headers, text: async () => ndjson },
    OPERATOR_TOKEN, target);
  assert.equal(response.status, 422);
  const payload = await response.json();
  assert.equal(payload.error.code, "restore_verification_failed");
  assert.match(payload.error.message, /Export table digest does not match for guest_link_exchanges/);
});

test("tamper retention: dropping a pinned retired row (count mismatch) still refuses the restore", t => {
  const base = legacyBackup(seedExport(t));
  const dropped = base.split("\n").filter(line => !line.includes('"table":"analytics_firsts"')).join("\n");
  const target = openStore(t, "restore-4975-dropped-");
  assert.throws(() => replayNdjsonInto(dropped, target),
    /Export trailer pins table analytics_firsts but the export holds no rows for it|digest does not match for analytics_firsts/);
});
