// Unit tests for scripts/bounty-conservation-check.mjs.
//
// Authoring gate (test-audit SKILL.md):
// 1. Contract: the script's CLI surface the bounty-conservation-watch cron
//    depends on — exit codes (0 clean / 1 violations / 2 environment error),
//    the machine-readable JSON violation report, and the read-only guarantee
//    (no write locks, no file mutation on production data).
// 2. Credible regression: a script edit that swallows violations, changes an
//    exit code, breaks the JSON shape, or starts taking write locks would
//    silently disable paging or corrupt the checked database.
// 3. Existing coverage: the 10+ bounty-escrow test files exercise
//    verifyConservation as a library call; nothing covers the script's CLI
//    contract or its read-only open. This is the cron integration boundary.
// 4. No production seam: the test drives the real script as a child process
//    against real SQLite fixture files built through the real BountyEscrow
//    API. No test-only exports, no doubles.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, statSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, bountyEscrowSchema } from "../server/bounty-escrow.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "scripts", "bounty-conservation-check.mjs");
const ROOM = "room-check";
const ROOMS_DDL = "CREATE TABLE rooms (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, projection TEXT NOT NULL, archived_at TEXT)";

function scratchDir() {
  // TMPDIR must be the worktree .tmp/, never the shared /tmp tmpfs
  // (repo AGENTS.md: /tmp is near-full and reaped by other agents).
  return mkdtempSync(join(process.env.TMPDIR || tmpdir(), "bcc-test-"));
}

// Build a fixture room DB through the real escrow API: genesis, then one
// posted + funded bounty (so the journal carries non-genesis rows). When
// corrupt=true, tamper one non-genesis row's amount so the global journal sum
// no longer matches the genesis mint — a real conservation break.
function buildFixture(dir, { corrupt = false, withRooms = true, withEscrow = true } = {}) {
  const path = join(dir, corrupt ? "corrupt.sqlite" : "clean.sqlite");
  const db = new DatabaseSync(path);
  if (withRooms) {
    db.exec(ROOMS_DDL);
    db.prepare("INSERT INTO rooms (id, sequence, projection, archived_at) VALUES (?,?,?,NULL)")
      .run(ROOM, 0, "{}");
  }
  if (withEscrow) {
    db.exec(bountyEscrowSchema);
    const transaction = fn => fn();
    const store = { db, transaction, readTransaction: transaction };
    const escrow = new BountyEscrow(store, { now: () => Date.now(), allowLegacyStringLanes: true });
    escrow.ensureGenesis(ROOM);
    const { bounty } = escrow.postBounty(ROOM, {
      poster: "id:agent/jill", title: "T", criteria: "C", amount: 10,
      deadline: new Date(Date.now() + 3_600_000).toISOString(),
    });
    escrow.fundBounty(ROOM, bounty.bountyId, { funder: "id:agent/jill" });
    if (corrupt) {
      db.prepare(`UPDATE bounty_journal SET amount = amount + 1
        WHERE seq = (SELECT MIN(seq) FROM bounty_journal WHERE kind != 'genesis')`).run();
    }
  }
  db.close();
  return path;
}

function runScript(args, { env = process.env } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
}

function parseReport(proc) {
  return JSON.parse(proc.stdout);
}

test("clean fixture: exit 0, ok report covering the room", () => {
  const dir = scratchDir();
  const db = buildFixture(dir);
  const proc = runScript(["--db", db]);
  assert.equal(proc.status, 0, `stderr: ${proc.stderr}`);
  const report = parseReport(proc);
  assert.equal(report.tool, "bounty-conservation-check");
  assert.equal(report.ok, true);
  assert.equal(report.roomsChecked, 1);
  assert.deepEqual(report.violations, []);
  assert.equal(report.rooms[0].roomId, ROOM);
  assert.equal(report.rooms[0].ok, true);
});

test("corrupt chain: exit 1 with a machine-readable violation report", () => {
  const dir = scratchDir();
  const db = buildFixture(dir, { corrupt: true });
  const proc = runScript(["--db", db]);
  assert.equal(proc.status, 1, `stderr: ${proc.stderr}`);
  const report = parseReport(proc);
  assert.equal(report.ok, false);
  assert.ok(report.violations.length >= 1, "expected at least one violation");
  assert.ok(report.violations.every(v => v.roomId === ROOM && typeof v.violation === "string"),
    "violations must be {roomId, violation} records");
  assert.ok(report.violations.some(v => v.violation.includes("global sum")),
    `expected a global-sum violation, got: ${JSON.stringify(report.violations)}`);
  assert.equal(report.rooms[0].ok, false);
});

test("read-only guarantee: the check mutates neither the file nor its directory", () => {
  const dir = scratchDir();
  const db = buildFixture(dir, { corrupt: true });
  const before = statSync(db);
  const beforeFiles = new Set(readdirSync(dir));
  const proc = runScript(["--db", db]);
  assert.equal(proc.status, 1);
  const after = statSync(db);
  assert.equal(after.size, before.size, "database file size changed");
  assert.equal(after.mtimeMs, before.mtimeMs, "database file mtime changed");
  const sidecars = readdirSync(dir).filter(f => !beforeFiles.has(f));
  assert.deepEqual(sidecars, [], `sidecar files created: ${sidecars.join(", ")}`);
  assert.ok(!existsSync(`${db}-wal`) && !existsSync(`${db}-journal`), "journal sidecar leaked");
});

test("missing database file: exit 2", () => {
  const proc = runScript(["--db", join(scratchDir(), "nope.sqlite")]);
  assert.equal(proc.status, 2, `stdout: ${proc.stdout}`);
  assert.match(proc.stderr, /database not found/);
});

test("no --db and no ROOM_DB: exit 2", () => {
  const env = { ...process.env, ROOM_DB: "" };
  const proc = runScript([], { env });
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /no database path/);
});

test("database without escrow schema: exit 2, not a violation", () => {
  const dir = scratchDir();
  const db = buildFixture(dir, { withEscrow: false });
  const proc = runScript(["--db", db]);
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /schema absent/);
});

test("database without rooms table: exit 2", () => {
  const dir = scratchDir();
  const db = buildFixture(dir, { withRooms: false });
  const proc = runScript(["--db", db]);
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /not a room database/);
});

test("ROOM_DB env fallback is honored", () => {
  const dir = scratchDir();
  const db = buildFixture(dir);
  const env = { ...process.env, ROOM_DB: db };
  const proc = runScript([], { env });
  assert.equal(proc.status, 0, `stderr: ${proc.stderr}`);
  assert.equal(parseReport(proc).ok, true);
});
