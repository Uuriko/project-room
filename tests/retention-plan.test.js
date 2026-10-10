// Deletion-script fixture tests (200-hard-tasks #176).
//
// Contract under test (owner boundary: scripts/retention-plan.mjs over
// server/retention-run.mjs):
//   - dry-run (default) deletes nothing and reports the eligible count;
//   - --apply deletes exactly the rows older than the table's policy and
//     keeps fresh rows and the exact-cutoff boundary row;
//   - the receipt names the excluded categories (events, commands, security
//     audit rows, invitations, activity, webhook deliveries) — they are never
//     in the plan;
//   - the script refuses a database without the disposable-log table.
//
// (1) Observable behavior: the operator CLI's plan/apply semantics.
// (2) Credible regression: an off-by-one cutoff, a dry-run that deletes, or
// a schema change that silently widens the deletion surface.
// (3) Existing coverage (tests/audit-retention.test.js,
// tests/analytics-retention.test.js) tests the planners, never the CLI or a
// real sqlite fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "retention-plan.mjs");
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-07T12:00:00.000Z");

function fixtureDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "retention-plan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "room.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE web_fetch_log (request_id TEXT PRIMARY KEY, created_at INTEGER)");
  const insert = db.prepare("INSERT INTO web_fetch_log (request_id, created_at) VALUES (?, ?)");
  insert.run("old-1", NOW - 31 * DAY);
  insert.run("old-2", NOW - 90 * DAY);
  insert.run("fresh-1", NOW - 1 * DAY);
  insert.run("boundary", NOW - 30 * DAY); // exactly at the cutoff: kept (<, not <=)
  db.close();
  return path;
}
function count(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT request_id FROM web_fetch_log ORDER BY request_id").all().map(r => r.request_id);
  } finally { db.close(); }
}
function run(args, env = {}) {
  const out = execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return JSON.parse(out);
}

test("dry-run deletes nothing and reports the eligible count", t => {
  const path = fixtureDb(t);
  const receipt = run(["--db", path, "--now", new Date(NOW).toISOString()]);
  assert.equal(receipt.dryRun, true);
  assert.equal(receipt.deleted, 0);
  assert.equal(receipt.table, "web_fetch_log");
  assert.deepEqual(count(path), ["boundary", "fresh-1", "old-1", "old-2"]);
  assert.equal(receipt.categories["web_fetch_log"].eligible, 2);
});

test("--apply deletes exactly the expired rows and keeps fresh + boundary rows", t => {
  const path = fixtureDb(t);
  const receipt = run(
    ["--db", path, "--apply", "--now", new Date(NOW).toISOString()],
    { ROOM_RETENTION_ALLOW_DELETION: "1" },
  );
  assert.equal(receipt.dryRun, false);
  assert.equal(receipt.deleted, 2);
  assert.deepEqual(count(path), ["boundary", "fresh-1"]);
});

test("the receipt names the excluded categories that are never in the plan", t => {
  const path = fixtureDb(t);
  const receipt = run(["--db", path, "--now", new Date(NOW).toISOString()]);
  for (const excluded of ["events", "commands", "account_access_events", "activity_events", "agent_webhook_deliveries"]) {
    assert.ok(receipt.excluded.includes(excluded), `${excluded} must be listed as excluded`);
  }
});

test("the script refuses a database without the disposable-log table", t => {
  const dir = mkdtempSync(join(tmpdir(), "retention-plan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "other.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE something_else (id INTEGER)");
  db.close();
  assert.throws(
    () => run(["--db", path]),
    err => err.status === 1 && /not a recognized room database/.test(String(err.stderr ?? "") + String(err.stdout ?? "") + String(err.message ?? "")),
  );
});
