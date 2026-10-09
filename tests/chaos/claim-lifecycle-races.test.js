// claim-lifecycle-races.test.js — chaos properties for the claim lifecycle.
//
// PRODUCT-200 reliability slice C2/50 (CHAOS PROPERTIES — CLAIM LIFECYCLE
// RACES). Permanent properties over server/work-claims.mjs; WAVE-400's
// fuzzing front does one-off bug-finding runs — no duplication.
//
// C1's harness frame had not landed when this was written, so the
// op-generator contract lives in ./claim-race-ops.mjs and is deliberately
// small so C1's frame can adopt or supersede it.
//
// MODEL: every op is one atomic read -> pure-apply -> write transaction.
// This mirrors the production wiring in server/work-claim-routes.mjs:
// "The read, state transition and write then share one transaction."
// Concurrent requests therefore serialize into some total order of such
// transactions; each property randomizes over 250 of those orders (seeded
// PRNG — every interleaving reproduces from its seed).
//
//   P1: concurrent create-with-same-key -> exactly one claim.
//   P2: interleaved release/reclaim -> final state always legal, never torn.
//   P3: renew racing release -> exactly one wins, loser gets a clean conflict
//       (never a silent double effect).
//
// FAIL-FIRST: each property has a companion test that runs it against a
// guard-weakened copy of server/work-claims.mjs (generated at test time into
// tests/chaos/.weak/, gitignored) and asserts the property FAILS — proving
// the property actually guards the behavior it names. The weakening
// transform refuses to run unless its target string occurs exactly once, so
// source drift fails loudly instead of silently testing nothing.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as claims from "../../server/work-claims.mjs";
import {
  mulberry32, pick, shuffle, createRaceStore, createClock, conflictError,
  assertLegalItem, assertHistoryCoherent, assertCleanConflict,
  opCreate, opClaim, opUpdateSmart, opUpdateBlind, opRelease, opRenew,
  opSweep, opTick, opReassign, opClose, opAttest, opReview,
  runOpList, loadWeakenedClaimModule, cleanWeakenedClaimModules,
} from "./claim-race-ops.mjs";

const SEEDS = 250;
const BASE_MS = 1780000000000; // fixed logical clock base; each seed offsets it
const AGENTS = ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e", "agent-f", "agent-g", "agent-h"];

// ---------------------------------------------------------------------------
// P1: concurrent create-with-same-key -> exactly one claim.
// ---------------------------------------------------------------------------
function runP1(claimsModule, seed) {
  const rng = mulberry32(seed);
  const store = createRaceStore();
  const clock = createClock(BASE_MS + seed * 1000);
  const agents = AGENTS.slice(0, 2 + Math.floor(rng() * 7)); // 2..8 racers
  const id = "race-key";

  // Phase 1 — concurrent create-with-same-key: create-if-absent, losers get a
  // clean 409. (Mirrors the route's `registry.has -> 409 work_claim_exists`.)
  let created = 0;
  for (const agent of shuffle(rng, agents)) {
    try {
      if (store.has(id)) throw conflictError("work_claim_exists", `Work claim "${id}" already exists`, 409);
      store.insert(claimsModule.createWork({ id, title: id }, { now: clock.now, agentId: agent }));
      created++;
    } catch (err) { assertCleanConflict(claimsModule, err); }
  }
  assert.equal(created, 1, `seed ${seed}: exactly one create wins (got ${created})`);

  // Phase 2 — claim race. RACE WINDOW: every agent reads the same unclaimed
  // snapshot and computes claimWork. Every computation must succeed: the race
  // is real, anyone could have won.
  const snapshot = store.get(id);
  assert.equal(snapshot.state, "unclaimed");
  const attempts = agents.map(agent => ({
    agent,
    computed: claimsModule.claimWork(snapshot, agent, { now: clock.now, leaseHours: 1 }),
  }));

  // COMMITS serialize in a random order. Each commit re-validates against the
  // latest committed state through the pure anti-collision guard: exactly one
  // commit lands; the rest are refused with a clean conflict — never silently
  // overwritten, never two owners.
  let wins = 0;
  for (const { agent, computed } of shuffle(rng, attempts)) {
    const latest = store.get(id);
    if (latest.state === "unclaimed") {
      store.set(computed);
      wins++;
    } else {
      let revalidation = null;
      try {
        claimsModule.claimWork(latest, agent, { now: clock.now, leaseHours: 1 });
      } catch (err) { revalidation = err; }
      assert.ok(revalidation,
        `seed ${seed}: loser claim by ${agent} was NOT refused — anti-collision guard missing`);
      assertCleanConflict(claimsModule, revalidation);
    }
    assertLegalItem(claimsModule, store.get(id));
    assertHistoryCoherent(store.get(id));
  }
  assert.equal(wins, 1, `seed ${seed}: exactly one claim wins (got ${wins})`);
  const final = store.get(id);
  assert.ok(agents.includes(final.owner), `seed ${seed}: the winner owns the claim`);
  assert.equal(final.history.filter(s => s.action === "claimed").length, 1,
    `seed ${seed}: exactly one claimed stamp`);
}

