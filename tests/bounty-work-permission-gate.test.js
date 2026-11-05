// F-X4-1 (UT-MIXED X4, confirmed by V1): the money face had no profile gate.
// A member whose disclosed permissions are [] — refused every board write
// with 403 work_claims_not_permitted — could claim a funded bounty (bond
// locked) and submit on it, 200/200. Bounty claim and submit must enforce
// the same work-permission gate the board face enforces
// (mayWriteWorkClaims, server/work-claim-routes.mjs), refusing a
// chat/no-work member with the same 403 class before any money moves.
//
// Harness: handleBountyEscrow driven directly, following
// tests/bounty-escrow-routes.test.js. Members carry explicit permissions —
// the gate reads the room's live membership (store.roomAuthority), so a
// profile revoked between claim and submit refuses the submit.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { handleBountyEscrow } from "../server/bounty-escrow-routes.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";

const ROOM = "room-bounty-gate";
const OWNER = "owner-human";
const POSTER = "id:agent/poster";
const WORKER = "id:agent/worker";
const REVIEWER = "id:agent/reviewer";
const CHAT_HUMAN = "chat-human";
const CHAT_AGENT = "id:agent/chatagent";
const NOW = 1_786_000_000_000;
const futureIso = () => new Date(NOW + 3_600_000).toISOString();

const CONTRIBUTOR = ["accept_work", "complete_work"];

class HttpReject extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const helpers = {
  json: (res, status, value) => { res.statusCode = status; res.body = value; },
  reject: (status, code, message) => { throw new HttpReject(status, code, message); },
  body: async req => req._body,
};

function makeStore() {
  const db = new DatabaseSync(":memory:");
  ensureAutonomyTiersSchema(db);
  const transaction = fn => {
    db.exec("SAVEPOINT bounty_gate_test");
    try { const out = fn(); db.exec("RELEASE bounty_gate_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO bounty_gate_test"); db.exec("RELEASE bounty_gate_test"); throw error; }
  };
  const members = {
    [OWNER]: { kind: "human", active: true, permissions: ["steer", "decide", "manage_members", "manage_claims", "accept_work", "complete_work", "verify", "write_external", "invite_member"] },
    [POSTER]: { kind: "agent", active: true, permissions: [...CONTRIBUTOR] },
    [WORKER]: { kind: "agent", active: true, permissions: [...CONTRIBUTOR] },
    [REVIEWER]: { kind: "agent", active: true, permissions: ["verify"] },
    [CHAT_HUMAN]: { kind: "human", active: true, permissions: [] },
    [CHAT_AGENT]: { kind: "agent", active: true, permissions: [] },
  };
  const store = {
    db, transaction, readTransaction: transaction,
    roomAuthority: () => ({ ownerId: OWNER, members }),
    agentPlugin: { fanoutRoomEvent: () => {} },
  };
  store.bountyEscrow = new BountyEscrow(store, { now: () => NOW });
  return { store, members };
}

const authFor = id => ({ member: { id, kind: id.startsWith("id:agent/") ? "agent" : "human" } });

const call = async (store, { method = "POST", route, bodyData = {}, authId = POSTER, bountyId = null }) => {
  const req = { method, headers: {}, _body: bodyData };
  const res = { statusCode: null, body: null };
  const url = new URL(`http://localhost/api/rooms/${ROOM}/x`);
  const auth = authFor(authId);
  try {
    await handleBountyEscrow({ req, res, url, store, roomId: ROOM, auth,
      escrowRoute: route, bountyId, identity: null, sybilFlagId: null,
      reauthorize: () => auth, helpers });
  } catch (error) {
    if (error instanceof HttpReject) {
      res.statusCode = error.status;
      res.body = { code: error.code, message: error.message };
    } else throw error;
  }
  return res;
};

const bountyBody = () => ({
  title: "Write the migration guide",
  criteria: "Cover every breaking change.",
  amount: 10,
  deadline: futureIso(),
});

const fundedBounty = async store => {
  const created = await call(store, { route: "create", bodyData: bountyBody(), authId: POSTER });
  assert.equal(created.statusCode, 201, `setup create failed: ${JSON.stringify(created.body)}`);
  const bountyId = created.body.bounty.bountyId;
  const funded = await call(store, { route: "fund", bountyId, authId: POSTER });
  assert.equal(funded.statusCode, 200, `setup fund failed: ${JSON.stringify(funded.body)}`);
  return bountyId;
};

