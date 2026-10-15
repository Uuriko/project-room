// #3377: authorizeSpend's crash-recovery reaper must commit independently
// of the authorize it precedes.
//
// Before the fix the reap ran INSIDE authorizeSpend's transaction, so any
// refusal thrown in that transaction (per-tx cap, cap, allowlist,
// single-use, room allowance, revoked/expired grant) rolled the reaper's
// voids back with it. Expired reservations kept consuming grant cap and
// room headroom until some later authorize happened to COMMIT — and the
// standalone reaper has no production caller, so the in-authorize reap is
// the only one production has. A revoked grant (every authorize refused)
// made the pollution permanent. W5 found this with a deterministic repro
// (w5-harness/repro-spend-reap-rollback.mjs); these tests pin the sequence
// at the module level and at the production charge boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { registerBareTransactions } from "./helpers/bare-db-transactions.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { ensureGrantsSchema } from "../server/grants.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";
import {
  ensureSpendGrantsSchema, issueSpendGrant, authorizeSpend, revokeSpendGrant,
  spendGrantSummary, chargeSpendBeforeCall, RESERVE_LEASE_MS,
} from "../server/spend-grants.mjs";

const ROOM = "reaper-room";
const AGENT = "agent-a";
const T0 = 1_786_000_000_000;
const T1 = T0 + RESERVE_LEASE_MS + 60_000; // DEAD's lease is long past

function bareDb() {
  const db = registerBareTransactions(new DatabaseSync(":memory:"));
  ensureGrantsSchema(db);
  ensureAutonomyTiersSchema(db);
  ensureSpendGrantsSchema(db);
  return db;
}

const authStatus = (db, nonce) =>
  db.prepare("SELECT status FROM spend_authorizations WHERE room_id = ? AND nonce = ?").get(ROOM, nonce)?.status;
const roomRowStatus = (db, nonce) =>
  db.prepare("SELECT status FROM spend_room_reservations WHERE room_id = ? AND nonce = ?").get(ROOM, nonce)?.status;

// Seed: grant cap 100 / per-tx 50, and a 50c reservation (with a room
// reservation against a 100c allowance) whose caller "crashes" — no
// settle, no void.
function seedDead(db) {
  issueSpendGrant(db, ROOM, AGENT, { grantedBy: "owner", capCents: "100", perTxCapCents: "50", nowMs: T0 });
  authorizeSpend(db, { roomId: ROOM, agentId: AGENT, toolName: "room_put_file", priceCents: 50,
    nonce: "DEAD", nowMs: T0, roomAllowanceCents: 100, roomCommittedCents: 0 });
  assert.equal(authStatus(db, "DEAD"), "reserved");
  assert.equal(roomRowStatus(db, "DEAD"), "active");
}

test("a refused authorize still commits the reap (per-tx refusal)", () => {
  const db = bareDb();
  seedDead(db);
  assert.throws(
    () => authorizeSpend(db, { roomId: ROOM, agentId: AGENT, toolName: "room_put_file", priceCents: 51, nonce: "TRY1", nowMs: T1 }),
    error => error.code === "payment_required" && error.detail?.reason === "per_tx_cap_exceeded");
  assert.equal(authStatus(db, "DEAD"), "voided",
    "the refused authorize must not roll the reap back: DEAD is voided");
  assert.equal(roomRowStatus(db, "DEAD"), "released",
    "the reap releases DEAD's room reservation with the void");
  assert.equal(spendGrantSummary(db, ROOM, AGENT)?.remainingCents, "100",
    "the dead reservation no longer consumes grant cap");
  // And the room still works: a valid authorize afterwards succeeds.
  authorizeSpend(db, { roomId: ROOM, agentId: AGENT, toolName: "room_put_file", priceCents: 5, nonce: "TRY2", nowMs: T1 });
  assert.equal(authStatus(db, "DEAD"), "voided");
});

