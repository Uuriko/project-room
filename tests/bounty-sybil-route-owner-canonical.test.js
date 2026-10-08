// Challenge ch-2043 vs PR #2043 (QA200-REG-04).
//
// PR #2043 fixed the STORE-level owner gate (_requireRoomOwner) to compare
// canonical lane forms. The ROUTE-level owner gate — isRoomOwner() in
// server/bounty-escrow-routes.mjs, which guards the SAME sybil-dismiss /
// sybil-confirm endpoint at two points (before the body is read AND inside
// the idempotent transaction) — still compares RAW ids. Any form mismatch
// between auth.member.id (from the credential/member record) and
// roomAuthority().ownerId (from the room projection) locks the real owner
// out with 403 owner_required before the fixed store gate ever runs.
//
// Reachability: legacy colon-form ids (id:agent:jill) exist in production
// data (PR #2043's own motivating fact); member records may be keyed in
// either form (the codebase canonicalizes defensively everywhere else —
// canonicalLane's docstring, _memberOf's colon fallback, memberLaneIds).
// server/agent-identities.mjs link() accepts a caller-supplied memberId and
// does a STRICT own-key lookup (no colon fallback), so linking an identity
// with the canonical form of an id whose member record is colon-form
// creates a second canonical-form member record for the same account —
// after which auth.member.id is canonical while room.ownerId stays colon.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow as StoreEscrow, bountyEscrowSchema } from "../server/bounty-escrow.mjs";
import { handleBountyEscrow, isRoomOwner } from "../server/bounty-escrow-routes.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";

const ROOM = "room-sybil-route-canonical";
const OWNER_COLON = "id:agent:jill";    // legacy colon form
const OWNER_CANON = "id:agent/jill";    // canonical form — same account
const GROK_COLON = "id:agent:grokbot";
const GROK_CANON = "id:agent/grokbot";
const NOW = 1_786_000_000_000;

class HttpReject extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const helpers = {
  json: (res, status, value) => { res.statusCode = status; res.body = value; },
  reject: (status, code, message) => { throw new HttpReject(status, code, message); },
  body: async req => req._body,
};

function makeStore({ ownerId, memberIds }) {
  const db = new DatabaseSync(":memory:");
  ensureAutonomyTiersSchema(db);
  const transaction = fn => {
    db.exec("SAVEPOINT ch2043");
    try { const out = fn(); db.exec("RELEASE ch2043"); return out; }
    catch (error) { db.exec("ROLLBACK TO ch2043"); db.exec("RELEASE ch2043"); throw error; }
  };
  const members = {};
  for (const id of memberIds) members[id] = { id, kind: "agent", active: true };
  const store = { db, transaction, readTransaction: transaction,
    roomAuthority: () => ({ ownerId, members }),
    agentPlugin: { fanoutRoomEvent: () => {} } };
  store.bountyEscrow = new StoreEscrow(store, { now: () => NOW });
  return store;
}

const authFor = id => ({ member: { id, kind: "agent" } });

const callDismiss = async (store, authId) => {
  const req = { method: "POST", headers: {}, _body: { reason: "looks fine" } };
  const res = { statusCode: null, body: null };
  const url = new URL(`http://localhost/api/rooms/${ROOM}/x`);
  const auth = authFor(authId);
  try {
    await handleBountyEscrow({ req, res, url, store, roomId: ROOM, auth,
      escrowRoute: "sybil-dismiss", bountyId: null, identity: null,
      sybilFlagId: "flag-missing", reauthorize: () => auth, helpers });
  } catch (error) {
    if (error instanceof HttpReject) { res.statusCode = error.status; res.body = { code: error.code }; }
    else throw error;
  }
  return res;
};

// --- the hole: mixed-form owner is rejected by the route gate --------------

test("isRoomOwner: colon ownerId + canonical auth member id → true (same account)", () => {
  const store = makeStore({ ownerId: OWNER_COLON, memberIds: [OWNER_COLON, GROK_COLON] });
  assert.equal(isRoomOwner(store, ROOM, authFor(OWNER_CANON)), true);
});

test("isRoomOwner: canonical ownerId + colon auth member id → true (same account)", () => {
  const store = makeStore({ ownerId: OWNER_CANON, memberIds: [OWNER_CANON, GROK_CANON] });
  assert.equal(isRoomOwner(store, ROOM, authFor(OWNER_COLON)), true);
});

