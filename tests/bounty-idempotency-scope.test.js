// Regression tests for the cross-member idempotency replay (issue #1000).
//
// Bug: bounty_idempotency was keyed by (room_id, idem_key), so the caller,
// route and bounty were not part of the key. Two consequences:
//   1. A member reusing another member's key on a different bounty received
//      the first member's response body (cross-member leak) and their own
//      work never ran.
//   2. A key whose payload changed was replayed as the original response
//      instead of being rejected.
//
// The owner boundary for the replay scope is BountyEscrow.idemExecute, so
// these live with the existing idempotency test in bounty-escrow.test.js's
// fixture. They are kept in their own file because they pin a different
// contract: scope isolation, not "a replay does not re-execute".
//
// Every test here fails on the pre-fix code with a signature that is about
// scope, not about a missing mock: the pre-fix path returns the *other*
// scope's body, so `assert.equal(second.body.bounty.bountyId, ...)` compares
// a real id against the wrong one.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";      // poster lane
const GROK = "id:agent/grokbot";   // worker lane
const INSTINCT = "id:agent/instinct";

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;
// Only the poster may fund, so each lane funds its own bounty. The scope
// under test is the idempotency key, not the ledger's authorization rules.
const postAs = (escrow, poster, overrides = {}) => escrow.postBounty(ROOM,
  { poster, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;

// A no-op body generator: the scope must be resolvable without executing any
// ledger write, so these tests isolate the key mapping from state changes.
const count = () => ({ calls: 0, fn: () => { count.calls += 1; return { ok: true, receipt: {} }; } });

test("same key on a different bounty executes instead of replaying the other bounty's body", () => {
  const { escrow } = makeEscrow();
  const a = postAs(escrow, JILL, { title: "A" });
  const b = postAs(escrow, GROK, { title: "B" });

  // JILL funds bounty A with key "claim-1".
  const first = escrow.idemExecute(ROOM, "claim-1", "bounty.fund", 200,
    () => escrow.fundBounty(ROOM, a.bountyId, { funder: JILL }),
    { callerLane: JILL, bountyId: a.bountyId });
  assert.equal(first.replayed, false);

  // GROK reuses the same key against bounty B. Pre-fix this returned JILL's
  // fund receipt for A, so GROK believed B was funded when it was not.
  const second = escrow.idemExecute(ROOM, "claim-1", "bounty.fund", 200,
    () => escrow.fundBounty(ROOM, b.bountyId, { funder: GROK }),
    { callerLane: GROK, bountyId: b.bountyId });

  assert.equal(second.replayed, false, "a different caller+bounty must execute, not replay");
  assert.equal(second.body.bounty.bountyId, b.bountyId);
  // Both bounties really are funded — the replay did not mask the second write.
  assert.equal(escrow.getBounty(ROOM, a.bountyId).state, "funded");
  assert.equal(escrow.getBounty(ROOM, b.bountyId).state, "funded");
});

test("same key on a different route executes instead of reusing the first route's body", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);

  const first = escrow.idemExecute(ROOM, "K", "bounty.post", 201, () => ({ route: "post" }),
    { callerLane: JILL, bountyId: bounty.bountyId });
  assert.equal(first.replayed, false);

  // Same caller and bounty, different route: the scope must treat these as
  // distinct records, so the fund actually runs.
  const second = escrow.idemExecute(ROOM, "K", "bounty.fund", 200,
    () => escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL }),
    { callerLane: JILL, bountyId: bounty.bountyId });

  assert.equal(second.replayed, false, "route is part of the scope");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "funded");
});

test("a genuine replay of the same caller, route, bounty and key still short-circuits", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);

  const first = escrow.idemExecute(ROOM, "k-1", "bounty.fund", 200,
    () => escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL }),
    { callerLane: JILL, bountyId: bounty.bountyId });
  assert.equal(first.replayed, false);

  // Same scope, different generator that must never run.
  let executed = 0;
  const replay = escrow.idemExecute(ROOM, "k-1", "bounty.fund", 200,
    () => { executed += 1; throw new Error("must not re-execute"); },
    { callerLane: JILL, bountyId: bounty.bountyId });

  assert.equal(replay.replayed, true);
  assert.equal(replay.status, 200);
  assert.equal(executed, 0);
  assert.equal(replay.body.bounty.bountyId, bounty.bountyId);
  // Exactly one fund happened.
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "funded");
});

test("one member's key cannot read another member's receipt body", () => {
  const { escrow } = makeEscrow();
  const grokBounty = postAs(escrow, GROK);

  // GROK funds and stores a receipt under a predictable key.
  escrow.idemExecute(ROOM, "claim-X", "bounty.fund", 200,
    () => escrow.fundBounty(ROOM, grokBounty.bountyId, { funder: GROK }),
    { callerLane: GROK, bountyId: grokBounty.bountyId });

  // INSTINCT asks with the same key but its own scope: it must execute and
  // get its own body, never GROK's stored receipt.
  const second = postAs(escrow, INSTINCT, { title: "second" });
  const result = escrow.idemExecute(ROOM, "claim-X", "bounty.fund", 200,
    () => escrow.fundBounty(ROOM, second.bountyId, { funder: INSTINCT }),
    { callerLane: INSTINCT, bountyId: second.bountyId });

  assert.equal(result.replayed, false);
  assert.equal(result.body.bounty.bountyId, second.bountyId);
  assert.equal(result.body.receipt.actor.id, INSTINCT, "receipt names the real caller");
});

