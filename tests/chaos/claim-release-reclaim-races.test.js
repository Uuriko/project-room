// claim-release-reclaim-races.test.js — route-level chaos properties for
// release racing re-claim, with round tokens discriminating.
//
// PRODUCT-200 reliability slice C2/50 (CHAOS — CLAIM/RELEASE/RECLAIM RACES).
// Drives the REAL route handler (server/work-claim-routes.mjs handleWorkClaims)
// against the in-memory registry, so the round-token precondition
// (expectedClaimedAt + expectedHistoryLength -> 409 work_claim_conflict on a
// stale basis) is exercised through the production code path, not a
// re-implementation. Companion to claim-lifecycle-races.test.js (P1/P2/P3,
// pure-machine level); this file covers the ROUTE level: N actors racing to
// claim the same work, release racing re-claim, and delayed/stale retries
// arriving mid-race.
//
// CONCURRENCY MODEL: production serializes concurrent HTTP requests into a
// total order of registry transactions (the Durable Object write lock — see
// server/work-claim-routes.mjs: "The read, state transition and write then
// share one transaction"). Each property randomizes over 250 seeded total
// orders. A "delayed retry" is an op carrying the basis captured BEFORE the
// race started — a request prepared from a stale read, arriving mid-race.
//
//   P4: release racing re-claim — round tokens discriminate (deterministic).
//   P5: seeded claim/release/reclaim races with stale-basis retries.
//
// ASSERTIONS (every op, every seed):
//   * exactly-once winners: one claim-200 per unclaimed window; losers get a
//     clean 409 work_claim_conflict — never two active claims, never a 500.
//   * no lost releases: a release-200 leaves the item unclaimed + ownerless.
//   * a stale-basis op (tokens no longer describing the live item) is refused
//     with 409 work_claim_conflict when the actor still owns the item, or
//     403 work_not_owner when they don't — never applied, never a 500.
//   * failed ops leave no partial write (item JSON identical before/after).
//   * the legal-state + history-coherence oracles hold after every op.
//
// FAIL-FIRST: P4/P5 run against a guard-weakened copy of
// server/work-claim-routes.mjs (the stale-basis 409 removed, generated at
// test time into tests/chaos/.weak/, gitignored) and must FAIL — proving the
// properties guard the round-token behavior they name. The weakening
// transform refuses unless its anchor occurs exactly once, so source drift
// fails loudly instead of silently testing nothing.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as routes from "../../server/work-claim-routes.mjs";
import * as claims from "../../server/work-claims.mjs";
import { ServiceError } from "../../server/service-error.mjs";
import {
  mulberry32, pick, shuffle,
  assertLegalItem, assertHistoryCoherent,
  loadWeakenedRouteModule, cleanWeakenedClaimModules,
} from "./claim-race-ops.mjs";

const { claimHistoryLength } = claims;

const SEEDS = 250;
const ROOM = "room1";
const ITEM = "task";
const HOLDER = "holder";
const RIVALS = ["rival-1", "rival-2", "rival-3"];
const AGENTS = [HOLDER, ...RIVALS];

const MEMBERS = Object.fromEntries(AGENTS.map(id => [
  id, { id, kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
]));

const makeStore = () => ({
  roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }),
  room: () => ({ state: { messages: [] } }),
});

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  // Production-faithful: server/http.mjs's reject throws a bodyless
  // ServiceError; the HTTP layer renders the status. handleWorkClaims only
  // converts errors that already carry a body (e.g. the stale-basis
  // refusal); the rest propagate here and are rendered by call() below.
  reject: (status, code, message) => { throw new ServiceError(status, code, message); },
  body: async req => req.body,
};

// One route call. A ServiceError out of handleWorkClaims is a clean
// route-level refusal (the status the HTTP layer would render); anything
// else is the route's generic-500 path and fails the "never 500" oracle.
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
const basisOf = item => ({
  expectedClaimedAt: item.claimedAt,
  expectedHistoryLength: claimHistoryLength(item),
});
const lastNote = item => item.history[item.history.length - 1].note;
const stampActions = item => item.history.map(s => s.action);

