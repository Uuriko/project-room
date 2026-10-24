// EXP-15R hardening (items 1 + 2): staffed challenge + verifier overturn
// gate. Item 1: every acceptance names a challenger-of-record drawn from
// room members independent of claimant and verifier, seated as a watcher
// and named on the acceptance event (the doors turn that into a wake —
// see the wakeChallengerOfRecord specimens below). Item 2: a verifier
// whose acceptances were overturned by upheld disputes at or above the
// decayed bar cannot be designated until the count decays back under it.
// Credits are valueless ledger units: no cash-out, no on-chain touch.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, bountyEscrowSchema, convergeBountyDeployedSchema } from "../server/bounty-escrow.mjs";
import { verifierDesignationStanding, VERIFIER_DESIGNATION_OVERTURN_BAR } from "../server/bounty-reputation.mjs";
import { wakeChallengerOfRecord } from "../server/bounty-escrow-routes.mjs";

const ROOM = "room-hardening";
const V = "id:human/victim";        // poster
const W = "id:agent/worker";        // claimant
const CV = "id:agent/colludver";    // designated verifier
const CH = "id:agent/challenger";   // independent agent member
const D = "id:human/decider";       // designated dispute decider
const HV = "id:agent/honestver";    // clean verifier
const DAY = 24 * 3600 * 1000;

function makeWorld(memberSpec) {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT hardening_test");
    try { const out = fn(); db.exec("RELEASE hardening_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO hardening_test"); db.exec("RELEASE hardening_test"); throw error; }
  };
  let nowMs = 1_786_000_000_000;
  const members = {};
  for (const [id, kind] of Object.entries(memberSpec)) members[id] = { kind, active: true };
  const ownerId = Object.keys(memberSpec)[0];
  const store = { db, transaction, readTransaction: transaction, now: () => nowMs,
    roomAuthority: () => ({ ownerId, members }) };
  const escrow = new BountyEscrow(store, { now: () => nowMs });
  escrow.ensureGenesis(ROOM);
  return { escrow, db, store, get now() { return nowMs; }, tick(ms) { nowMs += ms; } };
}

const ATT = w => ({ at: new Date(w.now).toISOString(), note: "lgtm",
  citations: [{ criterionId: "c1", verdict: "pass" }] });
const EV = { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" };
const post = (w, overrides = {}) => w.escrow.postBounty(ROOM,
  { poster: V, title: "T", criteria: "C", amount: 10,
    deadline: new Date(w.now + 30 * DAY).toISOString(), ...overrides }).bounty;
const lifecycle = (w, id, worker = W) => {
  w.escrow.fundBounty(ROOM, id, { funder: V });
  w.escrow.claimBounty(ROOM, id, { claimant: worker });
  w.escrow.submitWork(ROOM, id, { claimant: worker, evidence: EV });
};
const acceptedEvents = w => w.escrow.listEvents(ROOM).filter(e => e.type === "bounty.accepted");
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};

// ---------------------------------------------------------------- item 1

test("item 1: acceptance names a challenger-of-record independent of claimant and verifier", () => {
  const w = makeWorld({ [V]: "human", [W]: "agent", [CV]: "agent", [CH]: "agent", [D]: "human" });
  const bounty = post(w, { verifierId: CV, disputeDeciderId: D, approvalMode: "agent" });
  lifecycle(w, bounty.bountyId);
  w.escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: CV, verifierAttestation: ATT(w) });
  const view = w.escrow.getBounty(ROOM, bounty.bountyId);
  // The only eligible member: poster, claimant, verifier and the decider
  // are all excluded, leaving the independent agent.
  assert.equal(view.challengerOfRecord, CH);
  assert.ok(view.watchers.includes(CH), "challenger-of-record is seated as a watcher");
  const event = acceptedEvents(w).find(e => e.bountyId === bounty.bountyId);
  assert.equal(event.data.challengerOfRecord, CH, "the acceptance event names the challenger (the wake source)");
  const c = w.escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
});