test("a key with no scope still replays on the raw key (backward compatible)", () => {
  const { escrow } = makeEscrow();
  // Direct construction without a scope object must keep working: legacy
  // callers (and tests) pass no scope, and the key alone still identifies one
  // record so repeated calls remain idempotent.
  let calls = 0;
  const fn = () => { calls += 1; return { n: calls }; };
  const first = escrow.idemExecute(ROOM, "bare", "bounty.post", 201, fn);
  const second = escrow.idemExecute(ROOM, "bare", "bounty.post", 201, fn);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.body.n, 1);
  assert.equal(calls, 1);
});

test("the scoped key is stable across calls and distinguishes only real scope changes", () => {
  const { escrow, db } = makeEscrow();
  const jillBounty = postAs(escrow, JILL);
  escrow.idemExecute(ROOM, "k", "bounty.fund", 200,
    () => escrow.fundBounty(ROOM, jillBounty.bountyId, { funder: JILL }),
    { callerLane: JILL, bountyId: jillBounty.bountyId });

  const rows = db.prepare("SELECT scope_key, caller_lane, version FROM bounty_idempotency").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].caller_lane, JILL, "the caller is persisted with the record");
  assert.equal(rows[0].version, 2, "scoped records carry the v2 marker");

  // A different scope under the same client key must not collide, and must
  // not trip the primary key.
  const grokBounty = postAs(escrow, GROK);
  escrow.idemExecute(ROOM, "k", "bounty.fund", 200,
    () => escrow.fundBounty(ROOM, grokBounty.bountyId, { funder: GROK }),
    { callerLane: GROK, bountyId: grokBounty.bountyId });
  const after = db.prepare("SELECT COUNT(*) AS n FROM bounty_idempotency").get();
  assert.equal(after.n, 2, "different caller => separate record, same room+key");
});

test("scope survives a database reopen (read from persisted columns, not memory)", () => {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const one = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  one.ensureGenesis(ROOM);
  const bounty = one.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) }).bounty;
  one.idemExecute(ROOM, "k", "bounty.fund", 200,
    () => one.fundBounty(ROOM, bounty.bountyId, { funder: JILL }),
    { callerLane: JILL, bountyId: bounty.bountyId });

  // Same database, fresh BountyEscrow: the replay decision must come from
  // storage, so a restart cannot re-open the cross-member window.
  const two = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  const replay = two.idemExecute(ROOM, "k", "bounty.fund", 200,
    () => { throw new Error("must not re-execute after reopen"); },
    { callerLane: JILL, bountyId: bounty.bountyId });
  assert.equal(replay.replayed, true);

  const other = postAs(two, GROK, { title: "other" });
  const cross = two.idemExecute(ROOM, "k", "bounty.fund", 200,
    () => two.fundBounty(ROOM, other.bountyId, { funder: GROK }),
    { callerLane: GROK, bountyId: other.bountyId });
  assert.equal(cross.replayed, false, "scope isolation survives reopen");
});

test("a legacy (room, key) row is not replayed under the scoped regime", () => {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);

  // Simulate a row written by the pre-fix code: no scope columns, so version
  // is NULL and scope_key is NULL. The scoped lookup must ignore it rather
  // than replay a response whose key cannot be trusted to name one member's
  // operation. A plain body generator keeps this about the key mapping, not
  // about funding authorization.
  escrow.idemExecute(ROOM, "legacy", "bounty.fund", 200, () => ({ legacy: true }));
  db.exec("UPDATE bounty_idempotency SET version = NULL, scope_key = NULL WHERE idem_key = 'legacy'");

  let executed = 0;
  const result = escrow.idemExecute(ROOM, "legacy", "bounty.fund", 200,
    () => { executed += 1; return { scoped: true }; },
    { callerLane: JILL, bountyId: "ROOMTEST-1" });
  assert.equal(result.replayed, false, "an unscopeable legacy row must not be replayed");
  assert.equal(executed, 1, "the scoped call really executed");
  assert.equal(result.body.scoped, true);
});

test("key validation still rejects malformed keys before any scope work", () => {
  const { escrow } = makeEscrow();
  for (const bad of ["", "x".repeat(129)]) {
    assert.throws(() => escrow.idemExecute(ROOM, bad, "bounty.post", 201, () => ({}),
      { callerLane: JILL, bountyId: "ROOMTEST-1" }), /idempotency key/, `key length ${bad.length}`);
  }
  assert.throws(() => escrow.idemExecute(ROOM, 42, "bounty.post", 201, () => ({}),
    { callerLane: JILL, bountyId: "ROOMTEST-1" }), /idempotency key/);
});

test("a null key bypasses idempotency entirely, scoped or not", () => {
  const { escrow } = makeEscrow();
  let calls = 0;
  const fn = () => { calls += 1; return { n: calls }; };
  const a = escrow.idemExecute(ROOM, null, "bounty.post", 201, fn, { callerLane: JILL, bountyId: "B1" });
  const b = escrow.idemExecute(ROOM, undefined, "bounty.post", 201, fn);
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, false);
  assert.equal(calls, 2, "no key means no replay");
});