function assertNoThrow(seed, opName, res) {
  assert.ok(!res.thrown,
    `seed ${seed}: ${opName} threw (the route 500 path): ${res.thrown?.message}`);
}

function assertCleanRefusal(seed, opName, res, beforeJson, registry) {
  assertNoThrow(seed, opName, res);
  assert.ok([400, 403, 404, 409, 422].includes(res.status),
    `seed ${seed}: ${opName} failed with unexpected status ${res.status}`);
  assert.ok(typeof res.value?.error?.code === "string" && res.value.error.code.length > 0,
    `seed ${seed}: ${opName} refusal carries no error code`);
  assert.equal(JSON.stringify(snap(registry, ITEM)), beforeJson,
    `seed ${seed}: ${opName} failed but left a partial write`);
}

// A token-carrying op whose basis no longer describes the live item must be
// refused — with 409 work_claim_conflict when the actor still owns the item
// (the round tokens discriminate), or 403 work_not_owner when the owner
// check fires first. Either way it is never applied and never a 500.
function assertStaleBasisRefused(seed, opName, res, registry, actor, tokens) {
  const live = snap(registry, ITEM);
  const liveBasis = basisOf(live);
  const stale =
    liveBasis.expectedClaimedAt !== tokens.expectedClaimedAt ||
    liveBasis.expectedHistoryLength !== tokens.expectedHistoryLength;
  assert.ok(stale, `seed ${seed}: ${opName} was expected to be stale but isn't — test bug`);
  assertNoThrow(seed, opName, res);
  if (live.owner === actor) {
    assert.equal(res.status, 409,
      `seed ${seed}: ${opName} stale-basis op by the owner must 409, got ${res.status}`);
    assert.equal(res.value?.error?.code, "work_claim_conflict",
      `seed ${seed}: ${opName} stale-basis op by the owner must be work_claim_conflict`);
  } else {
    assert.equal(res.status, 403,
      `seed ${seed}: ${opName} stale-basis op by a non-owner must 403, got ${res.status}`);
    assert.equal(res.value?.error?.code, "work_not_owner",
      `seed ${seed}: ${opName} stale-basis op by a non-owner must be work_not_owner`);
  }
}

async function freshWorld(routesModule) {
  const registry = routesModule.createWorkClaimRegistry();
  const created = await call(routesModule, registry, HOLDER, "create", null, { id: ITEM });
  assert.ok([200, 201].includes(created.status), `setup create failed: ${created.status}`);
  const claimedRes = await call(routesModule, registry, HOLDER, "claim", ITEM, {});
  assert.equal(claimedRes.status, 200, `setup claim failed: ${claimedRes.status}`);
  return registry;
}

function assertOracles(registry) {
  const item = snap(registry, ITEM);
  assertLegalItem(claims, item);
  assertHistoryCoherent(item);
}

// ---------------------------------------------------------------------------
// P4: release racing re-claim — round tokens discriminate (deterministic).
// ---------------------------------------------------------------------------
async function p4StaleReleaseRefused(routesModule) {
  const registry = await freshWorld(routesModule);
  const b1 = basisOf(snap(registry, ITEM));
  const v2 = await call(routesModule, registry, HOLDER, "update", ITEM, { note: "v2-progress" });
  assert.equal(v2.status, 200);
  assert.equal(lastNote(snap(registry, ITEM)), "v2-progress");

  // The holder's release was prepared from the b1-era read; v2 landed first.
  const before = JSON.stringify(snap(registry, ITEM));
  const stale = await call(routesModule, registry, HOLDER, "update", ITEM,
    { state: "unclaimed", note: "stale release", ...b1 });
  assertStaleBasisRefused("P4a", "stale release", stale, registry, HOLDER, b1);
  assert.equal(JSON.stringify(snap(registry, ITEM)), before,
    "P4a: stale release must not apply");
  assert.equal(snap(registry, ITEM).owner, HOLDER, "P4a: the claim must not be lost");

  // A release on a fresh basis still lands — no lost release.
  const fresh = basisOf(snap(registry, ITEM));
  const released = await call(routesModule, registry, HOLDER, "update", ITEM,
    { state: "unclaimed", note: "real release", ...fresh });
  assert.equal(released.status, 200);
  const item = snap(registry, ITEM);
  assert.equal(item.state, "unclaimed");
  assert.equal(item.owner, null);
  assertOracles(registry);
}

