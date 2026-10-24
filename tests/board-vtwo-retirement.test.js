// #3997: the retired board-v2 durable registry (board_vtwo_claims,
// board_vtwo_events, board_vtwo_mirror, board_vtwo_idempotency) is removed.
// Board v2's routes have answered 410 since the work-claims board succeeded
// it; no module reads these tables. Removal follows the retired-table
// precedent (RETIRED_EMISSARY_TABLES, RETIRED_OPERATOR_TABLES):
// - fresh stores no longer create the tables;
// - upgraded databases keep theirs (no DROP, data preservation) and the
//   recovery audit still accepts them;
// - every restore path skips their rows in an export and reports the counts
//   (REPLAY_SKIPPED_TABLES), so a pre-removal backup — whose trailer v2 pins
//   the board tables' content digests — still restores into a fresh store.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { auditRecovery } from "../server/recovery.mjs";
import { exportNdjsonText, replayNdjson } from "../server/room-export.mjs";
import { replayNdjsonInto } from "../server/restore-ndjson.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const BOARD_VTWO_TABLES = ["board_vtwo_claims", "board_vtwo_events", "board_vtwo_mirror", "board_vtwo_idempotency"];

// The exact DDL server/store.mjs applied at every boot before the removal.
const LEGACY_BOARD_V2_DDL = `
  CREATE TABLE IF NOT EXISTS board_vtwo_claims (
    task_id     TEXT PRIMARY KEY,
    lane        TEXT NOT NULL,
    files       TEXT NOT NULL,
    lease       TEXT NOT NULL,
    lease_h     INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    state       TEXT NOT NULL,
    claim_seq   INTEGER NOT NULL,
    claim_at    TEXT NOT NULL,
    heartbeat_at TEXT,
    last_seq    INTEGER NOT NULL,
    receipts    TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS board_vtwo_events (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL,
    kind      TEXT NOT NULL,
    task_id   TEXT,
    lane      TEXT,
    payload   TEXT NOT NULL,
    supersedes INTEGER,
    idempotency_key TEXT,
    mirror_issue   INTEGER,
    mirror_comment INTEGER
  );
  CREATE TABLE IF NOT EXISTS board_vtwo_mirror (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    current_issue  INTEGER NOT NULL,
    issues         TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS board_vtwo_idempotency (
    scoped_key TEXT PRIMARY KEY,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`;

// One row per board table, in DDL column order — the shape a pre-removal
// exporter yielded for a database the board once ran in.
const LEGACY_ROWS = {
  board_vtwo_claims: { task_id: "legacy-claim", lane: "legacy-lane", files: "[]", lease: "lease=6h", lease_h: 6, reason: "legacy fixture", state: "claimed", claim_seq: 1, claim_at: "2026-01-01T00:00:00.000Z", heartbeat_at: "2026-01-01T00:00:00.000Z", last_seq: 0, receipts: "[]" },
  board_vtwo_events: { seq: 1, at: "2026-01-01T00:00:00.000Z", kind: "claim.created", task_id: "legacy-claim", lane: "legacy-lane", payload: "{}", supersedes: null, idempotency_key: "legacy-idem", mirror_issue: null, mirror_comment: null },
  board_vtwo_mirror: { id: 1, current_issue: 266, issues: "[266]" },
  board_vtwo_idempotency: { scoped_key: "legacy-scope", status: 200, body: "{}", fingerprint: "legacy-fingerprint", created_at: 1767225600000 }
};

function openStore(t, name) {
  const directory = mkdtempSync(join(tmpdir(), name));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function tableNames(store) {
  return store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
}

// Take a current export of a seeded store and re-shape it into the export a
// pre-removal build would have written for a database carrying board rows:
// the board row lines are present, and the trailer is version 2 pinning the
// board tables' content digests (the #3325 digest is a sha256 over
// `${JSON.stringify(row)}\n` per row, exactly as createTableDigests adds).
function legacyExport(t) {
  const source = openStore(t, "board-vtwo-legacy-");
  source.initialize(initialRoom());
  const key = source.issueAccessKey("commons", "owner");
  source.command(key, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED,
    data: { messageId: randomUUID(), body: "history that must survive the restore" } });
  const lines = exportNdjsonText(source.db).trimEnd().split("\n");
  const trailer = JSON.parse(lines.pop());
  assert.equal(trailer.kind, "trailer");
  const tables = { ...(trailer.tables ?? {}) };
  for (const [table, row] of Object.entries(LEGACY_ROWS)) {
    lines.push(JSON.stringify({ table, row }));
    tables[table] = { rows: 1, sha256: createHash("sha256").update(`${JSON.stringify(row)}\n`).digest("hex") };
  }
  lines.push(JSON.stringify({ ...trailer, version: 2, tables }));
  return lines.join("\n") + "\n";
}

test("a fresh store does not create the retired board_vtwo_* tables", t => {
  const store = openStore(t, "board-vtwo-fresh-");
  const names = tableNames(store);
  for (const table of BOARD_VTWO_TABLES) assert.ok(!names.includes(table), `${table} must not be created`);
  assert.doesNotThrow(() => auditRecovery(store), "the recovery audit passes without the retired tables");
});

test("an upgraded database keeps its board_vtwo_* tables and still passes the recovery audit", t => {
  const store = openStore(t, "board-vtwo-upgraded-");
  store.db.exec(LEGACY_BOARD_V2_DDL);
  store.db.prepare(`INSERT INTO board_vtwo_claims(task_id,lane,files,lease,lease_h,reason,state,claim_seq,claim_at,heartbeat_at,last_seq,receipts)
    VALUES('legacy-claim','legacy-lane','[]','lease=6h',6,'legacy fixture','claimed',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',0,'[]')`).run();
  assert.doesNotThrow(() => auditRecovery(store),
    "a database carrying the retired tables must not fail the recovery audit");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM board_vtwo_claims").get().n, 1,
    "no DROP: the upgraded database's rows are preserved");
});

test("a pre-removal backup restores into a fresh store: board rows are skipped and reported, never loaded", t => {
  const ndjson = legacyExport(t);
  const target = openStore(t, "board-vtwo-restore-");
  const result = replayNdjsonInto(ndjson, target);
  assert.equal(result.verified, true);
  for (const table of BOARD_VTWO_TABLES) assert.equal(result.skippedTables[table], 1, `${table} rows are reported skipped`);
  const names = tableNames(target);
  for (const table of BOARD_VTWO_TABLES) assert.ok(!names.includes(table), `${table} is not recreated by the restore`);
  assert.ok(target.db.prepare("SELECT body FROM events WHERE body LIKE '%history that must survive the restore%'").get(),
    "the rest of the backup still lands");
});

test("the file replay path skips board rows from a pre-removal backup the same way", t => {
  const ndjson = legacyExport(t);
  const directory = mkdtempSync(join(tmpdir(), "board-vtwo-replay-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, "restored.sqlite");
  const result = replayNdjson(ndjson, filename);
  assert.equal(result.verified, true);
  const store = new RoomStore(filename);
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  const names = tableNames(store);
  for (const table of BOARD_VTWO_TABLES) assert.ok(!names.includes(table), `${table} is not recreated by the replay`);
});