test("a revoked grant's refused authorizes still reap (no permanent pollution)", () => {
  const db = bareDb();
  seedDead(db);
  revokeSpendGrant(db, ROOM, AGENT, { nowMs: T0 + 1000 });
  assert.throws(
    () => authorizeSpend(db, { roomId: ROOM, agentId: AGENT, toolName: "room_put_file", priceCents: 5, nonce: "TRY1", nowMs: T1 }),
    error => error.code === "payment_required" && error.detail?.reason === "grant_revoked");
  assert.equal(authStatus(db, "DEAD"), "voided",
    "even when every authorize is refused, the expired reservation is reaped");
  assert.equal(roomRowStatus(db, "DEAD"), "released");
});

test("a successful authorize still reaps first (unchanged path)", () => {
  const db = bareDb();
  seedDead(db);
  authorizeSpend(db, { roomId: ROOM, agentId: AGENT, toolName: "room_put_file", priceCents: 5, nonce: "TRY1", nowMs: T1 });
  assert.equal(authStatus(db, "DEAD"), "voided");
  assert.equal(roomRowStatus(db, "DEAD"), "released");
});

test("a refused authorize never reaps a live (unexpired) reservation", () => {
  const db = bareDb();
  seedDead(db);
  assert.throws(
    () => authorizeSpend(db, { roomId: ROOM, agentId: AGENT, toolName: "room_put_file", priceCents: 51, nonce: "TRY1", nowMs: T0 + 1000 }),
    error => error.code === "payment_required" && error.detail?.reason === "per_tx_cap_exceeded");
  assert.equal(authStatus(db, "DEAD"), "reserved",
    "a reservation still inside its lease is not the reaper's to void");
  assert.equal(roomRowStatus(db, "DEAD"), "active");
});

// Production boundary: chargeSpendBeforeCall wraps authorizeSpend in
// store.transaction, so the reap must be committed BEFORE that transaction
// opens — an entry reap inside authorizeSpend alone would still share the
// outer transaction and roll back with its refusal.
test("chargeSpendBeforeCall commits the reap even when the charge is refused", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-reaper-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureSpendGrantsSchema(store.db);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });
  const owner = store.identities.create("Owen");
  const peer = store.identities.create("Peer agent");
  const created = rooms.create(owner.secret, { title: "Reaper room", purpose: "x", displayName: "Owner" });
  const roomId = created.roomId;
  const ownerMemberId = created.ownerMemberId ?? owner.identityId;
  const invite = store.invites.create(owner.secret, roomId, { profile: "chat", displayName: "Peer agent" }, null);
  const joined = store.invites.redeem(invite.code, { displayName: "Peer agent", identitySecret: peer.secret });
  const peerMemberId = joined.memberId ?? joined.member?.id;
  assert.ok(peerMemberId, "peer member id missing from redeem response");
  setTier(store.db, roomId, peerMemberId, "t2_standard", { updatedBy: ownerMemberId, nowMs: Date.now() });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  // Seed an expired reservation, then revoke the grant: every charge the
  // boundary attempts is refused, forever — the issue's permanent case.
  const past = Date.now() - RESERVE_LEASE_MS - 60_000;
  issueSpendGrant(store.db, roomId, peerMemberId, {
    grantedBy: ownerMemberId, capCents: "100", perTxCapCents: "50", nowMs: past });
  authorizeSpend(store.db, { roomId, agentId: peerMemberId, toolName: "room_put_file", priceCents: 50, nonce: "DEAD", nowMs: past });
  revokeSpendGrant(store.db, roomId, peerMemberId, { nowMs: Date.now() });

  assert.throws(
    () => chargeSpendBeforeCall(store, peer.secret, "room_put_file", { roomId }),
    error => error.code === "payment_required" && error.detail?.reason === "grant_revoked");
  const dead = store.db.prepare("SELECT status FROM spend_authorizations WHERE room_id = ? AND nonce = 'DEAD'").get(roomId);
  assert.equal(dead?.status, "voided",
    "the boundary's refused charge still committed the reap of the expired reservation");
});