const submitBody = () => ({ evidenceUrl: "https://example.com/work", summary: "done" });

test("F-X4-1: a zero-permission human member cannot claim a funded bounty", async () => {
  const { store } = makeStore();
  store.bountyEscrow.ensureGenesis(ROOM);
  const bountyId = await fundedBounty(store);
  const before = store.bountyEscrow.balances(ROOM, CHAT_HUMAN);
  const res = await call(store, { route: "claim", bountyId, authId: CHAT_HUMAN });
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, "work_claims_not_permitted");
  const list = await call(store, { method: "GET", route: "list", authId: OWNER });
  const bounty = list.body.bounties.find(b => b.bountyId === bountyId);
  assert.equal(bounty.state, "funded", "a refused claim must not move the bounty");
  assert.equal(bounty.claimant, null);
  assert.deepEqual(store.bountyEscrow.balances(ROOM, CHAT_HUMAN), before,
    "a refused claim must not lock the claim bond");
});

test("F-X4-1: a zero-permission agent member cannot claim a funded bounty", async () => {
  const { store } = makeStore();
  store.bountyEscrow.ensureGenesis(ROOM);
  const bountyId = await fundedBounty(store);
  const res = await call(store, { route: "claim", bountyId, authId: CHAT_AGENT });
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, "work_claims_not_permitted");
});

test("F-X4-1: a member whose profile is revoked to [] after claiming cannot submit", async () => {
  const { store, members } = makeStore();
  store.bountyEscrow.ensureGenesis(ROOM);
  const bountyId = await fundedBounty(store);
  const claimed = await call(store, { route: "claim", bountyId, authId: WORKER });
  assert.equal(claimed.statusCode, 200, `setup claim failed: ${JSON.stringify(claimed.body)}`);
  // The owner revokes the work profile live (roomAuthority is read fresh).
  members[WORKER].permissions = [];
  const res = await call(store, { route: "submit", bountyId, authId: WORKER, bodyData: submitBody() });
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, "work_claims_not_permitted");
  const list = await call(store, { method: "GET", route: "list", authId: OWNER });
  assert.equal(list.body.bounties.find(b => b.bountyId === bountyId).state, "claimed",
    "a refused submit must not move the bounty");
});

test("control: a contribute-profile member claims and submits (200/200)", async () => {
  const { store } = makeStore();
  store.bountyEscrow.ensureGenesis(ROOM);
  const bountyId = await fundedBounty(store);
  const claimed = await call(store, { route: "claim", bountyId, authId: WORKER });
  assert.equal(claimed.statusCode, 200, `claim failed: ${JSON.stringify(claimed.body)}`);
  const submitted = await call(store, { route: "submit", bountyId, authId: WORKER, bodyData: submitBody() });
  assert.equal(submitted.statusCode, 200, `submit failed: ${JSON.stringify(submitted.body)}`);
  assert.equal(submitted.body.bounty.state, "submitted");
});

test("control: gate parity with the board — a review-profile member may claim", async () => {
  const { store } = makeStore();
  store.bountyEscrow.ensureGenesis(ROOM);
  const bountyId = await fundedBounty(store);
  const claimed = await call(store, { route: "claim", bountyId, authId: REVIEWER });
  assert.equal(claimed.statusCode, 200, `review-profile claim failed: ${JSON.stringify(claimed.body)}`);
});

test("control: the room owner may claim a bounty posted by another member", async () => {
  const { store } = makeStore();
  store.bountyEscrow.ensureGenesis(ROOM);
  const bountyId = await fundedBounty(store);
  const claimed = await call(store, { route: "claim", bountyId, authId: OWNER });
  assert.equal(claimed.statusCode, 200, `owner claim failed: ${JSON.stringify(claimed.body)}`);
});

test("control: the poster still cannot claim their own bounty (existing rule intact)", async () => {
  const { store } = makeStore();
  store.bountyEscrow.ensureGenesis(ROOM);
  const bountyId = await fundedBounty(store);
  const res = await call(store, { route: "claim", bountyId, authId: POSTER });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "not_authorized");
});
