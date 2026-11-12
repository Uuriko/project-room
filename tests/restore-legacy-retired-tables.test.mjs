// #4975 completion: a backup taken BEFORE #4975 retired its six tables
// carries a trailer v2 pin over those tables' rows (the exporter of the day
// digested every loadable table). Once the six joined the replay/content-
// digest skip sets, that pin had nothing to verify against and every restore
// path refused a sound, populated legacy backup at contentVerificationLevel
// (HTTP 422 on the operator door). The cure is old-pin digest compatibility:
// the pin is checked against a separate digest computed over the skipped
// tables' rows exactly as the export holds them, while replay still skips
// the tables — nothing is resurrected. These tests pin all three halves:
// the populated legacy backup verifies and restores on every restore path,
// tampering with a non-retired table still refuses, and tampering with a
// retired table's rows still refuses.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  exportNdjsonText, exportTrailer, createTableDigests, replayNdjson,
} from "../server/room-export.mjs";
import { replayNdjsonInto, createBackupReplaySession } from "../server/restore-ndjson.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const RETIRED_4975 = [
  "board_vtwo_claims", "board_vtwo_events", "board_vtwo_idempotency",
  "board_vtwo_mirror", "analytics_firsts", "guest_link_exchanges",
];

// Rows a pre-#4975 store could hold in the retired tables. They are never
// loaded by any restore path; restore only digests and counts them.
const RETIRED_ROWS = {
  board_vtwo_claims: [
    { id: "claim-1", room_id: "commons", title: "legacy claim one", state: "open" },
    { id: "claim-2", room_id: "commons", title: "legacy claim two", state: "done" },
  ],
  board_vtwo_events: [
    { id: "bve-1", room_id: "commons", claim_id: "claim-1", kind: "created" },
  ],
  board_vtwo_idempotency: [
    { key: "idem-1", room_id: "commons", result: "ok" },
  ],
  board_vtwo_mirror: [
    { id: "mirror-1", room_id: "commons", claim_id: "claim-1" },
  ],
  analytics_firsts: [
    { id: "first-1", room_id: "commons", kind: "first_message" },
  ],
  guest_link_exchanges: [
    { id: "exchange-1", room_id: "commons", code: "legacy-code" },
  ],
};

function openStore(t, name) {
  const directory = mkdtempSync(join(tmpdir(), name));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function seedStore(t) {
  const store = openStore(t, "legacy-retired-seed-");
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  store.command(key, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Restore agent", kind: "agent", permissions: ["accept_work"] } });
  store.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "history that must survive the legacy restore" } });
  return store;
}