test("sybil-dismiss: mixed-form owner passes the route gate (not 403 owner_required)", async () => {
  const store = makeStore({ ownerId: OWNER_COLON, memberIds: [OWNER_COLON, GROK_COLON] });
  const res = await callDismiss(store, OWNER_CANON);
  // The flag does not exist, so a gate that lets the owner through reaches
  // the store layer and answers 404 unknown_flag — never 403 owner_required.
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "unknown_flag");
});

// --- no false-open: the fix must not admit non-owners -----------------------

test("isRoomOwner: colon non-owner in either form → false", () => {
  const store = makeStore({ ownerId: OWNER_COLON, memberIds: [OWNER_COLON, GROK_COLON] });
  assert.equal(isRoomOwner(store, ROOM, authFor(GROK_COLON)), false);
  assert.equal(isRoomOwner(store, ROOM, authFor(GROK_CANON)), false);
});

test("isRoomOwner: empty/garbage ownerId still fails closed", () => {
  const emptyOwner = makeStore({ ownerId: "", memberIds: [OWNER_COLON] });
  assert.equal(isRoomOwner(emptyOwner, ROOM, authFor(OWNER_COLON)), false);
  const nullOwner = makeStore({ ownerId: null, memberIds: [OWNER_COLON] });
  assert.equal(isRoomOwner(nullOwner, ROOM, authFor(OWNER_COLON)), false);
  const store = makeStore({ ownerId: OWNER_COLON, memberIds: [OWNER_COLON] });
  assert.equal(isRoomOwner(store, ROOM, authFor("id:agent:mallory")), false);
});

test("sybil-dismiss: non-owner still gets 403 owner_required", async () => {
  const store = makeStore({ ownerId: OWNER_COLON, memberIds: [OWNER_COLON, GROK_COLON] });
  const res = await callDismiss(store, GROK_CANON);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "owner_required");
});

// --- store gate contract: corrupt (empty) ownerId fails closed as --------
// --- not_authorized, per _requireRoomOwner's documented contract ----------

test("store owner gate: empty-string ownerId is not_authorized (not invalid_input)", () => {
  // canonicalLane throws invalid_input on empty strings; the gate must not
  // leak that — a missing/corrupt owner id is an authorization failure.
  const db = new DatabaseSync(":memory:");
  db.exec(bountyEscrowSchema);
  const transaction = fn => {
    db.exec("SAVEPOINT ch2043b1");
    try { const out = fn(); db.exec("RELEASE ch2043b1"); return out; }
    catch (error) { db.exec("ROLLBACK TO ch2043b1"); db.exec("RELEASE ch2043b1"); throw error; }
  };
  const members = {
    [OWNER_COLON]: { active: true, kind: "agent" },
    [GROK_COLON]: { active: true, kind: "agent" },
    ["id:agent:codex"]: { active: true, kind: "agent" },
  };
  const store = { db, transaction, readTransaction: transaction,
    roomAuthority: () => ({ ownerId: "", members }) };
  const escrow = new StoreEscrow(store, { now: () => NOW });
  escrow.ensureGenesis(ROOM);
  const evidence = { evidenceUrl: "https://example.com/p", evidenceKind: "work.completed",
    summary: "identical work", checksClaimed: ["lint"], producerId: "x" };
  const deadline = new Date(NOW + 3_600_000).toISOString();
  const submitFor = lane => {
    const { bountyId } = escrow.postBounty(ROOM,
      { poster: OWNER_COLON, title: "T", criteria: "C", amount: 10, deadline }).bounty;
    escrow.fundBounty(ROOM, bountyId, { funder: OWNER_COLON });
    escrow.claimBounty(ROOM, bountyId, { claimant: lane });
    return escrow.submitWork(ROOM, bountyId, { claimant: lane, evidence });
  };
  submitFor(GROK_COLON);
  const { flags } = submitFor("id:agent:codex");
  assert.equal(flags.length, 1, "expected one copy-paste flag");
  const flagId = flags[0].flagId;
  assert.throws(() => escrow.resolveSybilFlag(ROOM, flagId,
      { resolution: "dismissed", reason: "x", resolver: OWNER_COLON }),
    error => error.code === "not_authorized" && /only the room owner/.test(error.message));
});
