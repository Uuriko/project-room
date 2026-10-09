// stale-done-round-boundary.test.js — route-level fail-first test for the
// done-transition round-binding gap (GUILD-01, COORD-300).
//
// OBSERVED FAILURE: POST /work-claims/:id/update with { state: "done" }
// binds the claim round only OPT-IN (#2078). A done prepared against round N,
// retried after release + re-claim (round N+1, same owner) with NO
// expectedClaimedAt/expectedHistoryLength, returns 200 and marks round N+1
// done — the stale-self-retry class E5/D4 fixed for /release (#2088) and
// /reassign (#2262), still open on the finish path.
//
// Drives the REAL route handler (server/work-claim-routes.mjs
// handleWorkClaims) against the in-memory registry — the production code
// path, not a re-implementation. Offline, fixture-backed, additive: the
// strengthened copy is generated at test time into tests/.strengthened/ and
// removed in after(); the candidate fix ships as a patch file, not applied.
//
//   NEGATIVE CONTROL: "stale done without preconditions is refused" FAILS on
//   the current tree (the stale done returns 200) — the test fails when the
//   fix is absent.
//   FIX VALIDATION: the same property PASSES against the strengthened copy
//   (done requires round binding) — the test passes when the fix is present.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as routes from "../../../server/work-claim-routes.mjs";
import * as claims from "../../../server/work-claims.mjs";
import { ServiceError } from "../../../server/service-error.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const { claimHistoryLength } = claims;

const ROOM = "room1";
const ITEM = "task";
const HOLDER = "holder";
const MEMBERS = { [HOLDER]: { id: HOLDER, kind: "agent", active: true, permissions: ["accept_work", "complete_work"] } };
const makeStore = () => ({
  roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }),
  room: () => ({ state: { messages: [] } }),
});
const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { throw new ServiceError(status, code, message); },
  body: async req => req.body,
};

async function call(routesModule, registry, memberId, route, id, body) {
  try {
    return await routesModule.handleWorkClaims({
      req: { method: "POST", body },
      res: {},
      url: new URL("https://room.example/api/rooms/room1/work-claims"),
      store: makeStore(),
      roomId: ROOM,
      auth: { member: { id: memberId, kind: "agent", permissions: MEMBERS[memberId].permissions } },
      workClaimRoute: route,
      workClaimId: id,
      helpers,
      registry,
    });
  } catch (thrown) {
    if (thrown instanceof ServiceError) {
      return { status: thrown.status, value: { error: { code: thrown.code, message: thrown.message } } };
    }
    return { status: 500, thrown, value: null };
  }
}

const snap = (registry, id) => JSON.parse(JSON.stringify(registry.get(ROOM, id)));
const basisOf = item => ({ expectedClaimedAt: item.claimedAt, expectedHistoryLength: claimHistoryLength(item) });

// World: create -> claim (round 1) -> in_progress -> release via /release
// (required round binding) -> claim (round 2) -> in_progress.
async function round2World(routesModule) {
  const registry = routesModule.createWorkClaimRegistry();
  assert.ok([200, 201].includes((await call(routesModule, registry, HOLDER, "create", null, { id: ITEM })).status));
  assert.equal((await call(routesModule, registry, HOLDER, "claim", ITEM, {})).status, 200);
  assert.equal((await call(routesModule, registry, HOLDER, "update", ITEM, { state: "in_progress" })).status, 200);
  const b1 = basisOf(snap(registry, ITEM));
  assert.equal((await call(routesModule, registry, HOLDER, "release", ITEM, { ...b1, reason: "superseded" })).status, 200);
  assert.equal((await call(routesModule, registry, HOLDER, "claim", ITEM, {})).status, 200);
  assert.equal((await call(routesModule, registry, HOLDER, "update", ITEM, { state: "in_progress" })).status, 200);
  const round2 = snap(registry, ITEM);
  assert.notEqual(round2.claimedAt, b1.expectedClaimedAt, "setup: round 2 must differ from round 1");
  return { registry, b1 };
}

