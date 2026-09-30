// Bounty-escrow HTTP route-handler tests (server/bounty-escrow-routes.mjs).
//
// Calls handleBountyEscrow directly (no http.mjs wiring): the contracts this
// file owns that the over-the-wire suite (tests/bounty-escrow-http.test.js)
// does not isolate — isRoomOwner's fail-closed owner gate, the
// EscrowError→HTTP status mapping, identityOf's bounded decode, strict body
// shapes, idempotent replay at the handler boundary, the reauthorize fence,
// the sybil-resolver owner gate, and publishBountyEvent's fan-out rules.
// Credits are valueless ledger units: no cash-out, no on-chain touch.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { handleBountyEscrow, isRoomOwner, publishBountyEvent } from "../server/bounty-escrow-routes.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";

const ROOM = "room-escrow-routes";
const JILL = "id:agent/jill";       // poster lane
const GROK = "id:agent/grokbot";    // worker lane
const INSTINCT = "id:agent/instinct"; // second worker lane
const OWNER = "owner-human";        // room owner (human)
const STRANGER = "id:agent/stranger"; // not a room member
const NOW = 1_786_000_000_000;
const futureIso = () => new Date(NOW + 3_600_000).toISOString();

// Production-shaped reject: throws a typed error like ServiceError, so the
// test asserts the status/code the router would serialize.
class HttpReject extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const helpers = {
  json: (res, status, value) => { res.statusCode = status; res.body = value; },
  reject: (status, code, message) => { throw new HttpReject(status, code, message); },
  body: async req => {
    if (req._bodyThrows) throw new Error("malformed body");
    return req._body;
  },
};

function makeStore({ members = null } = {}) {
  const db = new DatabaseSync(":memory:");
  ensureAutonomyTiersSchema(db);
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_routes_test");
    try { const out = fn(); db.exec("RELEASE escrow_routes_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_routes_test"); db.exec("RELEASE escrow_routes_test"); throw error; }
  };
  const roomMembers = members ?? {
    [JILL]: { kind: "agent", active: true },
    [GROK]: { kind: "agent", active: true },
    [INSTINCT]: { kind: "agent", active: true },
    [OWNER]: { kind: "human", active: true },
  };
  const fanouts = [];
  const store = {
    db, transaction, readTransaction: transaction,
    roomAuthority: () => ({ ownerId: OWNER, members: roomMembers }),
    agentPlugin: { fanoutRoomEvent: call => { fanouts.push(call); } },
  };
  store.bountyEscrow = new BountyEscrow(store, { now: () => NOW });
  return { store, db, fanouts };
}

const authFor = id => ({ member: { id, kind: id.startsWith("id:agent/") ? "agent" : "human" } });

// Drive handleBountyEscrow like server/http.mjs does; HttpReject becomes the
// serialized {status, body} pair, any other throw propagates (the 500 path).
const call = async (store, { method = "POST", route, bodyData = {}, headers = {},
  authId = JILL, bountyId = null, identity = null, sybilFlagId = null,
  reauthorize = undefined, bodyThrows = false, query = "" }) => {
  const req = {
    method,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    _body: bodyData, _bodyThrows: bodyThrows,
  };
  const res = { statusCode: null, body: null };
  const url = new URL(`http://localhost/api/rooms/${ROOM}/x${query}`);
  const auth = authFor(authId);
  try {
    await handleBountyEscrow({ req, res, url, store, roomId: ROOM, auth,
      escrowRoute: route, bountyId, identity, sybilFlagId,
      reauthorize: reauthorize === undefined ? () => auth : reauthorize,
      helpers });
  } catch (error) {
    if (error instanceof HttpReject) {
      res.statusCode = error.status;
      res.body = { code: error.code, message: error.message };
    } else throw error;
  }
  return res;
};

const bountyBody = (overrides = {}) => ({
  title: "Write the migration guide",
  criteria: "Cover every breaking change with a before/after example.",
  amount: 10,
  deadline: futureIso(),
  ...overrides,
});

// --- isRoomOwner: fail-closed owner gate ------------------------------------

test("isRoomOwner: matching owner id → true", () => {
  const { store } = makeStore();
  assert.equal(isRoomOwner(store, ROOM, authFor(OWNER)), true);
});

test("isRoomOwner: non-owner member → false", () => {
  const { store } = makeStore();
  assert.equal(isRoomOwner(store, ROOM, authFor(JILL)), false);
});

test("isRoomOwner: missing member → false", () => {
  const { store } = makeStore();
  assert.equal(isRoomOwner(store, ROOM, {}), false);
  assert.equal(isRoomOwner(store, ROOM, { member: {} }), false);
});