async function p4DuplicateReleaseLosesToReclaim(routesModule) {
  const registry = await freshWorld(routesModule);
  const b1 = basisOf(snap(registry, ITEM));
  const released = await call(routesModule, registry, HOLDER, "update", ITEM,
    { state: "unclaimed", note: "round-1 release", ...b1 });
  assert.equal(released.status, 200);
  const reclaimed = await call(routesModule, registry, HOLDER, "claim", ITEM, {});
  assert.equal(reclaimed.status, 200, "round-2 claim must land");

  // The duplicate of the round-1 release arrives mid-round-2. claimedAt moved
  // (T1 -> T2) and history grew — the tokens discriminate.
  const before = JSON.stringify(snap(registry, ITEM));
  const dup = await call(routesModule, registry, HOLDER, "update", ITEM,
    { state: "unclaimed", note: "duplicate release", ...b1 });
  assertStaleBasisRefused("P4b", "duplicate release", dup, registry, HOLDER, b1);
  assert.equal(JSON.stringify(snap(registry, ITEM)), before,
    "P4b: duplicate release must not apply");
  const item = snap(registry, ITEM);
  assert.equal(item.owner, HOLDER, "P4b: round-2 claim must survive");
  assert.equal(stampActions(item).filter(a => a === "state:unclaimed").length, 1,
    "P4b: exactly one release stamp — the duplicate left none");
  assert.equal(stampActions(item).filter(a => a === "claimed").length, 2);
  assertOracles(registry);
}

async function p4StaleNoteNeverClobbers(routesModule) {
  const registry = await freshWorld(routesModule);
  const b1 = basisOf(snap(registry, ITEM));
  const released = await call(routesModule, registry, HOLDER, "update", ITEM,
    { state: "unclaimed", note: "release", ...b1 });
  assert.equal(released.status, 200);
  const reclaimed = await call(routesModule, registry, HOLDER, "claim", ITEM, {});
  assert.equal(reclaimed.status, 200);
  const v2 = await call(routesModule, registry, HOLDER, "update", ITEM, { note: "round-2 note" });
  assert.equal(v2.status, 200);

  // A delayed round-1 note arrives mid-round-2.
  const ghost = await call(routesModule, registry, HOLDER, "update", ITEM,
    { note: "ghost note", ...b1 });
  assertStaleBasisRefused("P4c", "stale note", ghost, registry, HOLDER, b1);
  assert.equal(lastNote(snap(registry, ITEM)), "round-2 note",
    "P4c: the stale note must not clobber round 2");
  assert.equal(snap(registry, ITEM).owner, HOLDER);
  assertOracles(registry);
}

async function p4ClaimRaceExactlyOneWinner(routesModule, seed) {
  const registry = routesModule.createWorkClaimRegistry();
  const created = await call(routesModule, registry, HOLDER, "create", null, { id: ITEM });
  assert.ok([200, 201].includes(created.status), `setup create failed: ${created.status}`);
  // N actors race to claim the same work; arrival order is shuffled.
  const rng = mulberry32(seed);
  const racers = shuffle(rng, AGENTS);
  let wins = 0;
  let winner = null;
  for (const agent of racers) {
    const res = await call(routesModule, registry, agent, "claim", ITEM, {});
    assertNoThrow(`P4d/s${seed}`, `claim(${agent})`, res);
    if (res.status === 200) {
      wins++;
      winner = agent;
    } else {
      assert.equal(res.status, 409, `loser claim by ${agent} must 409, got ${res.status}`);
      assert.equal(res.value?.error?.code, "work_claim_conflict");
    }
  }
  assert.equal(wins, 1, `seed ${seed}: exactly one claim wins (got ${wins})`);
  const item = snap(registry, ITEM);
  assert.equal(item.owner, winner, "the winner owns the claim");
  assert.equal(stampActions(item).filter(a => a === "claimed").length, 1,
    "exactly one claimed stamp — never two active claims");
  assertOracles(registry);
}

