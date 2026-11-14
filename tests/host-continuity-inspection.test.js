import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, chmodSync, readFileSync, rmSync, existsSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { inspectRequestJournal, inspectRoomHost } from "../scripts/inspect-room-host.mjs";

function fixture(t, legacy = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "host-inspect-"))), path = join(root, "runs.sqlite");
  chmodSync(root, 0o700);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE request_runs(id TEXT PRIMARY KEY, response TEXT, delivered INTEGER NOT NULL DEFAULT 0${legacy ? "" : ", attempt_id TEXT"})`);
  chmodSync(path, 0o600);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, db };
}
const id = n => `host-${n.toString(16).padStart(64, "0")}`;

test("inspection distinguishes uncertain intent, saved delivery and local acknowledgement without disclosing content or changing bytes", t => {
  const f = fixture(t);
  const add = f.db.prepare("INSERT INTO request_runs VALUES (?,?,?,?)");
  add.run(id(1), null, 0, crypto.randomUUID());
  add.run(id(2), JSON.stringify({ body: "PRIVATE-RESPONSE", token: "PRIVATE-TOKEN" }), 0, crypto.randomUUID());
  add.run(id(3), "PRIVATE-DELIVERED", 1, crypto.randomUUID());
  const before = readFileSync(f.path), out = inspectRoomHost(f.path);
  assert.deepEqual(out.journal.attempts.map(row => row.state), ["outcome_unknown", "saved_awaiting_delivery", "locally_delivered"]);
  assert.deepEqual(out.journal.attempts.map(row => row.next), ["reconcile_original_attempt", "revalidate_saved_delivery", "verify_remote_receipt"]);
  assert.equal(out.remoteState, "not_checked"); assert.equal(out.modelExecution, "not_proven");
  assert.equal(out.executionAuthorized, false); assert.equal(out.host.processOwnership, "not_checked");
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE-|token|body/);
  assert.deepEqual(readFileSync(f.path), before);
});

test("legacy and missing journals are observed without migration or creation; result pages are explicitly bounded", t => {
  const f = fixture(t, true);
  for (let i = 0; i < 4; i++) f.db.prepare("INSERT INTO request_runs VALUES (?,NULL,0)").run(id(i));
  const before = readFileSync(f.path);
  const out = inspectRequestJournal(f.path, { limit: 2 });
  assert.equal(out.sampled, 2); assert.equal(out.truncated, true);
  assert.equal(out.attempts[0].attemptId, null);
  assert.deepEqual(readFileSync(f.path), before);
  const missing = join(f.root, "missing.sqlite");
  assert.equal(inspectRoomHost(missing).journal.state, "missing");
  assert.equal(existsSync(missing), false); assert.equal(existsSync(missing + ".watch"), false);
  assert.throws(() => inspectRequestJournal(f.path, { limit: 201 }), /invalid_limit/);
});

test("an uncommitted writer does not block inspection or expose its tentative result", t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO request_runs(id) VALUES (?)").run(id(1));
  f.db.exec("BEGIN IMMEDIATE");
  f.db.prepare("UPDATE request_runs SET response=?").run("PRIVATE-UNCOMMITTED");
  try { assert.equal(inspectRequestJournal(f.path).attempts[0].state, "outcome_unknown"); }
  finally { f.db.exec("ROLLBACK"); }
});

test("heartbeat recency never establishes process ownership or model execution", t => {
  const f = fixture(t), directory = f.path + ".watch";
  mkdirSync(directory, { mode: 0o700 });
  for (const age of [0, 60000, -60000]) {
    writeFileSync(join(directory, "status.json"), JSON.stringify({ schemaVersion: 1, phase: "running", credentials: "present",
      protocol: "qualified", updatedAt: new Date(Date.now() - age).toISOString(), token: "PRIVATE-TOKEN", modelExecution: "passed" }), { mode: 0o600 });
    const out = inspectRoomHost(f.path);
    assert.equal(out.host.recent, age === 0); assert.equal(out.host.processOwnership, "not_checked");
    assert.equal(out.modelExecution, "not_proven"); assert.equal(out.executionAuthorized, false);
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE-TOKEN|passed/);
  }
});

test("unsafe paths, sidecars and malformed rows fail closed without printing stored data", t => {
  const f = fixture(t), alias = join(f.root, "alias.sqlite");
  symlinkSync(f.path, alias);
  assert.throws(() => inspectRequestJournal(alias), /private_canonical/);
  symlinkSync(f.path, f.path + "-wal");
  assert.throws(() => inspectRequestJournal(f.path), /private_canonical/);
  rmSync(f.path + "-wal");
  chmodSync(f.path, 0o644);
  assert.throws(() => inspectRequestJournal(f.path), /private_canonical/);
  chmodSync(f.path, 0o600);
  f.db.prepare("INSERT INTO request_runs(id) VALUES (?)").run("PRIVATE-TOKEN");
  const result = spawnSync(process.execPath, ["scripts/inspect-room-host.mjs", f.path], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.match(result.stderr, /invalid_journal_record/); assert.doesNotMatch(result.stderr, /PRIVATE-TOKEN/);
});
