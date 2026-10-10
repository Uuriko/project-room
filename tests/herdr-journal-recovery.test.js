import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as migration from "../scripts/herdr-migrate.mjs";
const { readJournal, appendJournalEntry } = migration;
const withMigrationLock = (...args) => migration.withMigrationLock(...args);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-journal-recovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "journal.jsonl");
}

test("a torn final journal row leaves inspection available but blocks unsafe writes", t => {
  const path = fixture(t);
  const bytes = '{"seq":1,"kind":"backfill_done"}\n{"seq":2,"kind":';
  writeFileSync(path, bytes);
  const warnings = [];
  const entries = readJournal(path, { warn: message => warnings.push(message) });
  assert.deepEqual(entries, [{ seq: 1, kind: "backfill_done" }]);
  assert.deepEqual(entries.incompleteTail, { line: 2 });
  assert.match(warnings[0], /incomplete final record.*writes.*repair/i);
  assert.throws(() => appendJournalEntry(path, { kind: "backfill_start" }), /repair.*journal/i);
  assert.equal(readFileSync(path, "utf8"), bytes, "inspection and refusal preserve journal evidence");
});

test("malformed interior journal records still fail closed", t => {
  const path = fixture(t);
  writeFileSync(path, '{broken}\n{"seq":2,"kind":"backfill_done"}\n');
  assert.throws(() => readJournal(path), /journal.*line 1/i);
});

test("append preserves a complete final JSON row without a newline and advances its sequence", t => {
  const path = fixture(t);
  writeFileSync(path, '{"seq":5,"kind":"backfill_done"}');
  assert.equal(appendJournalEntry(path, { kind: "migration_cursor" }).seq, 6);
  assert.equal(readJournal(path).length, 2);
});

test("a competing append refuses before reading or changing the journal", t => {
  const path = fixture(t);
  writeFileSync(path, '{"seq":1,"kind":"backfill_done"}\n');
  writeFileSync(`${path}.append.lock`, "other writer");
  assert.throws(() => appendJournalEntry(path, { kind: "backfill_start" }), /journal.*locked/i);
  assert.equal(readJournal(path).length, 1);
  assert.equal(readFileSync(`${path}.append.lock`, "utf8"), "other writer");
});

test("migration lock covers awaited side effects and is released after failure", async t => {
  const path = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started = false;
  const held = withMigrationLock(path, async () => { started = true; await gate; throw new Error("operation failed"); });
  assert.equal(started, true);
  await assert.rejects(withMigrationLock(path, async () => assert.fail("competing operation ran")), /journal.*locked/i);
  release();
  await assert.rejects(held, /operation failed/);
  assert.equal(existsSync(`${path}.lock`), false);
  assert.equal(await withMigrationLock(path, async () => "resumed"), "resumed");
});

test("CLI execute acquires the journal lock before API reads or mutation", t => {
  const path = fixture(t);
  writeFileSync(`${path}.lock`, "operator holds migration");
  const result = spawnSync(process.execPath, ["scripts/herdr-migrate.mjs", "status", "--execute", "--journal", path], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /journal.*locked/i);
  assert.doesNotMatch(result.stderr, /API base not configured/i);
  assert.equal(readFileSync(`${path}.lock`, "utf8"), "operator holds migration");
});


test("CLI validation failure releases its execution lock for the next attempt", t => {
  const path = fixture(t);
  const result = spawnSync(process.execPath, ["scripts/herdr-migrate.mjs", "migrate", "--execute", "--journal", path], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /migrate needs --room/);
  assert.equal(existsSync(`${path}.lock`), false);
});
