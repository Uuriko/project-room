// #3617 (accountability R-7/R-8): obligation stamps + the refusal journal.
//
// Acceptance criteria pinned here:
// - a refused claim and a refused acceptance each produce a refusal-journal
//   record naming the policy version that refused them;
// - a settled bounty shows its ceiling and ratification marker without
//   inference (settlement record + journal-leg stamps);
// - the bounty journal's hash core is untouched by stamps: every stored
//   hash still recomputes from the original core parts, and conservation
//   still verifies after stamped movements;
// - the journal is queryable per room and per actor, across the bounty,
//   public-work, and board surfaces.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BountyEscrow, journalEntryHash, MAX_CREDITS, MILLIS_PER_CREDIT } from "../server/bounty-escrow.mjs";
import { RECORDS_POLICY_VERSION, RefusalJournal, obligationStamp, ratifiedOf, recordRefusal, listRefusals } from "../server/refusal-journal.mjs";
import { PROBATION_MAX_CLAIM_MILLIS } from "../server/bounty-reputation.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { PublicWorkClaims, publicWorkClaimsSchema, PUBLIC_WORK_MAX_LIVE_CLAIMS_PER_IDENTITY } from "../server/public-work-claims.mjs";
import { publicWorkClaimFenceSchema } from "../server/public-work-claim-fence.mjs";
import { PublicWorkReviews } from "../server/public-work-reviews.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { ServiceError } from "../server/service-error.mjs";