describe("P4: release racing re-claim — round tokens discriminate", () => {
  it("a stale-basis release is refused with 409 and never applies", async () => {
    await p4StaleReleaseRefused(routes);
  });
  it("a duplicate release replayed after a reclaim loses to the new round", async () => {
    await p4DuplicateReleaseLosesToReclaim(routes);
  });
  it("a stale note replay never clobbers the new round", async () => {
    await p4StaleNoteNeverClobbers(routes);
  });
  it("N actors racing to claim the same work: exactly one wins", async () => {
    for (let seed = 1; seed <= 25; seed++) await p4ClaimRaceExactlyOneWinner(routes, seed);
  });
});

// ---------------------------------------------------------------------------
// P5: seeded claim/release/reclaim races with stale-basis retries.
// ---------------------------------------------------------------------------
function genP5Ops(rng) {
  // Every op carries either a FRESH basis (read just before commit) or the
  // STALE basis captured before the race started — a delayed retry arriving
  // mid-race. Claim attempts carry no tokens (the claim route has none).
  const ops = [];
  const count = 24 + Math.floor(rng() * 12);
  for (let i = 0; i < count; i++) {
    const roll = rng();
    const stale = rng() < 0.5;
    if (roll < 0.30) ops.push({ kind: "claim", actor: pick(rng, RIVALS), tokens: null, name: `claim(${i})` });
    else if (roll < 0.42) ops.push({ kind: "claim", actor: HOLDER, tokens: null, name: `reclaim(${i})` });
    else if (roll < 0.66) ops.push({ kind: "note", actor: HOLDER, tokens: stale ? "stale" : "fresh", name: `note(${i},${stale ? "stale" : "fresh"})` });
    else if (roll < 0.86) ops.push({ kind: "release", actor: HOLDER, tokens: stale ? "stale" : "fresh", name: `release(${i},${stale ? "stale" : "fresh"})` });
    else ops.push({ kind: "note", actor: pick(rng, RIVALS), tokens: stale ? "stale" : "fresh", name: `rival-note(${i},${stale ? "stale" : "fresh"})` });
  }
  return ops;
}