describe("P1: concurrent create-with-same-key -> exactly one claim", () => {
  it("250 random interleavings", () => {
    for (let seed = 1; seed <= SEEDS; seed++) runP1(claims, seed);
  });
});

// ---------------------------------------------------------------------------
// P2: interleaved release/reclaim -> final state always legal, never torn.
// ---------------------------------------------------------------------------
const P2_STATES = ["unclaimed", "claimed", "in_progress", "blocked", "done", "closed"];

function genP2Ops(rng, itemIds, agents, { forceRelease = false } = {}) {
  const ops = [];
  for (const id of itemIds) ops.push(opCreate(id, pick(rng, agents)));
  if (forceRelease) {
    // Deterministic claim+release prefix for the fail-first run.
    ops.push(opClaim(itemIds[0], agents[0], { leaseHours: 1 }));
    ops.push(opRelease(itemIds[0], agents[0]));
  }
  const count = 30 + Math.floor(rng() * 15);
  for (let i = 0; i < count; i++) {
    const id = pick(rng, itemIds);
    const agent = pick(rng, agents);
    const roll = rng();
    if (roll < 0.10) ops.push(opClaim(id, agent, { leaseHours: pick(rng, [1, 24, null]) }));
    else if (roll < 0.24) ops.push(opUpdateSmart(id, agent, rng));
    else if (roll < 0.32) ops.push(opUpdateBlind(id, agent, pick(rng, P2_STATES)));
    else if (roll < 0.42) ops.push(opRelease(id, agent, { authority: rng() < 0.2 }));
    else if (roll < 0.52) ops.push(opRenew(id, agent));
    else if (roll < 0.56) ops.push(opSweep());
    else if (roll < 0.64) ops.push(opTick(Math.floor(rng() * 72 * 3600 * 1000)));
    else if (roll < 0.70) ops.push(opReassign(id, agent, pick(rng, agents.filter(a => a !== agent))));
    else if (roll < 0.76) ops.push(opClose(id, agent, pick(rng, ["close", "cancel"]), { authority: rng() < 0.3 }));
    else if (roll < 0.82) ops.push(opAttest(id, agent, `chaos note ${i}`));
    else if (roll < 0.88) ops.push(opReview(id, agent, pick(rng, ["approve", "comment", "changes_requested"]), rng));
    else if (roll < 0.94) ops.push(opCreate(id, agent)); // duplicate create -> clean 409
    else ops.push(opClaim(id, pick(rng, agents))); // blind claim, usually conflicts
  }
  return ops;
}

function runP2(claimsModule, seed, opts = {}) {
  const rng = mulberry32(seed);
  const store = createRaceStore();
  const clock = createClock(BASE_MS + seed * 1000);
  const itemIds = ["w0", "w1", "w2", "w3", "w4"];
  const agents = AGENTS.slice(0, 4);
  const ops = genP2Ops(rng, itemIds, agents, opts);
  // runOpList asserts, after EVERY op: input purity, no partial write on
  // conflict, and the legal-state + history-coherence oracles on every item.
  const outcomes = runOpList({ claims: claimsModule, store, clock, ops, rng });
  for (const o of outcomes) {
    if (!o.ok) {
      assertCleanConflict(claimsModule, o.error);
    } else if (o.readState === "done" || o.readState === "closed") {
      // Terminal states are immutable: no op may succeed on one.
      assert.fail(`seed ${seed}: ${o.name} succeeded on terminal item (readState=${o.readState})`);
    }
  }
  for (const item of store.list()) {
    assertLegalItem(claimsModule, item);
    assertHistoryCoherent(item);
  }
  return outcomes;
}