const ROOM = "room-records";
const JILL = "id:agent/jill";
const GROK = "id:agent/grokbot";
const CODEX = "id:agent/codex";
const GLOBAL_CEILING_MILLIS = MAX_CREDITS * MILLIS_PER_CREDIT;

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction, now: () => nowMs };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, db, store };
}
const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected error ${code}, no error thrown`);
};
const journalRows = (db, kind) => db.prepare(
  "SELECT * FROM bounty_journal WHERE room_id=? AND kind=? ORDER BY seq").all(ROOM, kind);

// --- the stamp + journal primitives -------------------------------------

test("ratifiedOf: human actors ratify, rule/agent executions are auto", () => {
  assert.equal(ratifiedOf({ kind: "human", id: "x" }), "human");
  assert.equal(ratifiedOf({ kind: "rule", id: "escrow-keeper" }), "auto");
  assert.equal(ratifiedOf({ kind: "agent", id: "x" }), "auto");
  assert.equal(ratifiedOf(null), "auto");
  const stamp = obligationStamp({ ceilingMillis: 5000, actor: { kind: "human", id: "x" } });
  assert.deepEqual({ ...stamp }, { ceilingMillis: 5000, policyVersion: RECORDS_POLICY_VERSION, ratified: "human" });
});

test("refusal journal: records are immutable views, queryable per room and per actor", () => {
  const db = new DatabaseSync(":memory:");
  const journal = new RefusalJournal(db);
  assert.deepEqual(journal.listForRoom("r1"), []); // never written: reads as empty
  const first = journal.record({ roomId: "r1", surface: "bounty", actorId: "lane-a",
    refusedAction: "claim", reasonCode: "already_claimed", ceilingMillis: PROBATION_MAX_CLAIM_MILLIS,
    subjectId: "B-1", at: "2026-10-17T00:00:00.000Z" });
  assert.equal(first.policyVersion, RECORDS_POLICY_VERSION);
  assert.equal(first.ceilingMillis, PROBATION_MAX_CLAIM_MILLIS);
  assert.equal(Object.isFrozen(first), true);
  journal.record({ roomId: "r1", surface: "board", actorId: "lane-b",
    refusedAction: "claim:POST", reasonCode: "work_claim_conflict", subjectId: "task-1", at: "2026-10-17T00:01:00.000Z" });
  journal.record({ roomId: "r2", surface: "bounty", actorId: "lane-a",
    refusedAction: "transfer", reasonCode: "insufficient_funds", at: "2026-10-17T00:02:00.000Z" });
  assert.deepEqual(journal.listForRoom("r1").map(r => r.reasonCode), ["work_claim_conflict", "already_claimed"]); // newest first
  assert.deepEqual(journal.listForActor("lane-a").map(r => r.refusedAction), ["transfer", "claim"]);
  assert.deepEqual(journal.listForRoom("r1", { actorId: "lane-a" }).map(r => r.reasonCode), ["already_claimed"]);
  assert.deepEqual(listRefusals(db, { roomId: "r1", surface: "board" }).map(r => r.reasonCode), ["work_claim_conflict"]);
  assert.throws(() => recordRefusal(db, { surface: "bounty", refusedAction: "claim" }), /reasonCode/);
  assert.throws(() => listRefusals(db, {}), /roomId or an actorId/);
});

// --- R-7 stamps on bounty records ----------------------------------------

test("claim grant legs carry the obligation stamp; the hash core is unchanged", () => {
  const { escrow, db } = makeEscrow();
  const bounty = post(escrow, { amount: 2 });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  const { receipt } = escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  assert.deepEqual({ ...receipt.obligationStamp },
    { ceilingMillis: GLOBAL_CEILING_MILLIS, policyVersion: RECORDS_POLICY_VERSION, ratified: "auto" });
  const legs = journalRows(db, "bond-lock");
  assert.equal(legs.length, 2);
  for (const leg of legs) {
    assert.deepEqual(JSON.parse(leg.obligation_stamp_json), { ...receipt.obligationStamp });
    // The stamp is outside the hash core: the stored hash still recomputes
    // from the original core parts alone.
    assert.equal(journalEntryHash(leg), leg.hash);
  }
  // Pre-stamp legs (genesis) stay NULL and still verify.
  for (const leg of journalRows(db, "genesis")) {
    assert.equal(leg.obligation_stamp_json, null);
    assert.equal(journalEntryHash(leg), leg.hash);
  }
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("a settled bounty shows ceiling + policy version + ratification on the settlement record", () => {
  const { escrow, db } = makeEscrow();
  const bounty = post(escrow, { amount: 0.5 });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  // The acceptance attribution legs are stamped too.
  for (const leg of journalRows(db, "attribute"))
    assert.equal(JSON.parse(leg.obligation_stamp_json).policyVersion, RECORDS_POLICY_VERSION);
  tick(24 * 3_600_000 + 1); // challenge window for a <1cr bounty
  escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: GROK });
  escrow.closeEpoch(ROOM, { caller: JILL }); // sweep settles under RULE_ACTOR
  const settled = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(settled.state, "paid");
  assert.equal(settled.resolution.settlement.ceilingMillis, GLOBAL_CEILING_MILLIS);
  assert.equal(settled.resolution.settlement.policyVersion, RECORDS_POLICY_VERSION);
  assert.equal(settled.resolution.settlement.ratified, "auto"); // epoch sweep = rule actor
  assert.deepEqual({ ...settled.resolution.settlement.settledBy }, { kind: "rule", id: "escrow-keeper" });
  for (const leg of journalRows(db, "payout")) {
    assert.equal(JSON.parse(leg.obligation_stamp_json).ratified, "auto");
    assert.equal(journalEntryHash(leg), leg.hash);
  }
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

// --- R-8 refusals on the bounty surface -----------------------------------

test("a refused claim and a refused acceptance each produce a journal record naming the policy version", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { amount: 2 });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  // Refused claim: the bounty is already claimed.
  expectCode(() => escrow.claimBounty(ROOM, bounty.bountyId, { claimant: CODEX }), "already_claimed");
  const claimRefusals = escrow.listRefusals(ROOM, { actorId: CODEX });
  assert.equal(claimRefusals.length, 1);
  assert.equal(claimRefusals[0].surface, "bounty");
  assert.equal(claimRefusals[0].refusedAction, "claim");
  assert.equal(claimRefusals[0].reasonCode, "already_claimed");
  assert.equal(claimRefusals[0].policyVersion, RECORDS_POLICY_VERSION);
  assert.equal(claimRefusals[0].subjectId, bounty.bountyId);
  // Refused acceptance: the claimant may not accept their own work.
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: GROK,
    verifierAttestation: { note: "self", citations: [{ criterionId: "c1", verdict: "pass" }] } }), "not_authorized");
  const acceptRefusals = escrow.listRefusals(ROOM, { actorId: GROK });
  assert.equal(acceptRefusals.length, 1);
  assert.equal(acceptRefusals[0].refusedAction, "accept");
  assert.equal(acceptRefusals[0].reasonCode, "not_authorized");
  assert.equal(acceptRefusals[0].policyVersion, RECORDS_POLICY_VERSION);
  // Successful actions record no refusals, and the room query sees both.
  assert.equal(escrow.listRefusals(ROOM).length, 2);
});

test("a refused payment (transfer over balance) is journaled", () => {
  const { escrow } = makeEscrow();
  expectCode(() => escrow.transfer(ROOM, { from: GROK, to: CODEX, amount: 10_000 }), "insufficient_funds");
  const refusals = escrow.listRefusals(ROOM, { actorId: GROK });
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].refusedAction, "transfer");
  assert.equal(refusals[0].reasonCode, "insufficient_funds");
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

// --- R-8 on the public-work surface ----------------------------------------

test("public-work request(): a refused operation is journaled and burns no requestId", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(publicWorkClaimsSchema);
  const store = { db, now: () => nowMs };
  const claims = new PublicWorkClaims(store);
  const row = { offer_id: "offer-1", room_id: "room-pw" };
  const refused = () => { throw new ServiceError(409, "public_work_claim_limit", "ceiling"); };
  assert.throws(() => claims.request(row, "identity-1", "claim", { requestId: "req-1" }, refused),
    error => error.code === "public_work_claim_limit");
  const records = listRefusals(db, { roomId: "room-pw" });
  assert.equal(records.length, 1);
  assert.equal(records[0].surface, "public-work");
  assert.equal(records[0].refusedAction, "claim");
  assert.equal(records[0].reasonCode, "public_work_claim_limit");
  assert.equal(records[0].policyVersion, RECORDS_POLICY_VERSION);
  // The refusal journaled nothing in public_work_requests: the same
  // requestId succeeds on retry (the #3707 discipline is preserved).
  const outcome = claims.request(row, "identity-1", "claim", { requestId: "req-1" }, () => ({ ok: true }));
  assert.deepEqual(outcome, { ok: true });
  assert.equal(listRefusals(db, { roomId: "room-pw" }).length, 1);
});

test("public-work act(): the live-claim ceiling refusal is journaled at the door", t => {
  const dir = mkdtempSync(join(tmpdir(), "records-refusals-"));
  // In-memory store: file-backed SQLite is an environmental overlay fault
  // in this environment (disk I/O error on unmodified trees too).
  const store = new RoomStore(":memory:", { now: () => nowMs });
  store.initialize(initialRoom());
  store.db.exec(publicWorkClaimsSchema); store.db.exec(publicWorkClaimFenceSchema);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const service = () => new PublicWorkClaims(store);
  const squatter = store.identities.create("Squatter");
  const enable = id => {
    store.projectOffers.create("commons", "owner", { requestId: `create-${id}`, offerId: id, reviewerMemberIds: ["owner"],
      terms: { kind: "task", title: id, summary: "Public result", acceptanceCriteria: ["Deliver the declared change"],
        repositoryUrl: "https://github.com/Example/Project", reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } } });
    store.projectOffers.transition("commons", "owner", id, "publish", { requestId: `publish-${id}`, expectedRevision: 1 });
    return service().enable("commons", "owner", id, { requestId: `enable-${id}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: [`first-shift/${id}.txt`] });
  };
  const ids = Array.from({ length: PUBLIC_WORK_MAX_LIVE_CLAIMS_PER_IDENTITY + 1 }, (_, i) => `ref-task-${i}`);
  for (const id of ids) enable(id);
  for (let i = 0; i < PUBLIC_WORK_MAX_LIVE_CLAIMS_PER_IDENTITY; i++)
    service().act(ids[i], squatter.secret, "claim", { requestId: `claim-${i}`, expectedTermsVersion: 1, leaseHours: 8 });
  assert.throws(() => service().act(ids[3], squatter.secret, "claim", { requestId: "claim-3", expectedTermsVersion: 1, leaseHours: 8 }),
    error => error.code === "public_work_claim_limit");
  const records = listRefusals(store.db, { actorId: squatter.identityId ?? squatter.id });
  const journaled = records.filter(r => r.reasonCode === "public_work_claim_limit");
  assert.ok(journaled.length >= 1, `expected a journaled ceiling refusal, got ${JSON.stringify(records)}`);
  assert.equal(journaled[0].surface, "public-work");
  assert.equal(journaled[0].refusedAction, "claim");
  assert.equal(journaled[0].policyVersion, RECORDS_POLICY_VERSION);
});

