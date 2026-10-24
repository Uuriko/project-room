/**
 * tests/time-constants.test.js
 *
 * Pins the time-constant registry (#3686): every time constant declared in
 * server/ is registered in scripts/time-constants-registry.json with a
 * single semantic role and a boundary behaviour.
 *
 *  - the real tree passes: the registry and the live declarator scan agree
 *    in both directions;
 *  - an unregistered *_MS declaration in a fixture tree fails;
 *  - a stale registry row (no live declaration) fails;
 *  - a row carrying two roles without the multiRole mark fails, and a
 *    marked multi-role row outside the shrink-only multiRoleBaseline
 *    fails — new constants are single-role;
 *  - the registry carries its registry-of-registries row in the #4067
 *    manifest shape (manifestRow), so it registers there without a fork.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkRegistry,
  isTimeConstantName,
  loadRegistry,
  scanServerConstants,
} from "../scripts/time-constants-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixtureRoot(t, files) {
  const root = mkdtempSync(join(tmpdir(), "time-constants-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function rowFor(name, file, extra = {}) {
  return {
    name,
    file,
    line: 1,
    value: "1000",
    unit: "ms",
    roles: ["the one thing this constant means"],
    multiRole: false,
    boundary: "At the value, the thing stops.",
    boundaryVerified: false,
    ...extra,
  };
}

function registryFor(rows, extra = {}) {
  return {
    manifestRow: {
      id: "A9",
      name: "Time-constant registry",
      family: "time-constants",
      enumerates: "Every time constant declared in server/",
      sourceOfTruth: "scripts/time-constants-registry.json",
      artefacts: ["scripts/time-constants-registry.json"],
      closureChecks: ["scripts/time-constants-check.mjs"],
      closureStatus: "closed",
      derivedOrHand: "hand-seeded, census-checked",
      canary: "tests/time-constants.test.js fixture canaries",
      lastFailure: "none recorded",
    },
    multiRoleBaseline: [],
    constants: rows,
    ...extra,
  };
}

test("real tree: every time constant in server/ is registered, no stale rows", () => {
  const registry = loadRegistry(ROOT);
  const found = scanServerConstants(ROOT);
  assert.ok(found.length > 100, `census should find the seeded constants, found ${found.length}`);
  assert.deepEqual(checkRegistry(registry, found), []);
});

test("name pattern: time tokens count, rates and conversions do not", () => {
  assert.equal(isTimeConstantName("WAKEABLE_WINDOW_MS"), true);
  assert.equal(isTimeConstantName("MENTION_TIMEOUT_MS_DEFAULT"), true);
  assert.equal(isTimeConstantName("BOARD_LEASE_HOURS_MIN"), true);
  assert.equal(isTimeConstantName("REF_TTL_SEC"), true);
  assert.equal(isTimeConstantName("PUSH_PER_AGENT_HOUR"), false);
  assert.equal(isTimeConstantName("MS_PER_DAY"), false);
  assert.equal(isTimeConstantName("ISO_SECOND"), false);
  assert.equal(isTimeConstantName("DAY"), false);
  assert.equal(isTimeConstantName("ITEMS"), false);
});

test("unregistered time constant fails", (t) => {
  const root = fixtureRoot(t, {
    "server/widget.mjs": "export const WIDGET_TTL_MS = 1000;\n",
  });
  const found = scanServerConstants(root);
  assert.equal(found.length, 1);
  const problems = checkRegistry(registryFor([]), found);
  assert.ok(problems.some((p) => p.includes("unregistered time constant WIDGET_TTL_MS")), problems.join("\n"));
});

test("registered constant passes; multi-declarator lines are all scanned", (t) => {
  const root = fixtureRoot(t, {
    "server/widget.mjs": "export const A_MS = 1, B_WINDOW_MS = 2;\nconst plain = 3;\n",
  });
  const found = scanServerConstants(root);
  assert.deepEqual(found.map((f) => f.name), ["A_MS", "B_WINDOW_MS"]);
  const registry = registryFor([rowFor("A_MS", "server/widget.mjs"), rowFor("B_WINDOW_MS", "server/widget.mjs")]);
  assert.deepEqual(checkRegistry(registry, found), []);
});

test("stale registry row fails", (t) => {
  const root = fixtureRoot(t, { "server/widget.mjs": "export const A_MS = 1;\n" });
  const found = scanServerConstants(root);
  const registry = registryFor([rowFor("A_MS", "server/widget.mjs"), rowFor("GONE_MS", "server/widget.mjs")]);
  const problems = checkRegistry(registry, found);
  assert.ok(problems.some((p) => p.includes("stale registry row server/widget.mjs::GONE_MS")), problems.join("\n"));
});

test("second role must be marked, and new multi-role rows fail the shrink-only baseline", (t) => {
  const root = fixtureRoot(t, { "server/widget.mjs": "export const A_MS = 1;\n" });
  const found = scanServerConstants(root);
  const unmarked = registryFor([rowFor("A_MS", "server/widget.mjs", { roles: ["one role", "a second role"] })]);
  assert.ok(checkRegistry(unmarked, found).some((p) => p.includes("not marked multiRole")));
  const marked = registryFor([rowFor("A_MS", "server/widget.mjs", { roles: ["one role", "a second role"], multiRole: true })]);
  assert.ok(checkRegistry(marked, found).some((p) => p.includes("multiRoleBaseline")));
  const grandfathered = registryFor(
    [rowFor("A_MS", "server/widget.mjs", { roles: ["one role", "a second role"], multiRole: true })],
    { multiRoleBaseline: ["server/widget.mjs::A_MS"] },
  );
  assert.deepEqual(checkRegistry(grandfathered, found), []);
});

test("row without a boundary behaviour fails; missing manifestRow fails", (t) => {
  const root = fixtureRoot(t, { "server/widget.mjs": "export const A_MS = 1;\n" });
  const found = scanServerConstants(root);
  const noBoundary = registryFor([rowFor("A_MS", "server/widget.mjs", { boundary: "" })]);
  assert.ok(checkRegistry(noBoundary, found).some((p) => p.includes("boundary behaviour")));
  const noManifest = registryFor([rowFor("A_MS", "server/widget.mjs")], { manifestRow: undefined });
  assert.ok(checkRegistry(noManifest, found).some((p) => p.includes("manifestRow")));
});