test("item 1: the draw never names a party to the verdict and is stable per bounty", () => {
  const members = { [V]: "human", [W]: "agent", [CV]: "agent", [D]: "human" };
  for (const extra of ["id:agent/a1", "id:agent/a2", "id:agent/a3", "id:agent/a4"]) members[extra] = "agent";
  const w = makeWorld(members);
  const named = new Set();
  for (let i = 0; i < 8; i++) {
    const bounty = post(w, { verifierId: CV, disputeDeciderId: D, approvalMode: "agent" });
    lifecycle(w, bounty.bountyId);
    w.escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: CV, verifierAttestation: ATT(w) });
    const first = w.escrow.getBounty(ROOM, bounty.bountyId).challengerOfRecord;
    const second = w.escrow.getBounty(ROOM, bounty.bountyId).challengerOfRecord;
    assert.equal(first, second, "the named challenger is persisted, not recomputed");
    assert.ok(![V, W, CV, D].includes(first), `challenger ${first} is a party to the verdict`);
    named.add(first);
  }
  assert.ok(named.size >= 2, `the draw spreads across bounties (named: ${[...named].join(", ")})`);
});

test("item 1: no eligible member — acceptance succeeds and names none", () => {
  const w = makeWorld({ [V]: "human", [W]: "agent", [CV]: "agent" });
  const bounty = post(w, { verifierId: CV, approvalMode: "agent" });
  lifecycle(w, bounty.bountyId);
  w.escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: CV, verifierAttestation: ATT(w) });
  const view = w.escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(view.state, "accepted");
  assert.equal(view.challengerOfRecord, null);
  assert.equal(acceptedEvents(w)[0].data.challengerOfRecord, null);
});

test("item 1: legacy string-lane mode (no membership source) names none and never fails acceptance", () => {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT legacy_test");
    try { const out = fn(); db.exec("RELEASE legacy_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO legacy_test"); db.exec("RELEASE legacy_test"); throw error; }
  };
  let nowMs = 1_786_000_000_000;
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  const bounty = escrow.postBounty(ROOM, { poster: "id:agent/jill", title: "T", criteria: "C",
    amount: 10, deadline: new Date(nowMs + 30 * DAY).toISOString(),
    verifierId: "id:agent/instinct", approvalMode: "agent" }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: "id:agent/jill" });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: "id:agent/grokbot" });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: "id:agent/grokbot", evidence: EV });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: "id:agent/instinct",
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm",
      citations: [{ criterionId: "c1", verdict: "pass" }] } });
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).challengerOfRecord, null);
});

test("item 1: schema — fresh and converged databases carry challenger_of_record", () => {
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(bountyEscrowSchema);
  const freshCols = fresh.prepare("SELECT name FROM pragma_table_info('bounty_records')").all().map(r => r.name);
  assert.ok(freshCols.includes("challenger_of_record"));
  const converged = new DatabaseSync(":memory:");
  convergeBountyDeployedSchema(converged);
  const convCols = converged.prepare("SELECT name FROM pragma_table_info('bounty_records')").all().map(r => r.name);
  assert.ok(convCols.includes("challenger_of_record"));
});

// ------------------------------------------------------------- item 1 wake

function makeWakeStore({ withIdentity = true } = {}) {
  const db = new DatabaseSync(":memory:");
  // The production identity_links shape (server/agent-identities.mjs),
  // mirrored as a fixture like tests/guest-wake-resolution.test.js.
  db.exec(`CREATE TABLE identity_links (
    room_id TEXT NOT NULL, identity_id TEXT NOT NULL,
    member_id TEXT NOT NULL, linked_at INTEGER NOT NULL)`);
  if (withIdentity)
    db.prepare("INSERT INTO identity_links VALUES (?,?,?,?)").run(ROOM, "ai_challenger", CH, 1_786_000_000_000);
  const calls = { wakes: [], pings: [] };
  const store = {
    db, now: () => 1_786_000_000_000,
    roomAuthority: () => ({ ownerId: V, members: { [CH]: { kind: "agent", active: true } } }),
    agentHeartbeats: { enqueueWake: args => { calls.wakes.push(args); return { enqueued: true, signal: { id: "sig-1" } }; } },
    agentPlugin: { deliverWakePing: args => { calls.pings.push(args); } },
  };
  return { store, calls, db };
}
const acceptedEvent = { type: "bounty.accepted", bountyId: "ROOMHARDENIN-1", seq: 7,
  data: { challengerOfRecord: CH } };

