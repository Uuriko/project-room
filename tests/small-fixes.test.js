// SMALL-FIXES pooled lane specimens (2026-10-20):
//  (1) MONEY-2 F-2 — a refused bounty claim writes a journal-visible refusal
//      record (bounty.claim_refused event) and moves no money.
//  (2) Batch C (5) — state refusals (invalid_state / dispute_unavailable) do
//      not carry the "correct the named fields" hint; they get a
//      state-appropriate hint instead.
//      Batch C (6) — file_lease_conflict's next names the advisory:true
//      soft-claim escape.
//      Batch C (7) — the dependencies-unmet message no longer prescribes the
//      bogus "reassign the dependency" recovery.
//  (3) web-research — an unavailable docs corpus (env split) is loud in the
//      research result's fetch_errors, never a silent empty leg.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { agentErrorBody } from "../src/agent-error.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { WebResearch, webResearchSchema, researchKeywords } from "../server/web-research.mjs";

// ---------------------------------------------------------------- item (1)
const ROOM = "room-small-fixes";
const POSTER = "id:agent/jill";
const WORKER = "id:agent/grokbot";
const SECOND = "id:agent/instinct";
let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT sf_test");
    try { const out = fn(); db.exec("RELEASE sf_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO sf_test"); db.exec("RELEASE sf_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return escrow;
}

const refusals = (escrow, bountyId) =>
  escrow.listEvents(ROOM).filter(e => e.type === "bounty.claim_refused" && e.bountyId === bountyId);

test("item 1: a refused claim (already_claimed) writes a journal-visible refusal record and moves no money", () => {
  const escrow = makeEscrow();
  const bounty = escrow.postBounty(ROOM,
    { poster: POSTER, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: POSTER });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: WORKER });
  assert.equal(refusals(escrow, bounty.bountyId).length, 0, "a successful claim writes no refusal record");

  const before = escrow.balances(ROOM, SECOND);
  assert.throws(() => escrow.claimBounty(ROOM, bounty.bountyId, { claimant: SECOND }),
    error => error.code === "already_claimed");

  const records = refusals(escrow, bounty.bountyId);
  assert.equal(records.length, 1, "exactly one refusal record for the refused attempt");
  assert.equal(records[0].actor.id, SECOND);
  assert.equal(records[0].data.code, "already_claimed");
  assert.equal(records[0].data.claimant, SECOND);
  assert.match(records[0].data.reason, /already claimed/);

  // No money moved and no movement receipts appeared for the refused lane:
  // its history still holds only the genesis receipt, balances are unchanged,
  // and conservation still verifies.
  assert.deepEqual(escrow.balances(ROOM, SECOND), before);
  assert.deepEqual(escrow.history(ROOM, SECOND).map(r => r.kind), ["genesis"]);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("item 1: every refused claim attempt is journaled, including a poster self-claim", () => {
  const escrow = makeEscrow();
  const bounty = escrow.postBounty(ROOM,
    { poster: POSTER, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: POSTER });
  assert.throws(() => escrow.claimBounty(ROOM, bounty.bountyId, { claimant: POSTER }),
    error => error.code === "not_authorized");
  assert.throws(() => escrow.claimBounty(ROOM, bounty.bountyId, { claimant: POSTER }),
    error => error.code === "not_authorized");
  const records = refusals(escrow, bounty.bountyId);
  assert.equal(records.length, 2, "one record per refused attempt");
  assert.ok(records.every(r => r.data.code === "not_authorized" && r.actor.id === POSTER));
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

// ---------------------------------------------------------------- item (2)(5)
test("item 2(5): a state refusal does not prescribe correcting fields; it names the state recovery", () => {
  const body = agentErrorBody({ httpStatus: 422, code: "invalid_state",
    message: "bounty is submitted, not disputable: disputes open only on accepted work", roomId: "r1" });
  const nextText = body.next.map(step => step.command ?? "").join(" ");
  assert.doesNotMatch(body.hint, /named fields/i);
  assert.doesNotMatch(nextText, /correct the named fields/i);
  assert.match(body.hint + " " + nextText, /state/i);
});

test("item 2(5): dispute_unavailable likewise drops the field-correction prescription", () => {
  const body = agentErrorBody({ httpStatus: 422, code: "dispute_unavailable",
    message: "dispute is unavailable for this bounty: no designated decider — a dispute needs a dispute decider (or verifier) named at posting to seat its decider",
    roomId: "r1" });
  const nextText = body.next.map(step => step.command ?? "").join(" ");
  assert.doesNotMatch(body.hint, /named fields/i);
  assert.doesNotMatch(nextText, /correct the named fields/i);
  assert.match(body.hint + " " + nextText, /decider/i);
});

// ---------------------------------------------------------------- item (2)(6)
test("item 2(6): file_lease_conflict's next names the advisory:true soft-claim escape", () => {
  const body = agentErrorBody({ httpStatus: 409, code: "file_lease_conflict",
    message: "Work \"w1\" overlaps files leased to id:agent/holder (held-claim) until 2026-10-21T00:00:00.000Z: src/a.js",
    roomId: "r1", workItemId: "w1" });
  const nextText = body.next.map(step => step.command ?? "").join(" ");
  assert.match(nextText, /advisory: true/);
  assert.doesNotMatch(nextText, /do not force/i);
  assert.match(body.hint, /advisory: true/);
});

// ---------------------------------------------------------------- item (2)(7)
const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work", "verify", "steer"] },
  contribute: { id: "contribute", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};
const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};
const claimCall = (registry, memberId, route, id, body) => handleWorkClaims({
  req: { method: "POST", body },
  res: {},
  url: new URL("https://room.example/api/rooms/room1/work-claims"),
  store: { roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }), room: () => ({ state: { messages: [] } }) },
  roomId: "room1",
  auth: { member: { id: memberId, kind: MEMBERS[memberId].kind, permissions: MEMBERS[memberId].permissions } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});

test("item 2(7): the dependencies-unmet refusal drops the reassign-the-dependency clause", async () => {
  const registry = createWorkClaimRegistry();
  assert.equal((await claimCall(registry, "owner", "create", null, { id: "dep" })).status, 201);
  assert.equal((await claimCall(registry, "owner", "create", null, { id: "blocked", dependsOn: ["dep"] })).status, 201);
  let refused;
  try {
    const result = await claimCall(registry, "contribute", "claim", "blocked", {});
    refused = { status: result.status, code: result.value?.error?.code, message: result.value?.error?.message };
  } catch (error) {
    refused = { status: error.status, code: error.code, message: error.message };
  }
  assert.equal(refused.status, 409);
  assert.equal(refused.code, "work_claim_dependencies_unmet");
  assert.match(refused.message, /"dep" \(unclaimed\)/);
  assert.match(refused.message, /Finish those first\./);
  assert.doesNotMatch(refused.message, /reassign the dependency/i);
});

// ---------------------------------------------------------------- item (3)
function makeResearch(serviceOpts = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(webResearchSchema);
  db.exec("CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY)");
  db.prepare("INSERT OR IGNORE INTO rooms(id) VALUES('room1')").run();
  db.exec(`CREATE TABLE IF NOT EXISTS web_fetch_cache (
    key TEXT PRIMARY KEY, url TEXT NOT NULL, final_url TEXT NOT NULL,
    markdown TEXT NOT NULL, metadata_json TEXT NOT NULL, bytes INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS web_fetch_cache_rooms (
    cache_key TEXT NOT NULL, room_id TEXT NOT NULL, fetched_at INTEGER NOT NULL,
    PRIMARY KEY (cache_key, room_id))`);
  const store = { db, now: () => 1_000_000, webFetch: null };
  return new WebResearch(store, serviceOpts);
}

test("item 3: an unavailable docs corpus is loud in the result, not a silent empty leg", async () => {
  // docsRoot: null is the explicit "no corpus in this runtime" contract (the
  // bundled/worker env split, where import.meta.url resolves no filesystem
  // path and defaultCorpusRoots() returns null).
  const service = makeResearch({ docsRoot: null });
  const plan = service.plan({ question: "what does the deployment guide say", sources: ["docs"], urls: [] });
  const docsLeg = plan.find(leg => leg.source === "docs");
  assert.equal(docsLeg.status, "skipped");
  assert.match(docsLeg.reason, /unavailable/);

  const result = await service.research("room1", "member1",
    { question: "what does the deployment guide say", sources: ["docs"] });
  assert.equal(result.evidence.length, 0);
  const resultLeg = result.plan.find(leg => leg.source === "docs");
  assert.equal(resultLeg.status, "skipped");
  assert.match(resultLeg.reason, /unavailable/);

  // And the leg itself refuses loudly if it is ever reached with no corpus
  // (roots resolving to null between planning and search, or a direct
  // caller): a coded failure, never a silent empty result.
  assert.throws(
    () => service.searchDocs({ question: "deployment guide", maxEvidence: 3 },
      researchKeywords("deployment guide"), "req-1", 1_000_000),
    error => error.code === "docs_corpus_unavailable");
});