async function runP5(routesModule, seed) {
  const rng = mulberry32(seed);
  const registry = await freshWorld(routesModule);
  const staleBasis = basisOf(snap(registry, ITEM)); // captured before the race
  const ops = shuffle(rng, genP5Ops(rng));

  let openRound = true; // the setup claim holds round 1
  let claimWins = 1;
  let releaseWins = 0;

  for (const op of ops) {
    const beforeItem = snap(registry, ITEM);
    const before = JSON.stringify(beforeItem);
    const preBasis = basisOf(beforeItem);
    const tokens = op.tokens === "stale" ? staleBasis
      : op.tokens === "fresh" ? basisOf(snap(registry, ITEM))
      : null;
    let res;
    if (op.kind === "claim") {
      res = await call(routesModule, registry, op.actor, "claim", ITEM, {});
    } else if (op.kind === "note") {
      const body = { note: `chaos-${seed}-${op.name}` };
      if (tokens) Object.assign(body, tokens);
      res = await call(routesModule, registry, op.actor, "update", ITEM, body);
    } else {
      const body = { state: "unclaimed", note: `chaos-release-${seed}` };
      if (tokens) Object.assign(body, tokens);
      res = await call(routesModule, registry, op.actor, "update", ITEM, body);
    }

    if (op.tokens) {
      // Token-carrying op: discriminate on whether the basis was actually
      // stale at commit time (compared against the pre-call read, since a
      // successful op naturally moves the basis itself).
      const actuallyStale =
        preBasis.expectedClaimedAt !== tokens.expectedClaimedAt ||
        preBasis.expectedHistoryLength !== tokens.expectedHistoryLength;
      if (actuallyStale) {
        assertStaleBasisRefused(seed, op.name, res, registry, op.actor, tokens);
        assert.equal(JSON.stringify(snap(registry, ITEM)), before,
          `seed ${seed}: ${op.name} stale op must not apply`);
      } else if (res.status === 200) {
        if (op.kind === "release") {
          assert.ok(openRound, `seed ${seed}: ${op.name} released with no open round`);
          openRound = false;
          releaseWins++;
          const item = snap(registry, ITEM);
          assert.equal(item.state, "unclaimed", `seed ${seed}: release-200 left state ${item.state}`);
          assert.equal(item.owner, null, `seed ${seed}: release-200 left owner ${item.owner}`);
        }
      } else {
        assertCleanRefusal(seed, op.name, res, before, registry);
      }
    } else if (res.status === 200) {
      // Claim race: exactly one winner per unclaimed window.
      assert.ok(!openRound, `seed ${seed}: ${op.name} claim-200 while a round is open — two active claims`);
      openRound = true;
      claimWins++;
      const item = snap(registry, ITEM);
      assert.equal(item.owner, op.actor, `seed ${seed}: claim winner ${op.actor} does not own the item`);
    } else {
      assertCleanRefusal(seed, op.name, res, before, registry);
      if (res.status === 409) {
        assert.equal(res.value?.error?.code, "work_claim_conflict",
          `seed ${seed}: ${op.name} losing claim must be work_claim_conflict`);
      }
    }
    assertOracles(registry);
  }

  // Round accounting: claims and releases strictly alternate, starting with
  // the setup claim — exactly-once winners, no lost releases.
  assert.ok(claimWins === releaseWins || claimWins === releaseWins + 1,
    `seed ${seed}: claim/release wins out of alternation (claims=${claimWins}, releases=${releaseWins})`);
  assert.equal(openRound, claimWins === releaseWins + 1,
    `seed ${seed}: openRound tracking drifted from win counts`);
  const final = snap(registry, ITEM);
  assert.equal(final.owner !== null, openRound,
    `seed ${seed}: final owner/state disagree (owner=${final.owner}, state=${final.state})`);
  return { claimWins, releaseWins };
}

describe("P5: seeded claim/release/reclaim races with stale-basis retries", () => {
  it("250 random interleavings", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) await runP5(routes, seed);
  });
});

// ---------------------------------------------------------------------------
// FAIL-FIRST: the properties must catch the round-token guard being removed.
// ---------------------------------------------------------------------------
describe("fail-first: weakened round-token guard is caught", () => {
  it("P4 catches a missing stale-basis 409", async () => {
    const weak = await loadWeakenedRouteModule("p4");
    await assert.rejects(p4StaleReleaseRefused(weak), /stale-basis/,
      "P4a did not catch the removed stale-basis guard");
    await assert.rejects(p4DuplicateReleaseLosesToReclaim(weak), /stale-basis/,
      "P4b did not catch the removed stale-basis guard");
    await assert.rejects(p4StaleNoteNeverClobbers(weak), /stale-basis/,
      "P4c did not catch the removed stale-basis guard");
  });

  it("P5 catches a missing stale-basis 409", async () => {
    const weak = await loadWeakenedRouteModule("p4");
    let caught = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      try {
        await runP5(weak, seed);
      } catch (err) {
        caught++;
        assert.match(err.message, /409|stale/,
          `seed ${seed}: P5 failed for the wrong reason: ${err.message}`);
      }
    }
    assert.ok(caught > 0, "P5 did not catch the removed stale-basis guard on any seed");
  });
});

after(async () => {
  await cleanWeakenedClaimModules();
});