test("item 1 wake: an acceptance naming a challenger enqueues an assignment wake for their identity", () => {
  const { store, calls } = makeWakeStore();
  wakeChallengerOfRecord(store, ROOM, acceptedEvent);
  assert.equal(calls.wakes.length, 1);
  assert.deepEqual(calls.wakes[0], { agentId: "ai_challenger", kind: "assignment",
    roomId: ROOM, messageId: "bounty-challenge:ROOMHARDENIN-1" });
  assert.equal(calls.pings.length, 1, "the wake ping is delivered for an online-capable host");
});

test("item 1 wake: no identity link — no wake is enqueued and the loss is journaled, never thrown", () => {
  const { store, calls, db } = makeWakeStore({ withIdentity: false });
  wakeChallengerOfRecord(store, ROOM, acceptedEvent);
  assert.equal(calls.wakes.length, 0);
  const counters = db.prepare("SELECT * FROM agent_wake_counters WHERE event='suppressed_no_identity'").all();
  assert.equal(counters.length, 1);
  assert.equal(counters[0].kind, "assignment");
});

test("item 1 wake: non-acceptance events and unnamed challengers are no-ops", () => {
  const { store, calls } = makeWakeStore();
  wakeChallengerOfRecord(store, ROOM, { type: "bounty.paid", bountyId: "X", data: { challengerOfRecord: CH } });
  wakeChallengerOfRecord(store, ROOM, { type: "bounty.accepted", bountyId: "X", data: { challengerOfRecord: null } });
  wakeChallengerOfRecord(store, ROOM, null);
  assert.equal(calls.wakes.length, 0);
});

// ---------------------------------------------------------------- item 2

// Drive one full collusion cycle whose acceptance is overturned by an
// upheld dispute: BV accepts slop, CH disputes, D upholds.
function overturnOnce(w, verifier) {
  const bounty = post(w, { verifierId: verifier, disputeDeciderId: D, approvalMode: "agent" });
  lifecycle(w, bounty.bountyId);
  w.escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: verifier, verifierAttestation: ATT(w) });
  w.escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CH, bond: 2.5, grounds: "slop" });
  w.escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: D, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  return bounty.bountyId;
}
const gateWorld = () => makeWorld(
  { [V]: "human", [W]: "agent", [CV]: "agent", [CH]: "agent", [D]: "human", [HV]: "agent" });

test("item 2: one overturned acceptance does not bar designation", () => {
  const w = gateWorld();
  overturnOnce(w, CV);
  const standing = verifierDesignationStanding(w.escrow, ROOM, CV, { nowMs: w.now });
  assert.equal(standing.overturned, 1);
  assert.equal(standing.barred, false);
  const bounty = post(w, { verifierId: CV, disputeDeciderId: D, approvalMode: "agent" });
  assert.equal(bounty.verifier, CV);
});

test("item 2: two overturned acceptances bar designation until the count decays under the bar", () => {
  const w = gateWorld();
  overturnOnce(w, CV);
  overturnOnce(w, CV);
  const standing = verifierDesignationStanding(w.escrow, ROOM, CV, { nowMs: w.now });
  assert.equal(standing.overturned, 2);
  assert.ok(standing.decayedOverturns >= VERIFIER_DESIGNATION_OVERTURN_BAR,
    `decayed ${standing.decayedOverturns} is at/over the bar`);
  assert.equal(standing.barred, true);
  const error = expectCode(
    () => post(w, { verifierId: CV, disputeDeciderId: D, approvalMode: "agent" }), "verifier_probation");
  assert.match(error.message, /cannot be designated/);
  // A clean verifier designates fine in the same room at the same time.
  const clean = post(w, { verifierId: HV, disputeDeciderId: D, approvalMode: "agent" });
  assert.equal(clean.verifier, HV);
  // Decay re-opens designation: a half-life plus margin halves the count
  // (2 -> ~1) with no new overturns.
  w.tick(31 * DAY);
  const decayed = verifierDesignationStanding(w.escrow, ROOM, CV, { nowMs: w.now });
  assert.equal(decayed.barred, false);
  const reopened = post(w, { verifierId: CV, disputeDeciderId: D, approvalMode: "agent" });
  assert.equal(reopened.verifier, CV);
  const c = w.escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
});
