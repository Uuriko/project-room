// Registry-closure census gate (T-5 / OPP-015): the in-repo enumeration
// must match the shrink-only baseline exactly — a new unverified registry
// fails, and a baseline entry that becomes pinned must leave the baseline.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { censusProblems, enumerateRegistries, UNVERIFIED_BASELINE } from "../scripts/registry-closure-census.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

test("real tree: no new unverified registries and the baseline is exact", () => {
  const registries = enumerateRegistries(ROOT);
  assert.ok(registries.length > UNVERIFIED_BASELINE.length, "census enumerated a real population");
  assert.deepEqual(censusProblems(registries), []);
  const unverified = registries.filter(r => r.verifiedBy.length === 0).map(r => r.id);
  assert.deepEqual(unverified, [...UNVERIFIED_BASELINE],
    "unverified set drifted from the pinned baseline (order is by id in both)");
});

test("writer-fence and purge registries are pinned (first closure subject)", () => {
  const registries = new Map(enumerateRegistries(ROOT).map(r => [r.id, r]));
  for (const id of ["server/writer-fence.mjs#applicationTables",
    "server/writer-fence.mjs#unfencedAdditiveTables",
    "server/purge-registry.mjs#PURGE_TABLES"]) {
    const registry = registries.get(id);
    assert.ok(registry, `${id} enumerated`);
    assert.ok(registry.verifiedBy.length > 0, `${id} pinned by a test/check reference: ${registry.verifiedBy.join(", ")}`);
  }
});

function fixtureRoot(withPin) {
  const dir = mkdtempSync(join(tmpdir(), "registry-census-canary-"));
  mkdirSync(join(dir, "server"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "server", "fixture.mjs"),
    "export const FIXTURE_REGISTRY = Object.freeze([\"alpha\", \"beta\"]);\n");
  if (withPin) {
    writeFileSync(join(dir, "tests", "fixture.test.js"),
      "// pins FIXTURE_REGISTRY membership\nimport {} from \"../server/fixture.mjs\";\nvoid FIXTURE_REGISTRY;\n");
  }
  return dir;
}

test("canary: a fixture registry with no verifier fails the census", () => {
  const dir = fixtureRoot(false);
  try {
    const registries = enumerateRegistries(dir);
    assert.equal(registries.length, 1);
    const problems = censusProblems(registries, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /new unverified registry: server\/fixture\.mjs#FIXTURE_REGISTRY/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("canary passes once a test file pins the fixture registry", () => {
  const dir = fixtureRoot(true);
  try {
    const registries = enumerateRegistries(dir);
    assert.deepEqual(censusProblems(registries, []), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a baseline entry that is no longer unverified is stale and fails", () => {
  const dir = fixtureRoot(true);
  try {
    const registries = enumerateRegistries(dir);
    const problems = censusProblems(registries, ["server/fixture.mjs#FIXTURE_REGISTRY"]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /stale baseline entry/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