test("public-work reviews: a refused review action is journaled", () => {
  const db = new DatabaseSync(":memory:");
  const store = { db, now: () => nowMs };
  const reviews = new PublicWorkReviews(store);
  assert.throws(() => reviews.decide("room-pw", "member-1", "receipt-1", { bogus: true }),
    error => error.code === "invalid_public_review");
  const records = listRefusals(db, { roomId: "room-pw" });
  assert.equal(records.length, 1);
  assert.equal(records[0].refusedAction, "review-decide");
  assert.equal(records[0].subjectId, "receipt-1");
});

// --- R-8 on the board surface ----------------------------------------------

test("board: a refused claim is journaled with the state machine's reason code", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-coord", type: "member.added",
    data: { memberId: "coord", displayName: "Coord", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; error.body = { error: { code, message } }; throw error; },
    body: async req => req.body,
  };
  const call = (route, id, body, member = { id: "owner", kind: "human", permissions: [] }) => handleWorkClaims({
    req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
    res: {}, url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons", auth: { member },
    workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims,
  });
  assert.equal((await call("create", null, { id: "task-1" })).status, 201);
  assert.equal((await call("claim", "task-1", {})).status, 200);
  const refused = await call("claim", "task-1", {}, { id: "coord", kind: "agent", permissions: ["accept_work", "complete_work"] });
  assert.ok(refused.status >= 400, `expected a refusal, got ${refused.status}`);
  const records = listRefusals(store.db, { roomId: "commons", surface: "board" });
  assert.ok(records.length >= 1, "expected a board refusal record");
  assert.equal(records[0].subjectId, "task-1");
  assert.equal(records[0].policyVersion, RECORDS_POLICY_VERSION);
  assert.ok(typeof records[0].reasonCode === "string" && records[0].reasonCode.length > 0);
});