test("isRoomOwner: store without roomAuthority → false (fails closed)", () => {
  assert.equal(isRoomOwner({}, ROOM, authFor(OWNER)), false);
  assert.equal(isRoomOwner({ roomAuthority: "nope" }, ROOM, authFor(OWNER)), false);
});

test("isRoomOwner: non-string ownerId → false", () => {
  const store = { roomAuthority: () => ({ ownerId: 42 }) };
  assert.equal(isRoomOwner(store, ROOM, authFor(OWNER)), false);
  const nullStore = { roomAuthority: () => ({ ownerId: null }) };
  assert.equal(isRoomOwner(nullStore, ROOM, authFor(OWNER)), false);
});

// --- EscrowError → HTTP status mapping --------------------------------------

test("claim on an unknown bounty → 404 unknown_bounty", async () => {
  const { store } = makeStore();
  const res = await call(store, { route: "claim", bountyId: "ROOM-999" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "unknown_bounty");
});

test("post by a lane outside the room membership → 403 not_authorized", async () => {
  const { store } = makeStore();
  const res = await call(store, { route: "create", bodyData: bountyBody(), authId: STRANGER });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "not_authorized");
});

test("claiming an already-claimed bounty → 409 already_claimed", async () => {
  const { store } = makeStore();
  const created = await call(store, { route: "create", bodyData: bountyBody() });
  const bountyId = created.body.bounty.bountyId;
  await call(store, { route: "fund", bountyId });
  const first = await call(store, { route: "claim", bountyId, authId: GROK });
  assert.equal(first.statusCode, 200);
  const second = await call(store, { route: "claim", bountyId, authId: INSTINCT });
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.code, "already_claimed");
});

test("a non-EscrowError is rethrown untouched (the 500 path, no detail wrap)", async () => {
  const { store } = makeStore();
  const broken = { ...store, transaction: () => { throw new Error("db gone"); } };
  await assert.rejects(
    call(broken, { route: "create", bodyData: bountyBody() }),
    error => error instanceof Error && !(error instanceof HttpReject) && error.message === "db gone");
});

// --- strict body shapes ------------------------------------------------------

test("create missing a required key → 422 invalid_bounty_input", async () => {
  const { store } = makeStore();
  const { title, ...withoutTitle } = bountyBody();
  void title;
  const res = await call(store, { route: "create", bodyData: withoutTitle });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, "invalid_bounty_input");
});

test("create with an unknown key → 422 invalid_bounty_input", async () => {
  const { store } = makeStore();
  const res = await call(store, { route: "create", bodyData: bountyBody({ nope: 1 }) });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, "invalid_bounty_input");
});

test("a malformed body is a 422, matching the room body() contract", async () => {
  const { store } = makeStore();
  const res = await call(store, { route: "create", bodyThrows: true });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, "invalid_bounty_input");
});

// --- idempotency at the handler boundary -------------------------------------

test("a replayed idempotency key returns the original 201/body without re-executing", async () => {
  const { store, fanouts } = makeStore();
  const headers = { "Idempotency-Key": "route-test-key-1" };
  const first = await call(store, { route: "create", bodyData: bountyBody(), headers });
  assert.equal(first.statusCode, 201);
  const second = await call(store, { route: "create", bodyData: bountyBody(), headers });
  assert.equal(second.statusCode, 201);
  assert.deepEqual(second.body, first.body);
  const list = await call(store, { method: "GET", route: "list" });
  assert.equal(list.body.bounties.length, 1);
  assert.equal(fanouts.length, 1, "replay must not fan out a second event");
});

test("an idempotency key reused with different input → 409 idempotency_key_reused", async () => {
  const { store } = makeStore();
  const headers = { "idempotency-key": "route-test-key-2" };
  const first = await call(store, { route: "create", bodyData: bountyBody(), headers });
  assert.equal(first.statusCode, 201);
  const second = await call(store, { route: "create", bodyData: bountyBody({ title: "Different" }), headers });
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.code, "idempotency_key_reused");
});

// --- identityOf: bounded percent-decoded identity -----------------------------

test("balances: percent-encoded lane id with slashes decodes and works", async () => {
  const { store } = makeStore();
  const res = await call(store, { method: "GET", route: "balances", identity: "id%3Aagent%2Fjill" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.balances, "expected a balances payload");
});

test("balances: control characters in the identity → 422", async () => {
  const { store } = makeStore();
  const res = await call(store, { method: "GET", route: "balances", identity: "a%00b" });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, "invalid_bounty_input");
});