describe("P2: interleaved release/reclaim -> final state always legal, never torn", () => {
  it("250 random interleavings", () => {
    for (let seed = 1; seed <= SEEDS; seed++) runP2(claims, seed);
  });
});

// ---------------------------------------------------------------------------
// P3: renew racing release -> exactly one wins, loser gets a clean conflict
// (never a silent double effect).
// ---------------------------------------------------------------------------
function p3Setup(claimsModule, seed) {
  const store = createRaceStore();
  const clock = createClock(BASE_MS + seed * 1000);
  const id = "p3-item";
  const owner = "owner-a";
  const created = claimsModule.createWork({ id, title: id }, { now: clock.now, agentId: "system" });
  store.insert(created);
  store.set(claimsModule.claimWork(created, owner, { leaseHours: 1, now: clock.now }));
  return { store, clock, id, owner };
}

// P3a: renew races the lease-expiry sweep (the clock advances past the lease
// between the two ops).
function runP3Sweep(claimsModule, seed) {
  const rng = mulberry32(seed);
  const { store, clock, id, owner } = p3Setup(claimsModule, seed);
  // leaseHours: 1 keeps the race live: the renew extends the 1h lease by 1h,
  // and the +2h tick then lapses it again, so the sweep has something to do
  // in every order.
  const race = shuffle(rng, [opRenew(id, owner, { leaseHours: 1 }), opTick(2 * 3600 * 1000), opSweep()]);
  const outcomes = runOpList({ claims: claimsModule, store, clock, ops: race, rng });
  const renew = outcomes.find(o => o.name.startsWith("renew("));
  const sweep = outcomes.find(o => o.name === "sweep()");
  const final = store.get(id);
  if (renew.ok) {
    // The renew won the race: it acted on the live round — never on a
    // released item (that would be the silent double effect).
    assert.equal(renew.readState, "claimed", `seed ${seed}: renew committed on ${renew.readState}`);
    assert.equal(renew.readOwner, owner, `seed ${seed}: renew committed for ${renew.readOwner}`);
  } else {
    assertCleanConflict(claimsModule, renew.error);
  }
  if (sweep.wrote) {
    // Whoever won, a sweep that released leaves a fully clean unclaimed item.
    assert.equal(final.state, "unclaimed");
    assert.equal(final.owner, null);
    assert.equal(final.leaseExpiresAt, null);
  }
  return outcomes;
}

// P3b: renew races an authority release.
function runP3Release(claimsModule, seed, forcedOrder = null) {
  const rng = mulberry32(seed);
  const { store, clock, id, owner } = p3Setup(claimsModule, seed);
  const manager = "manager-b";
  const race = forcedOrder ?? shuffle(rng, [opRenew(id, owner), opRelease(id, manager, { authority: true })]);
  const outcomes = runOpList({ claims: claimsModule, store, clock, ops: race, rng });
  const renew = outcomes.find(o => o.name.startsWith("renew("));
  const release = outcomes.find(o => o.name.startsWith("release("));
  const final = store.get(id);
  const renewFirst = outcomes.indexOf(renew) < outcomes.indexOf(release);
  if (renewFirst) {
    // Renew won the race; the release then acted on the renewed claim and
    // must fully subsume it — no lease residue, no owner residue.
    assert.ok(renew.ok, `seed ${seed}: renew should win when first`);
    assert.ok(release.ok, `seed ${seed}: release should win when second`);
    assert.equal(release.readState, "claimed", `seed ${seed}: release acted on ${release.readState}`);
    assert.equal(final.state, "unclaimed");
    assert.equal(final.owner, null);
    assert.equal(final.leaseStartAt, null);
    assert.equal(final.leaseExpiresAt, null);
  } else {
    // Release won the race; the renew must lose with a clean conflict —
    // exactly one wins.
    assert.ok(release.ok, `seed ${seed}: release should win when first`);
    assert.ok(!renew.ok, `seed ${seed}: renew must lose when second`);
    assertCleanConflict(claimsModule, renew.error);
    assert.equal(final.state, "unclaimed");
  }
  return outcomes;
}

describe("P3: renew racing release -> exactly one wins, loser conflicts cleanly", () => {
  it("250 random interleavings vs the lease-expiry sweep", () => {
    for (let seed = 1; seed <= SEEDS; seed++) runP3Sweep(claims, seed);
  });
  it("250 random interleavings vs an authority release", () => {
    for (let seed = 1; seed <= SEEDS; seed++) runP3Release(claims, seed);
  });
});

