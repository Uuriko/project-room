/**
 * tests/registry-manifest.test.js
 *
 * Pins the registry-of-registries (F-26 + F-28, under #3673):
 *  - the real tree passes the meta-census and every HAND-OPEN family
 *    closure (scripts/registry-manifest-check.mjs);
 *  - removing a registry row from a manifest copy makes the census fail
 *    (the acceptance fixture: a registry-shaped artefact with no row is
 *    unregistered, not invisible);
 *  - false-positive canaries pass: a plain feature module and a small
 *    data JSON are not registry-shaped, so the gate must not fail builds
 *    for non-registry artefacts (pitfall F-7);
 *  - per-family fixture canaries: each family check fails on its named
 *    escape shape and passes on the closed shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkManifest,
  familyProblems,
  loadManifest,
  metaCensus,
  walkFiles,
} from "../scripts/registry-manifest-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixtureRoot(t, files) {
  const root = mkdtempSync(join(tmpdir(), "registry-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const bareManifest = (registries) => ({
  version: 1,
  registries,
  gates: [],
  asRead: [],
  metaCensus: {
    filenameTokens: ["allowlist", "catalog", "census", "manifest", "pin", "pinned", "pins", "registry", "baseline", "scope", "scopes", "exclusions", "snapshot", "durations", "quarantine", "thresholds", "listings", "listing"],
    exceptions: [],
  },
});

test("real tree: meta-census finds zero unregistered registries and every row is well-formed", () => {
  const manifest = loadManifest(ROOT);
  const { problems, census } = checkManifest(ROOT, manifest);
  assert.deepEqual(problems, [], problems.join("\n"));
  assert.ok(census.shapeHits > 50, `expected a substantial census, got ${census.shapeHits}`);
});

test("real tree: every HAND-OPEN family closure holds", async () => {
  const manifest = loadManifest(ROOT);
  const { problems } = await familyProblems(ROOT, manifest);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("acceptance fixture: removing a registry row from the manifest fails the census", () => {
  const manifest = loadManifest(ROOT);
  const pruned = JSON.parse(JSON.stringify(manifest));
  pruned.registries = pruned.registries.filter((r) => r.id !== "R13");
  const { uncovered } = metaCensus(ROOT, pruned);
  assert.ok(
    uncovered.some((h) => h.path === "server/purge-registry.mjs"),
    `expected server/purge-registry.mjs to be unregistered after removing R13, got: ${JSON.stringify(uncovered)}`,
  );
  const { problems } = checkManifest(ROOT, pruned);
  assert.ok(problems.some((p) => p.includes("purge-registry")), problems.join("\n"));
});

test("acceptance fixture: removing the meta row fails the census (the manifest registers itself, F-4)", () => {
  const manifest = loadManifest(ROOT);
  const pruned = JSON.parse(JSON.stringify(manifest));
  pruned.registries = pruned.registries.filter((r) => r.id !== "R0");
  const { uncovered } = metaCensus(ROOT, pruned);
  assert.ok(uncovered.some((h) => h.path === "scripts/registry-manifest-check.mjs"), JSON.stringify(uncovered));
});

test("false-positive canaries: non-registry artefacts do not trip the census", (t) => {
  const root = fixtureRoot(t, {
    "server/feature-widget.mjs": "export const widget = 1;\n",
    "server/data-notes.json": JSON.stringify({ a: 1, b: 2 }),
    "docs/plain-guide.md": "# A guide\n",
    "scripts/registry-manifest.json": JSON.stringify(bareManifest([])),
  });
  const manifest = loadManifest(root);
  const { problems, census } = checkManifest(root, manifest, walkFiles(root));
  assert.equal(census.shapeHits, 1, "only the manifest itself is shape-hit (and it covers itself)");
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("census fails on an unregistered registry-shaped artefact", (t) => {
  const root = fixtureRoot(t, {
    "scripts/secret-widget-allowlist.json": JSON.stringify({ rows: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"] }),
    "scripts/registry-manifest.json": JSON.stringify(bareManifest([])),
  });
  const { problems } = checkManifest(root, loadManifest(root), walkFiles(root));
  assert.ok(problems.some((p) => p.includes("secret-widget-allowlist")), problems.join("\n"));
});

test("family R2: duplicate and missing paths.add rows fail; the closed shape passes", async (t) => {
  const row = { id: "R2", artefacts: ["scripts/candidate-runtime-fixture.mjs"], closureChecks: [], exceptions: [] };
  const bad = fixtureRoot(t, {
    "scripts/candidate-runtime-fixture.mjs": "const paths = new Set();\npaths.add(\"server/a.mjs\");\npaths.add(\"server/a.mjs\");\npaths.add(\"server/gone.mjs\");\n",
    "server/a.mjs": "export {};\n",
  });
  const badProblems = (await familyProblems(bad, bareManifest([row]))).problems;
  assert.ok(badProblems.some((p) => p.includes("duplicate paths.add")), badProblems.join("\n"));
  assert.ok(badProblems.some((p) => p.includes("server/gone.mjs")), badProblems.join("\n"));
  const good = fixtureRoot(t, {
    "scripts/candidate-runtime-fixture.mjs": "const paths = new Set();\npaths.add(\"server/a.mjs\");\n",
    "server/a.mjs": "export {};\n",
  });
  assert.deepEqual((await familyProblems(good, bareManifest([row]))).problems, []);
});

test("family R13/R14: a keyed DDL table with no purge row fails; a fenceless DDL table fails", async (t) => {
  const purgeRow = { id: "R13", artefacts: ["server/purge-registry.mjs"], closureChecks: [], exceptions: [] };
  const fenceRow = { id: "R14", artefacts: ["server/writer-fence.mjs"], closureChecks: [], exceptions: [] };
  const root = fixtureRoot(t, {
    "server/purge-registry.mjs": "export const PURGE_TABLES = Object.freeze([{ table: \"rooms\", key: \"room_id\", action: \"delete\", match: {} }]);\n",
    "server/writer-fence.mjs": "export const STORE_SCHEMA_VERSION = 1;\nexport const applicationTables = Object.freeze([\"rooms\"]);\nexport const lazyAdditiveTables = Object.freeze([]);\n",
    "server/store.mjs": "const DDL = `CREATE TABLE rooms (id TEXT PRIMARY KEY);\nCREATE TABLE secret_room_notes (room_id TEXT NOT NULL, body TEXT);`;\n",
  });
  const problems = (await familyProblems(root, bareManifest([purgeRow, fenceRow]))).problems;
  assert.ok(problems.some((p) => p.startsWith("R13 purge:") && p.includes("secret_room_notes")), problems.join("\n"));
  assert.ok(problems.some((p) => p.startsWith("R14 writer-fence:") && p.includes("secret_room_notes")), problems.join("\n"));
});

test("family R23: a cloudflare check on disk but unpinned fails", async (t) => {
  const row = { id: "R23", artefacts: ["cloudflare/package.json"], closureChecks: [], exceptions: [] };
  const root = fixtureRoot(t, {
    "cloudflare/package.json": JSON.stringify({ scripts: { test: "node --test a.check.mjs" } }),
    "cloudflare/a.check.mjs": "import test from 'node:test';\n",
    "cloudflare/orphan.check.mjs": "import test from 'node:test';\n",
  });
  const problems = (await familyProblems(root, bareManifest([row]))).problems;
  assert.ok(problems.some((p) => p.includes("orphan.check.mjs")), problems.join("\n"));
});

test("family R31: a baseline PNG referenced by no capture name fails", async (t) => {
  const row = { id: "R31", artefacts: [], closureChecks: [], exceptions: [{ table: "detector-selftest", reason: "runtime self-test" }] };
  const root = fixtureRoot(t, {
    "scripts/visual-regression-baselines/room-view.png": "png",
    "scripts/visual-regression-baselines/stale-view.png": "png",
    "scripts/visual-regression-browser-check.mjs": "compareScreenshotBuffer(buf, \"room-view\", {});\ncompareScreenshotBuffer(buf, \"detector-selftest\", {});\n",
    "scripts/visual-regression-helper.mjs": "export {};\n",
  });
  const problems = (await familyProblems(root, bareManifest([row]))).problems;
  assert.ok(problems.some((p) => p.includes("stale-view")), problems.join("\n"));
});

test("family R33: a deploy unit on disk but unnamed in the row fails", async (t) => {
  const row = { id: "R33", artefacts: ["deploy/project-room.service"], closureChecks: [], exceptions: [] };
  const root = fixtureRoot(t, {
    "deploy/project-room.service": "[Unit]\n",
    "deploy/project-room-backup.timer": "[Timer]\n",
  });
  const problems = (await familyProblems(root, bareManifest([row]))).problems;
  assert.ok(problems.some((p) => p.includes("project-room-backup.timer")), problems.join("\n"));
});

test("family R18: a stale duration key fails", async (t) => {
  const row = { id: "R18", artefacts: ["scripts/unit-ci-durations.json"], closureChecks: [], exceptions: [], unmeasuredCeiling: 200 };
  const root = fixtureRoot(t, {
    "scripts/unit-ci-durations.json": JSON.stringify({ milliseconds: { "tests/gone.test.js": 10, "tests/live.test.js": 10 } }),
    "scripts/unit-shards.mjs": "export function discoverUnitTests() { return [\"tests/live.test.js\"]; }\n",
    "tests/live.test.js": "import test from 'node:test';\n",
  });
  const problems = (await familyProblems(root, bareManifest([row]))).problems;
  assert.ok(problems.some((p) => p.includes("tests/gone.test.js")), problems.join("\n"));
});

test("family R26: a listings row missing a field fails", async (t) => {
  const row = { id: "R26", artefacts: ["scripts/listings.json"], closureChecks: [], exceptions: [] };
  const root = fixtureRoot(t, {
    "scripts/listings.json": JSON.stringify({ rows: [{ id: "x", title: "X", kind: "api", group: "g", url: "https://example.com", expect: {}, update: "u" }] }),
  });
  const problems = (await familyProblems(root, bareManifest([row]))).problems;
  assert.ok(problems.some((p) => p.includes("owner")), problems.join("\n"));
});

test("family A8: an active secret-scan allowlist entry without a reason fails", async (t) => {
  const row = { id: "A8", artefacts: [".github/secret-scan-allowlist.txt"], closureChecks: [], exceptions: [] };
  const root = fixtureRoot(t, {
    ".github/secret-scan-allowlist.txt": "# header\ntests/fixtures/seeds.txt  # seeded fakes\ndocs/old-notes.md\n",
  });
  const problems = (await familyProblems(root, bareManifest([row]))).problems;
  assert.ok(problems.some((p) => p.includes("docs/old-notes.md")), problems.join("\n"));
});