test("balances: identity longer than 256 chars → 422", async () => {
  const { store } = makeStore();
  const res = await call(store, { method: "GET", route: "balances", identity: "x".repeat(257) });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, "invalid_bounty_input");
});

test("balances: undecodable percent-encoding → 404, not a 500", async () => {
  const { store } = makeStore();
  const res = await call(store, { method: "GET", route: "balances", identity: "%zz" });
  assert.equal(res.statusCode, 404);
});

// --- lifecycle smoke through the handler -------------------------------------

test("create → fund → claim moves PROPOSED → FUNDED → CLAIMED", async () => {
  const { store } = makeStore();
  const created = await call(store, { route: "create", bodyData: bountyBody() });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.bounty.state, "proposed");
  const bountyId = created.body.bounty.bountyId;
  const funded = await call(store, { route: "fund", bountyId });
  assert.equal(funded.statusCode, 200);
  assert.equal(funded.body.bounty.state, "funded");
  const claimed = await call(store, { route: "claim", bountyId, authId: GROK });
  assert.equal(claimed.statusCode, 200);
  assert.equal(claimed.body.bounty.state, "claimed");
  assert.equal(claimed.body.bounty.claimant, GROK);
});

// --- sybil-resolver owner gate -------------------------------------------------

test("a non-owner resolving a sybil flag → 403 owner_required before the body is read", async () => {
  const { store } = makeStore();
  const res = await call(store, { route: "sybil-dismiss", sybilFlagId: "flag-1",
    bodyData: { reason: "coincidence" }, authId: GROK });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "owner_required");
});

test("the owner resolving an unknown flag → 404 unknown_flag", async () => {
  const { store } = makeStore();
  const res = await call(store, { route: "sybil-confirm", sybilFlagId: "flag-nope",
    bodyData: { reason: "looks coordinated" }, authId: OWNER });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "unknown_flag");
});

// --- reauthorize fence ----------------------------------------------------------

test("a missing reauthorize function → 403 access_denied", async () => {
  const { store } = makeStore();
  const created = await call(store, { route: "create", bodyData: bountyBody() });
  const res = await call(store, { route: "fund", bountyId: created.body.bounty.bountyId,
    reauthorize: null });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "access_denied");
});

test("reauthorize reporting a different member → 403 access_denied", async () => {
  const { store } = makeStore();
  const created = await call(store, { route: "create", bodyData: bountyBody() });
  const res = await call(store, { route: "fund", bountyId: created.body.bounty.bountyId,
    reauthorize: () => authFor(GROK) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "access_denied");
});

// --- method routing ---------------------------------------------------------------

test("GET on the create route → 405 method_not_allowed", async () => {
  const { store } = makeStore();
  const res = await call(store, { method: "GET", route: "create" });
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.code, "method_not_allowed");
});

test("list rejects an unknown ?group= → 422", async () => {
  const { store } = makeStore();
  const res = await call(store, { method: "GET", route: "list", query: "?group=bogus" });
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.code, "invalid_bounty_input");
});

// --- publishBountyEvent fan-out rules ----------------------------------------------

test("publishBountyEvent: no agentPlugin → no-op; a throwing fanout is swallowed", () => {
  assert.doesNotThrow(() => publishBountyEvent({}, ROOM, null));
  assert.doesNotThrow(() => publishBountyEvent({}, ROOM, { seq: 1, type: "bounty.proposed" }));
  const throwing = { agentPlugin: { fanoutRoomEvent: () => { throw new Error("webhook down"); } } };
  assert.doesNotThrow(() => publishBountyEvent(throwing, ROOM,
    { seq: 7, type: "bounty.funded", bountyId: "ROOM-1", actor: { kind: "agent", id: JILL } }));
});

test("publishBountyEvent maps the journal event to the fanout envelope", () => {
  const seen = [];
  const store = { agentPlugin: { fanoutRoomEvent: call => seen.push(call) } };
  publishBountyEvent(store, ROOM, { seq: 7, type: "bounty.funded", bountyId: "ROOM-1",
    actor: { kind: "agent", id: JILL }, before: "proposed", after: "funded",
    data: { amount: 10 } });
  assert.equal(seen.length, 1);
  const event = seen[0].event;
  assert.equal(seen[0].roomId, ROOM);
  assert.equal(event.id, "bounty-event-7");
  assert.equal(event.type, "bounty.funded");
  assert.equal(event.data.bountyId, "ROOM-1");
  assert.equal(event.data.before, "proposed");
  assert.equal(event.data.after, "funded");
});