// ---------------------------------------------------------------------------
// Wiring contract behind P3: a renew computed from a stale pre-release
// snapshot and committed blindly (WITHOUT the route's read->apply->set in one
// transaction) silently rewrites committed history — the release's
// "state:unclaimed" stamp is dropped and the dead round is resurrected. The
// renewed item even passes the legal-state oracle (state/owner/lease cohere),
// which is exactly why the transaction boundary in
// server/work-claim-routes.mjs is load-bearing. This test demonstrates the
// torn write and the clean conflict the boundary produces instead.
// ---------------------------------------------------------------------------
describe("P3 wiring contract: the transaction boundary is load-bearing", () => {
  it("stale read + blind commit silently rewrites committed history", () => {
    const store = createRaceStore();
    const clock = createClock(BASE_MS);
    const id = "stale-item";
    const owner = "owner-a";
    store.insert(claims.createWork({ id, title: id }, { now: clock.now, agentId: "system" }));
    store.set(claims.claimWork(store.get(id), owner, { leaseHours: 1, now: clock.now }));

    const stale = store.get(id); // A's read: claimed, lease valid.
    store.set(claims.updateWork(store.get(id), owner, { state: "unclaimed", note: "release", now: clock.now }));
    assert.deepEqual(store.get(id).history.map(s => s.action), ["created", "claimed", "state:unclaimed"]);

    // WITHOUT the transaction boundary, A's stale-computed renew commits
    // blindly on top of the release:
    const renewed = claims.renewWork(stale, owner, { now: clock.now });
    assertLegalItem(claims, renewed); // looks legal — the torn-ness is subtler
    store.set(renewed);
    const after = store.get(id).history.map(s => s.action);
    // The committed release stamp was silently dropped: history is no longer
    // append-only, and the item again claims an open round the room closed.
    assert.ok(!after.includes("state:unclaimed"), `blind commit rewrote history: ${after.join(",")}`);
    assert.equal(store.get(id).state, "claimed");

    // WITH the boundary (the model every property here uses), the same renew
    // reads the released item and fails with a clean conflict instead:
    const store2 = createRaceStore();
    store2.insert(claims.createWork({ id, title: id }, { now: clock.now, agentId: "system" }));
    store2.set(claims.claimWork(store2.get(id), owner, { leaseHours: 1, now: clock.now }));
    store2.set(claims.updateWork(store2.get(id), owner, { state: "unclaimed", note: "release", now: clock.now }));
    assert.throws(() => claims.renewWork(store2.get(id), owner, { now: clock.now }), err => {
      assertCleanConflict(claims, err);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// FAIL-FIRST: each property must catch its guard being weakened. The weakened
// modules are generated from the CURRENT server/work-claims.mjs at test time;
// the transform refuses unless each target string occurs exactly once.
// ---------------------------------------------------------------------------
describe("fail-first: weakened guards are caught", () => {
  it("P1 catches a weakened anti-collision guard", async () => {
    const weak = await loadWeakenedClaimModule("p1");
    for (const seed of [1, 2, 3, 4, 5]) {
      assert.throws(() => runP1(weak, seed), /NOT refused|exactly one claim wins/,
        `seed ${seed}: P1 did not catch the weakened anti-collision guard`);
    }
  });

  it("P2 catches a release that keeps the owner (torn state)", async () => {
    const weak = await loadWeakenedClaimModule("p2");
    for (const seed of [1, 2, 3, 4, 5]) {
      assert.throws(() => runP2(weak, seed, { forceRelease: true }), /torn owner\/state/,
        `seed ${seed}: P2 did not catch the weakened release guard`);
    }
  });

  it("P3 catches a release that keeps the lease (silent double effect)", async () => {
    const weak = await loadWeakenedClaimModule("p3");
    for (const seed of [1, 2, 3, 4, 5]) {
      const { id, owner } = p3Setup(weak, seed);
      const forcedOrder = [opRenew(id, owner), opRelease(id, "manager-b", { authority: true })];
      assert.throws(() => runP3Release(weak, seed, forcedOrder), /lease on ownerless claim/,
        `seed ${seed}: P3 did not catch the weakened release guard`);
    }
  });
});

after(async () => {
  await cleanWeakenedClaimModules();
});
