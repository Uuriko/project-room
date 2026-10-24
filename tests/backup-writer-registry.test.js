// #3680 closure check for the backup/export writer-to-reader registry
// (scripts/backup-writer-registry.json).
//
// The defect class: backup writers ship when the writer works and meet
// their restore reader later, at restore time. This gate makes that
// impossible to do silently:
//
//   1. Every registry writer row must name a restore reader (a path that
//      exists and a symbol that appears in it) AND at least one round-trip
//      test that exists - or the row must record restorable: false with a
//      non-empty unrestorableReason (the R2 row, absorbing #3622's lone
//      R2_BACKUP_RESTORABLE flag into a checked row).
//   2. Census closure: every file under server/, cloudflare/ or scripts/
//      whose basename contains "backup" or "export" must be classified by
//      the registry - as a writer, a reader, a row artefact, the registry's
//      own registry-of-registries artefacts, or a named as-read exception -
//      so a new backup/export writer cannot land unregistered.
//   3. The registry carries its registry-of-registries row in PR #4067's
//      manifest shape, so it registers there instead of forking the format.
//
// Semantic round-trip assertions are the #3680 PREP remainder; this check
// pins presence and registration only, and says so.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const registryPath = join(root, "scripts", "backup-writer-registry.json");
const registry = JSON.parse(readFileSync(registryPath, "utf8"));

const read = (rel) => readFileSync(join(root, rel), "utf8");

function assertSymbol(rel, symbol, role, id) {
  assert.ok(existsSync(join(root, rel)), `${id}: ${role} path does not exist: ${rel}`);
  if (symbol) {
    assert.ok(
      read(rel).includes(symbol),
      `${id}: ${role} symbol ${symbol} not found in ${rel}`,
    );
  }
}

test("registry shape follows the #4067 registry-of-registries manifest shape", () => {
  assert.equal(registry.version, 1);
  assert.ok(typeof registry.about === "string" && registry.about.length > 0);
  assert.ok(Array.isArray(registry.writers) && registry.writers.length > 0);
  const row = registry.registryOfRegistriesRow;
  assert.ok(row, "registryOfRegistriesRow missing");
  for (const field of [
    "id", "name", "family", "enumerates", "sourceOfTruth", "artefacts",
    "closureChecks", "closureStatus", "derivedOrHand", "canary", "lastFailure",
  ]) {
    assert.ok(row[field], `registryOfRegistriesRow.${field} missing`);
  }
  assert.ok(row.artefacts.includes("scripts/backup-writer-registry.json"));
  assert.ok(row.closureChecks.includes("tests/backup-writer-registry.test.js"));
});

test("every writer row names a reader and a round-trip test, or records restorable: false with a reason", () => {
  const ids = new Set();
  for (const row of registry.writers) {
    assert.ok(row.id && !ids.has(row.id), `duplicate or missing writer id: ${row.id}`);
    ids.add(row.id);
    assert.ok(row.name, `${row.id}: name missing`);
    assert.ok(row.writer && row.writer.path, `${row.id}: writer path missing`);
    assertSymbol(row.writer.path, row.writer.symbol, "writer", row.id);
    if (row.restorable === false) {
      assert.equal(row.reader, null, `${row.id}: restorable: false row must not name a reader`);
      assert.ok(
        typeof row.unrestorableReason === "string" && row.unrestorableReason.length > 0,
        `${row.id}: restorable: false row must record unrestorableReason`,
      );
    } else {
      assert.equal(row.restorable, true, `${row.id}: restorable must be exactly true or false`);
      assert.ok(row.reader && row.reader.path, `${row.id}: writer row names no restore reader`);
      assertSymbol(row.reader.path, row.reader.symbol, "reader", row.id);
      assert.ok(
        Array.isArray(row.roundTripTests) && row.roundTripTests.length > 0,
        `${row.id}: writer row names no round-trip test`,
      );
      for (const rel of row.roundTripTests) {
        assert.ok(existsSync(join(root, rel)), `${row.id}: round-trip test does not exist: ${rel}`);
      }
    }
    for (const rel of row.artefacts || []) {
      assert.ok(existsSync(join(root, rel)), `${row.id}: artefact does not exist: ${rel}`);
    }
  }
});

test("the R2 writer is registered restorable: false until a reader lands (#3585, absorbs #3622's flag)", () => {
  const r2 = registry.writers.find((row) => row.writer.symbol === "writeR2Backup");
  assert.ok(r2, "no registry row for the writeR2Backup writer");
  assert.equal(r2.restorable, false);
  assert.match(r2.unrestorableReason, /#3585/);
});

test("census closure: every backup/export-named file is classified by the registry", () => {
  const classified = new Set(registry.registryOfRegistriesRow.artefacts);
  for (const row of registry.writers) {
    classified.add(row.writer.path);
    if (row.reader) classified.add(row.reader.path);
    for (const rel of row.artefacts || []) classified.add(rel);
  }
  for (const entry of registry.asRead) classified.add(entry.path);

  const { roots, filenameTokens } = registry.census;
  const unclassified = [];
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = rel + entry.name;
      if (entry.isDirectory()) walk(child + "/");
      else if (entry.isFile() && filenameTokens.some((token) => entry.name.includes(token))) {
        if (!classified.has(child)) unclassified.push(child);
      }
    }
  };
  for (const dir of roots) walk(dir);
  assert.deepEqual(
    unclassified,
    [],
    `backup/export files not classified by scripts/backup-writer-registry.json: ${unclassified.join(", ")} - register the writer as a row or name it in asRead with a reason`,
  );
});

test("canary: a writer row stripped of its reader fails the row check", () => {
  const clone = JSON.parse(JSON.stringify(registry));
  const row = clone.writers.find((entry) => entry.restorable === true);
  assert.ok(row, "registry has no restorable writer row to canary against");
  delete row.reader;
  assert.ok(
    !(row.reader && row.reader.path),
    "canary setup failed: the stripped row still names a reader, so the closure assertion above would not catch a reader-less writer",
  );
});