// Rebuild an export exactly as the pre-#4975 exporter would have written it:
// the current export's lines, the populated retired tables' rows folded in,
// and a trailer whose table pins cover the retired tables too (the pin is
// computed with the same sha256-over-JSON-rows algorithm the exporter uses;
// only the skip set differed back then).
// The exporter's per-table pin: sha256 over `${JSON.stringify(row)}\n` for
// each row in stream order, plus the row count. Written out locally (rather
// than imported from the code under test) so this fixture means the same
// thing on any tree it runs against.
function pinOf(rows) {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${JSON.stringify(row)}\n`);
  return { rows: rows.length, sha256: hash.digest("hex") };
}

function legacyExportText(seeded, { mutate = null } = {}) {
  const digests = createTableDigests();
  const out = [];
  for (const line of exportNdjsonText(seeded.db).split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.kind === "trailer") continue; // rebuilt below over the legacy stream
    if (record.kind === "watermark") { out.push(line); continue; }
    digests.add(record.table, record.row);
    out.push(line);
  }
  for (const [table, rows] of Object.entries(RETIRED_ROWS))
    for (const row of rows) out.push(JSON.stringify({ table, row }));
  if (mutate) mutate(out);
  // The pins describe the ORIGINAL rows: the live-table digests were fed
  // before mutate ran, and the retired pins come from the RETIRED_ROWS
  // constants. A mutate that edits a stream line therefore models exactly
  // a post-export tamper — content the pin does not cover.
  const tables = { ...digests.finish() };
  for (const table of RETIRED_4975) tables[table] = pinOf(RETIRED_ROWS[table]);
  out.push(JSON.stringify(exportTrailer(seeded.db, tables)));
  return out.join("\n") + "\n";
}

function assertRetiredTablesAbsent(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  for (const table of RETIRED_4975) assert.ok(!names.includes(table), `retired table ${table} must not be resurrected`);
}

test("populated legacy backup (pre-#4975 pin over retired tables) restores verified via file replay", t => {
  const seeded = seedStore(t);
  const text = legacyExportText(seeded);
  const directory = mkdtempSync(join(tmpdir(), "legacy-retired-file-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const targetPath = join(directory, "restored.sqlite");
  const result = replayNdjson(text, targetPath);
  assert.equal(result.verified, true);
  assert.equal(result.contentVerification, "full");
  for (const [table, rows] of Object.entries(RETIRED_ROWS))
    assert.equal(result.skippedTables[table], rows.length, `${table} rows counted as skipped`);
  const check = new RoomStore(targetPath);
  t.after(() => { try { check.close(); } catch { /* already closed */ } });
  assert.equal(check.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 1);
  assertRetiredTablesAbsent(check.db);
});

test("populated legacy backup restores verified via the buffered replay (operator request-body path)", t => {
  const seeded = seedStore(t);
  const text = legacyExportText(seeded);
  const target = openStore(t, "legacy-retired-buffered-");
  const result = replayNdjsonInto(text, target);
  assert.equal(result.verified, true);
  assert.equal(result.contentVerification, "full");
  for (const [table, rows] of Object.entries(RETIRED_ROWS))
    assert.equal(result.skippedTables[table], rows.length, `${table} rows counted as skipped`);
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 1);
  assertRetiredTablesAbsent(target.db);
});

test("populated legacy backup restores verified via the streaming replay session (KV path)", t => {
  const seeded = seedStore(t);
  const text = legacyExportText(seeded);
  const target = openStore(t, "legacy-retired-session-");
  const session = createBackupReplaySession(target);
  session.writeText(text);
  const result = session.finish();
  assert.equal(result.verified, true);
  assert.equal(result.contentVerification, "full");
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 1);
  assertRetiredTablesAbsent(target.db);
});

test("negative control: tampering with a non-retired table still refuses the legacy backup", t => {
  const seeded = seedStore(t);
  let done = false;
  const text = legacyExportText(seeded, { mutate: lines => {
    for (let i = 0; i < lines.length; i++) {
      if (done || !lines[i].includes('"table":"credentials"')) continue;
      const record = JSON.parse(lines[i]);
      if (typeof record.row.expires_at !== "number") continue;
      record.row.expires_at += 315576000000; // a year of extra credential life, unpinned
      lines[i] = JSON.stringify(record);
      done = true;
    }
  } });
  assert.ok(done, "fixture export has a credentials row with a numeric expires_at");
  const target = openStore(t, "legacy-retired-tamper-live-");
  assert.throws(() => replayNdjsonInto(text, target), /Export table digest does not match for credentials/);
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0, "no partial restore remains");
});

test("negative control: tampering with a retired table's rows still refuses the legacy backup", t => {
  const seeded = seedStore(t);
  let done = false;
  const text = legacyExportText(seeded, { mutate: lines => {
    for (let i = 0; i < lines.length; i++) {
      if (done || !lines[i].includes('"table":"board_vtwo_claims"')) continue;
      const record = JSON.parse(lines[i]);
      record.row.title = "legacy claim one (quietly rewritten)";
      lines[i] = JSON.stringify(record);
      done = true;
    }
  } });
  assert.ok(done, "fixture export has a board_vtwo_claims row to tamper with");
  const target = openStore(t, "legacy-retired-tamper-retired-");
  assert.throws(() => replayNdjsonInto(text, target), /Export table digest does not match for board_vtwo_claims/);
  assert.equal(target.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0, "no partial restore remains");
});
