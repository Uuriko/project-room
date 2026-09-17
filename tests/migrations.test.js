// H001: schema migration framework. Pure runner tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { migrate, rollback, verifyMigrations, checksumOf, MigrationError } from "../server/migrations.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof MigrationError && error.code === code);
const migrations = (calls = []) => [
  { version: 1, name: "create rooms", checksum: checksumOf("v1"), up: () => calls.push("up1"), down: () => calls.push("down1") },
  { version: 2, name: "add index", checksum: checksumOf("v2"), up: () => calls.push("up2"), down: () => calls.push("down2") },
];

test("migrate applies pending migrations in order and records the journal", () => {
  const calls = [], journal = [];
  const result = migrate(migrations(calls), journal, {});
  assert.deepEqual(calls, ["up1", "up2"]);
  assert.equal(journal.length, 2);
  assert.equal(result.applied.length, 2);
  assert.equal(result.applied[0].version, 1);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.journal));
  // Idempotent: second run applies nothing.
  const again = migrate(migrations(calls), journal, {});
  assert.deepEqual(calls, ["up1", "up2"]);
  assert.equal(again.applied.length, 0);
});
test("rollback runs the latest down and pops the journal", () => {
  const calls = [], journal = [];
  migrate(migrations(calls), journal, {});
  const rolled = rollback(migrations(calls), journal, {});
  assert.deepEqual(calls, ["up1", "up2", "down2"]);
  assert.equal(rolled.rolledBack, 2);
  assert.equal(journal.length, 1);
});
test("ordering and checksum tampering are refused", () => {
  throwsCode(() => verifyMigrations([{ version: 1, name: "a", checksum: checksumOf("a"), up: () => {} },
    { version: 1, name: "b", checksum: checksumOf("b"), up: () => {} }], []), "invalid_migration");
  const journal = [];
  migrate(migrations(), journal, {});
  const tampered = [{ ...migrations()[0], checksum: checksumOf("evil") }, migrations()[1]];
  throwsCode(() => verifyMigrations(tampered, journal), "invalid_migration");
  throwsCode(() => migrate(migrations(), null, {}), "invalid_migration");
  throwsCode(() => migrate("nope", [], {}), "invalid_migration");
  throwsCode(() => rollback(migrations(), [], {}), "invalid_migration");
});
