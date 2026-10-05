// QA slice D-2 attack tests: claim-bond shadow mode (PRs #1466/#1469).
//
// Contracts owned here (nothing else covers them):
// - write confinement: syncShadowJournal never touches any table but its own
//   claim_bond_shadow journal (a future edit adding a ledger/balance write
//   here would silently move real value under the "shadow" banner)
// - hypothetical clarity: every journal row is unambiguously marked as
//   shadow (id prefix + shadow column), so a reader can never mistake a
//   shadow entry for a real bond movement
// - report purity: shadowReport performs no writes at all
//
// Authoring gate: each test names the regression it would catch; all go
// through the exported production functions against a real SQLite file.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  syncShadowJournal,
  shadowReport,
  ensureShadowSchema,
} from "../server/analytics/claim-bond-shadow.mjs";

function fixtureDb(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-shadow-attack-"));
  const dbFile = join(directory, "shadow.sqlite");
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
  // A durable events table in the room shape the sync reads.
  db.exec(`CREATE TABLE events (
    room_id TEXT NOT NULL, sequence INTEGER NOT NULL PRIMARY KEY, body TEXT NOT NULL
  )`);
  // A stand-in for value-bearing tables: if sync ever touches real state,
  // this is what it would corrupt.
  db.exec(`CREATE TABLE balances (agent_id TEXT PRIMARY KEY, millis INTEGER NOT NULL)`);
  db.prepare(`INSERT INTO balances(agent_id, millis) VALUES ('alice', 1000), ('bob', 2000)`).run();
  const addEvent = (seq, action, extra = {}) => {
    const body = JSON.stringify({
      type: "work_claim.updated",
      at: new Date(1700000000000 + seq * 1000).toISOString(),
      data: { workClaim: "RC-1", action, ownerId: "alice", ...extra },
    });
    db.prepare(`INSERT INTO events(room_id, sequence, body) VALUES ('muse-room', ?, ?)`).run(seq, body);
  };
  addEvent(1, "claimed");
  addEvent(2, "state_changed", { claimState: "in_progress" });
  addEvent(3, "lease_expired", { previousOwnerId: "alice", ownerId: null });
  addEvent(4, "claimed", { ownerId: "bob" });
  addEvent(5, "state_changed", { claimState: "done", ownerId: "bob" });
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return db;
}

function snapshot(db) {
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()
    .map(r => r.name);
  const snap = {};
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
    snap[table] = {
      count: rows.length,
      hash: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    };
  }
  return snap;
}

test("syncShadowJournal writes only its own journal table, never real state", t => {
  const db = fixtureDb(t);
  const before = snapshot(db);
  const first = syncShadowJournal(db, { roomId: "muse-room" });
  assert.ok(first.entriesWritten > 0, "the fixture should derive shadow entries");
  const afterFirst = snapshot(db);
  const second = syncShadowJournal(db, { roomId: "muse-room" });
  assert.equal(second.entriesWritten, 0, "re-running is idempotent");
  const afterSecond = snapshot(db);
  for (const table of Object.keys(before)) {
    if (table === "claim_bond_shadow") continue;
    // Regression: a future "shadow" write that touches balances, events, or
    // any other table would silently move or corrupt real room state.
    assert.deepEqual(afterFirst[table], before[table], `table ${table} changed on first sync`);
    assert.deepEqual(afterSecond[table], before[table], `table ${table} changed on second sync`);
  }
  assert.ok(afterFirst.claim_bond_shadow.count > 0, "the journal itself was written");
});

test("every shadow journal row is unambiguously marked hypothetical", t => {
  const db = fixtureDb(t);
  syncShadowJournal(db, { roomId: "muse-room" });
  const rows = db.prepare(`SELECT id, kind, shadow, amount_millis FROM claim_bond_shadow`).all();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    // Regression: if a future edit drops the marker, shadow rows become
    // confusable with real bond movements.
    assert.ok(row.id.startsWith("shadow:"), `row id not marked shadow: ${row.id}`);
    assert.equal(row.shadow, 1, `row ${row.id} lost its shadow flag`);
    assert.ok(["bond-locked", "bond-released", "bond-forfeited", "bond-carried", "flake-recorded"]
      .includes(row.kind), `unknown kind ${row.kind}`);
  }
});

test("shadowReport performs no writes", t => {
  const db = fixtureDb(t);
  ensureShadowSchema(db);
  const before = snapshot(db);
  const report = shadowReport(db, { roomId: "muse-room" });
  assert.equal(typeof report.verdict, "string");
  const after = snapshot(db);
  // Regression: a "read-only" report that writes would corrupt the baseline
  // it claims to measure.
  assert.deepEqual(after, before, "shadowReport must not write");
});