// A strengthened copy of the route module with round binding REQUIRED on the
// done transition (the candidate fix). The transform refuses unless the
// anchor occurs exactly once, so source drift fails loudly.
async function loadStrengthenedRouteModule() {
  const srcPath = join(HERE, "..", "..", "..", "server", "work-claim-routes.mjs");
  let source = await readFile(srcPath, "utf8");
  const from = `    if (Object.hasOwn(data, "expectedClaimedAt") || Object.hasOwn(data, "expectedHistoryLength")) {`;
  const to = `    if (data.state === "done" || Object.hasOwn(data, "expectedClaimedAt") || Object.hasOwn(data, "expectedHistoryLength")) {`;
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) throw new Error(`strengthen: anchor occurs ${occurrences} times, expected 1 — source drifted`);
  source = source.replace(from, to);
  // Re-point relative imports: the copy lives 4 levels below the root.
  source = source.replaceAll(`from "../`, `from "../../../../`);
  source = source.replaceAll(`from "./`, `from "../../../../server/`);
  const weakDir = join(HERE, ".strengthened");
  await mkdir(weakDir, { recursive: true });
  const weakPath = join(weakDir, "work-claim-routes-done-round-bound.strengthened.mjs");
  await writeFile(weakPath, source);
  return import(weakPath);
}

after(async () => {
  await rm(join(HERE, ".strengthened"), { recursive: true, force: true });
});

describe("stale done vs round 2 (route level, real handler)", () => {
  it("NEGATIVE CONTROL: a round-1 done without preconditions must not complete round 2", async () => {
    const { registry } = await round2World(routes);
    const before = JSON.stringify(snap(registry, ITEM));
    const stale = await call(routes, registry, HOLDER, "update", ITEM, { state: "done" });
    // Safe behavior: refused (409 work_claim_conflict like the bound paths,
    // or 422 invalid input for the missing basis) — never a silent 200.
    assert.ok([409, 422].includes(stale.status),
      `stale done must be refused, got ${stale.status}`);
    assert.equal(JSON.stringify(snap(registry, ITEM)), before,
      "the refused stale done must leave no partial write");
    assert.equal(snap(registry, ITEM).state, "in_progress",
      "round 2 must still be in_progress");
  });

  it("control: a stale done WITH stale preconditions is refused 409", async () => {
    const { registry, b1 } = await round2World(routes);
    const stale = await call(routes, registry, HOLDER, "update", ITEM, { state: "done", ...b1 });
    assert.equal(stale.status, 409, `stale-basis done must 409, got ${stale.status}`);
    assert.equal(stale.value?.error?.code, "work_claim_conflict");
    assert.equal(snap(registry, ITEM).state, "in_progress");
  });

  it("happy path: a done on a fresh basis still completes", async () => {
    const { registry } = await round2World(routes);
    const fresh = basisOf(snap(registry, ITEM));
    const done = await call(routes, registry, HOLDER, "update", ITEM, { state: "done", ...fresh });
    assert.equal(done.status, 200, `fresh-basis done must 200, got ${done.status}`);
    assert.equal(snap(registry, ITEM).state, "done");
  });
});

describe("fix validation: strengthened copy (done requires round binding)", () => {
  it("the negative control passes against the strengthened module", async () => {
    const fixed = await loadStrengthenedRouteModule();
    const { registry } = await round2World(fixed);
    const before = JSON.stringify(snap(registry, ITEM));
    const stale = await call(fixed, registry, HOLDER, "update", ITEM, { state: "done" });
    assert.ok([409, 422].includes(stale.status),
      `strengthened: stale done must be refused, got ${stale.status}`);
    assert.equal(JSON.stringify(snap(registry, ITEM)), before);
    assert.equal(snap(registry, ITEM).state, "in_progress");
  });

  it("the happy path still works against the strengthened module", async () => {
    const fixed = await loadStrengthenedRouteModule();
    const { registry } = await round2World(fixed);
    const fresh = basisOf(snap(registry, ITEM));
    const done = await call(fixed, registry, HOLDER, "update", ITEM, { state: "done", ...fresh });
    assert.equal(done.status, 200, `strengthened: fresh-basis done must 200, got ${done.status}`);
    assert.equal(snap(registry, ITEM).state, "done");
  });
});
