// PR-0 registry for the #3676 / #3677 conformance harness family.
//
// Completeness ONLY: a surface that exists in any inventory source but
// is missing from the conformance inventory fails this test. Behavioural
// conformance (the #3676 replay matrix, the #3677 mutation-walk
// properties) is PR-1 / PR-2 and is deliberately not asserted here.
//
// The inventory is built live by scripts/conformance-census.mjs and
// compared against the same sources the census reads, derived
// independently in this file; the committed artifact
// tests/fixtures/conformance-inventory.json must agree with the live
// build in both directions (no stale rows, no missing rows).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConformanceInventory, MUTATING_METHODS } from "../scripts/conformance-census.mjs";
import { extractLegacyRoutes, loadRouteSources, templateKey } from "../scripts/routes-inventory.mjs";
import { openapiOperations } from "../scripts/open-routes.mjs";
import { ROUTES } from "../server/routes/table.mjs";
import { UNIFY_R_STREAMS } from "../server/read-cursor.mjs";
import { createConformanceFixture, CONFORMANCE_FIXTURE } from "./helpers/conformance-fixture.mjs";
import {
  createSeededRng, generateInterleaving, runInterleaving,
  SUBMIT_DUPLICATE_OPS, MUTATION_WALK_OPS,
} from "./helpers/seeded-interleaving.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const httpKey = (method, path) => `${method} ${templateKey(path)}`;

let inventoryPromise;
const getInventory = () => (inventoryPromise ??= buildConformanceInventory(root));

test("conformance inventory: every route-table row is present", async () => {
  const inventory = await getInventory();
  const byKey = new Map(inventory.rows.filter(r => r.kind === "http").map(r => [httpKey(r.method, r.path), r]));
  const byRouteId = new Map(inventory.rows.filter(r => r.routeId).map(r => [r.routeId, r]));
  for (const route of ROUTES) {
    const row = byRouteId.get(route.id) ?? byKey.get(httpKey(route.method, route.path));
    assert.ok(row, `route-table row missing from inventory: ${route.id} (${route.method} ${route.path})`);
    assert.ok(row.sources.includes("route-table"), `route ${route.id} lacks route-table source`);
    // Both issues' columns are present on every row (shape, not values).
    assert.ok(row.idempotency && "keyPlacement" in row.idempotency && "runOnceClass" in row.idempotency,
      `route ${route.id} row lacks idempotency columns`);
    assert.ok(row.walk && "cursorShape" in row.walk && "ackSemantics" in row.walk,
      `route ${route.id} row lacks walk columns`);
  }
});

test("conformance inventory: every legacy mutating route is present", async () => {
  const inventory = await getInventory();
  const keys = new Set(inventory.rows.filter(r => r.kind === "http").map(r => httpKey(r.method, r.path)));
  const legacy = extractLegacyRoutes(loadRouteSources(root)).filter(r => MUTATING_METHODS.includes(r.method));
  assert.ok(legacy.length > 0, "legacy extractor found no mutating routes — extractor broken?");
  for (const route of legacy) {
    assert.ok(keys.has(httpKey(route.method, route.path)),
      `legacy mutating route missing from inventory: ${route.method} ${route.path}`);
  }
});

test("conformance inventory: every OpenAPI mutating operation is present", async () => {
  const inventory = await getInventory();
  const keys = new Set(inventory.rows.filter(r => r.kind === "http").map(r => httpKey(r.method, r.path)));
  const ops = openapiOperations(readFileSync(join(root, "docs", "openapi.yaml"), "utf8"))
    .filter(op => MUTATING_METHODS.includes(op.method));
  assert.ok(ops.length > 0, "openapi parser found no mutating operations — parser broken?");
  for (const op of ops) {
    assert.ok(keys.has(httpKey(op.method, op.path)),
      `OpenAPI mutating operation missing from inventory: ${op.method} ${op.path}`);
  }
});

test("conformance inventory: every MCP catalog tool is present", async () => {
  const inventory = await getInventory();
  const snapshot = JSON.parse(readFileSync(join(root, "tests", "fixtures", "mcp-catalog.snapshot.json"), "utf8"));
  const tools = new Map();
  for (const profile of Object.values(snapshot)) {
    for (const [name, entry] of Object.entries(profile)) if (!tools.has(name)) tools.set(name, entry.annotations);
  }
  const bySurface = new Map(inventory.rows.map(r => [r.surface, r]));
  assert.ok(tools.size > 0, "MCP snapshot is empty — snapshot broken?");
  for (const [name, annotations] of tools) {
    const row = bySurface.get(`mcp:${name}`);
    assert.ok(row, `MCP tool missing from inventory: ${name}`);
    if (annotations && annotations.readOnlyHint === false) {
      assert.equal(row.mutating, true, `mutating MCP tool not marked mutating: ${name}`);
    }
  }
});

test("conformance inventory: walk census covers every nextCursor file and UNIFY-R stream", async () => {
  const inventory = await getInventory();
  const walkModules = new Set(inventory.walkFiles.map(f => f.module));
  for (const fact of inventory.serverFileFacts) {
    if (fact.mentionsNextCursor) {
      assert.ok(walkModules.has(fact.module), `nextCursor file missing from walk census: ${fact.module}`);
    }
  }
  const surfaces = new Set(inventory.rows.map(r => r.surface));
  for (const stream of UNIFY_R_STREAMS) {
    assert.ok(surfaces.has(`stream:${stream}`), `UNIFY-R stream missing from inventory: ${stream}`);
  }
  // PREP §B.1 hand-verified seeds.
  assert.ok(walkModules.has("server/inbox.mjs"), "inbox walk missing from walk census");
  assert.ok(walkModules.has("server/conversation-sync.mjs"), "conversation-sync walk missing from walk census");
});

test("conformance inventory: runOnce adoption census names exactly the real importers", async () => {
  const inventory = await getInventory();
  assert.deepEqual(inventory.counts.runOnceAdopters.sort(),
    ["server/attention.mjs", "server/buyer-signoff.mjs"]);
});

test("conformance inventory: PR-1/PR-2 starter surfaces are present", async () => {
  const inventory = await getInventory();
  const byRouteId = new Map(inventory.rows.filter(r => r.routeId).map(r => [r.routeId, r]));
  for (const id of ["work-claim-close", "work-claim-cancel", "issue-spend-grant"]) {
    assert.ok(byRouteId.has(id), `starter route missing from inventory: ${id}`);
  }
  assert.equal(byRouteId.get("issue-spend-grant").idempotency.moneyFlag, true,
    "spend-grant issue row must carry the money flag");
});

test("conformance inventory: committed artifact agrees with the live build", async () => {
  const inventory = await getInventory();
  const artifact = JSON.parse(readFileSync(join(root, "tests", "fixtures", "conformance-inventory.json"), "utf8"));
  const liveSurfaces = new Set(inventory.rows.map(r => r.surface));
  const artifactSurfaces = new Set(artifact.rows.map(r => r.surface));
  for (const surface of artifactSurfaces) {
    assert.ok(liveSurfaces.has(surface), `artifact row no longer exists live (stale artifact): ${surface}`);
  }
  for (const surface of liveSurfaces) {
    assert.ok(artifactSurfaces.has(surface),
      `surface missing from committed artifact — regenerate: node scripts/conformance-census.mjs --json tests/fixtures/conformance-inventory.json (${surface})`);
  }
  const liveWalk = new Set(inventory.walkFiles.map(f => f.module));
  for (const file of artifact.walkFiles) {
    assert.ok(liveWalk.has(file.module), `artifact walk file no longer exists live: ${file.module}`);
  }
});

test("conformance fixture: boots a seeded on-disk store in TMPDIR scratch and reopens it", t => {
  const fx = createConformanceFixture(t);
  assert.equal(fx.fixture.roomId, CONFORMANCE_FIXTURE.roomId);
  const members = fx.db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE room_id = ? AND json_extract(body, '$.type') = 'member.added'"
  ).get(fx.fixture.roomId).n;
  assert.ok(members >= 4, `expected owner + seeded actor/member events, got ${members} member.added events`);
  const actor = fx.db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE json_extract(body, '$.type') = 'member.added' AND json_extract(body, '$.data.memberId') = ?"
  ).get(fx.fixture.actorId).n;
  assert.equal(actor, 1, "seeded actor must be a room member");
  fx.reopen();
  const after = fx.db.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE json_extract(body, '$.type') = 'member.added' AND json_extract(body, '$.data.memberId') = ?"
  ).get(fx.fixture.memberId).n;
  assert.equal(after, 1, "seeded member must survive a store reopen (on-disk, not :memory:)");
});

test("seeded interleaving: deterministic per seed, seed carried on failure, both op sets usable", () => {
  const a = generateInterleaving({ seed: 4242, count: 24, ops: MUTATION_WALK_OPS });
  const b = generateInterleaving({ seed: 4242, count: 24, ops: MUTATION_WALK_OPS });
  assert.deepEqual(a, b, "same seed must reproduce the same trace");
  const c = generateInterleaving({ seed: 4243, count: 24, ops: MUTATION_WALK_OPS });
  assert.notDeepEqual(a.trace, c.trace, "different seeds should produce different traces");
  assert.ok(a.trace.every(step => MUTATION_WALK_OPS.includes(step.op)));

  const dup = generateInterleaving({ seed: "replay-r8", count: 12, ops: SUBMIT_DUPLICATE_OPS });
  assert.ok(dup.trace.every(step => SUBMIT_DUPLICATE_OPS.includes(step.op)));

  // The same machine executes both op sets through handlers.
  let effects = 0;
  runInterleaving({
    seed: dup.seed, trace: dup.trace,
    handlers: Object.fromEntries(SUBMIT_DUPLICATE_OPS.map(op => [op, () => { effects += 1; }])),
  });
  assert.equal(effects, dup.trace.length);

  assert.throws(
    () => runInterleaving({
      seed: 99, trace: [{ index: 0, op: "walkNext" }],
      handlers: { walkNext: () => { throw new Error("boom"); } },
    }),
    err => err.seed === 99 && /seed 99/.test(err.message) && /step 0/.test(err.message),
    "a failing interleaving must name its seed",
  );

  const rng = createSeededRng(7);
  const seq = [rng(), rng(), rng()];
  const rng2 = createSeededRng(7);
  assert.deepEqual(seq, [rng2(), rng2(), rng2()]);
  assert.ok(seq.every(v => v >= 0 && v < 1));
});

test("seeded interleaving generator: no wall-clock sources in its module", () => {
  const source = readFileSync(join(root, "tests", "helpers", "seeded-interleaving.mjs"), "utf8");
  assert.ok(!/Date\.now|performance\.now|setTimeout|setInterval/.test(source),
    "the interleaving generator must not read a wall clock");
});
