// Member spend default (ruling 29b): the per-room purse agent members
// authorize against when they hold no spend grant, ending the zero-grant
// dead-end VERIFY-PROBES executed (grantless room_put_file → 402
// no_spend_grant even though the member did nothing wrong).
//
// Contracts owned here (the charter's five proof legs, executed through
// exported production functions and the real tools/call boundary):
// 1. a grantless agent member completes put+commit inside the purse;
//    charges attribute to member+room on spend_authorizations
// 2. the charge that would exceed the purse refuses with the honest 402
//    shape (reason default_allowance_exceeded) and charges nothing
// 3. an explicit grant composes over the purse: no double-count, no
//    shadow balance; revocation refuses as grant_revoked, never falls
//    back to the purse
// 4. owner sets the purse to 0 → the member's next priced call returns
//    today's exact 402 (payment_required / no_spend_grant)
// 5. owner and human members are never charged, purse or not
// Plus the setting surface: owner-only set, validated shape, member read
// with owner-only per-member consumption, and the self-read summary.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { ensureSpendGrantsSchema } from "../server/spend-grants.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { EVENT_TYPES as T, MEMBER_SPEND_DEFAULT_CENTS } from "../src/events.js";
import {
  SpendGrantError,
  issueSpendGrant,
  revokeSpendGrant,
  spendGrantSummary,
  memberSpendDefaultSummary,
  authorizeSpend,
  chargeSpendBeforeCall,
  readSpendGrantRoute,
  readSpendDefaultRoute,
  setSpendDefaultRoute,
} from "../server/spend-grants.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-default-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureSpendGrantsSchema(store.db);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms };
}

const rpc = (method, params) => ({ jsonrpc: "2.0", id: "c", method, ...(params === undefined ? {} : { params }) });

// Owner + one t2 agent peer, mirroring tests/spend-grants.test.js.
function roomWithPeer(t) {
  const { store, rooms } = setup(t);
  const owner = store.identities.create("Owen");
  const peer = store.identities.create("Peer agent");
  const created = rooms.create(owner.secret, { title: "Spend room", purpose: "Paid tools", displayName: "Owner" });
  const roomId = created.roomId;
  const ownerMemberId = created.ownerMemberId ?? owner.identityId;
  const invite = store.invites.create(owner.secret, roomId, { profile: "chat", displayName: "Peer agent" }, null);
  const joined = store.invites.redeem(invite.code, { displayName: "Peer agent", identitySecret: peer.secret });
  const peerMemberId = joined.memberId ?? joined.member?.id;
  assert.ok(peerMemberId, "peer member id missing from redeem response");
  setTier(store.db, roomId, peerMemberId, "t2_standard", { updatedBy: ownerMemberId, nowMs: Date.now() });
  const mcp = createHostedRoomMcp(store);
  const call = (method, params, secret) => mcp(rpc(method, params), { authorization: `Bearer ${secret}` });
  return { store, rooms, owner, peer, roomId, ownerMemberId, peerMemberId, call };
}

function addAgentMember(t, f, name) {
  const identity = f.store.identities.create(name);
  const invite = f.store.invites.create(f.owner.secret, f.roomId, { profile: "chat", displayName: name }, null);
  const joined = f.store.invites.redeem(invite.code, { displayName: name, identitySecret: identity.secret });
  const memberId = joined.memberId ?? joined.member?.id;
  assert.ok(memberId, "member id missing from redeem response");
  setTier(f.store.db, f.roomId, memberId, "t2_standard", { updatedBy: f.ownerMemberId, nowMs: Date.now() });
  return { identity, memberId };
}

const callTool = (f, secret, name, args) => f.call("tools/call", { name, arguments: args }, secret);
const capture = fn => { try { fn(); } catch (error) { return error; } throw new Error("expected the function to throw"); };
const spendError = (fn, { status, code }) => {
  const error = capture(fn);
  assert.ok(error instanceof SpendGrantError, `expected SpendGrantError, got ${error}`);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  return error;
};
const fileArgs = roomId => ({
  roomId, id: `f-${randomUUID()}`, filename: "note.txt", mediaType: "text/plain",
  data: Buffer.from("hello").toString("base64"),
});
const authorizationRows = (f, agentId) => f.store.db.prepare(
  `SELECT status, price_cents, tool_name FROM spend_authorizations WHERE room_id = ? AND agent_id = ? ORDER BY created_at`
).all(f.roomId, agentId ?? f.peerMemberId);

// --- Leg 1: put+commit inside the purse, attributed ---

test("leg 1: a grantless agent member puts and commits a file inside the default purse", async t => {
  const f = roomWithPeer(t);
  const args = fileArgs(f.roomId);
  const put = await callTool(f, f.peer.secret, "room_put_file", args);
  assert.equal(put.result?.isError, undefined, `expected put success, got ${JSON.stringify(put).slice(0, 300)}`);
  // Commit is unpriced: it must succeed without a second charge.
  f.store.command(f.peer.secret, f.roomId, {
    id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "msg-leg1", body: "see attached" },
  });
  const commit = await callTool(f, f.peer.secret, "room_commit_file", { roomId: f.roomId, id: args.id, messageId: "msg-leg1" });
  assert.equal(commit.result?.isError, undefined, `expected commit success, got ${JSON.stringify(commit).slice(0, 300)}`);
  // Exactly one settled 5c charge, attributed to the member in this room.
  const rows = authorizationRows(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "settled");
  assert.equal(rows[0].price_cents, "5");
  assert.equal(rows[0].tool_name, "room_put_file");
  // The purse summary reports the remaining 20c.
  const summary = spendGrantSummary(f.store.db, f.roomId, f.peerMemberId, { defaultCents: MEMBER_SPEND_DEFAULT_CENTS });
  assert.equal(summary.source, "room_default");
  assert.equal(summary.capCents, "25");
  assert.equal(summary.remainingCents, "20");
});

// --- Leg 2: exceeding the purse refuses honestly and charges nothing ---

test("leg 2: the charge past the purse refuses 402 default_allowance_exceeded and writes no row", async t => {
  const f = roomWithPeer(t);
  setSpendDefaultRoute(f.store, f.owner.secret, f.roomId, { cents: 12 });
  const first = await callTool(f, f.peer.secret, "room_put_file", fileArgs(f.roomId));
  assert.equal(first.result?.isError, undefined);
  const second = await callTool(f, f.peer.secret, "room_put_file", fileArgs(f.roomId));
  assert.equal(second.result?.isError, undefined);
  const third = await callTool(f, f.peer.secret, "room_put_file", fileArgs(f.roomId));
  assert.equal(third.result?.isError, true, "the third put must be refused");
  const value = third.result.structuredContent;
  assert.equal(value.status, 402);
  assert.equal(value.code, "payment_required");
  assert.equal(value.detail.reason, "default_allowance_exceeded");
  assert.equal(value.detail.priceCents, 5);
  assert.equal(value.detail.remainingCents, "2");
  assert.match(third.result.content[0].text, /5 cents/);
  assert.match(third.result.content[0].text, /nothing was charged/i);
  // Only the two settled charges exist; the refusal wrote nothing.
  const rows = authorizationRows(f);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.status === "settled"));
});

// --- Leg 3: explicit grant composes; revocation never falls back ---

test("leg 3: an explicit grant composes over purse spend; revoking it refuses grant_revoked, not the purse", async t => {
  const f = roomWithPeer(t);
  const now = Date.now();
  // Spend 10c from the purse.
  const authz = (nonce) => authorizeSpend(f.store.db, {
    roomId: f.roomId, agentId: f.peerMemberId, toolName: "room_put_file", priceCents: 5,
    nonce, roomDefaultCents: MEMBER_SPEND_DEFAULT_CENTS, nowMs: now,
  });
  authz("leg3-a").settle(now);
  authz("leg3-b").settle(now);
  // Issue a 100c grant: its rule is unchanged (cap minus ALL authorizations),
  // so the 10c of purse spend counts inside the grant's lifetime cap — the
  // floor guaranteed the first spend, the grant raises the total budget.
  issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, {
    grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", nowMs: now,
  });
  const summary = spendGrantSummary(f.store.db, f.roomId, f.peerMemberId, { defaultCents: MEMBER_SPEND_DEFAULT_CENTS });
  assert.equal(summary.source, undefined, "a live grant reports the grant summary, not the purse");
  assert.equal(summary.remainingCents, "90");
  // One more charge settles against the grant; the trail stays single.
  authz("leg3-c").settle(now);
  const total = authorizationRows(f).reduce((sum, row) => sum + Number(row.price_cents), 0);
  assert.equal(total, 15, "no double-count and no shadow balance");
  // Revoke: the next call refuses as revoked — the purse must not resurrect
  // spend the owner just cut.
  revokeSpendGrant(f.store.db, f.roomId, f.peerMemberId, { nowMs: now });
  const error = spendError(
    () => authorizeSpend(f.store.db, {
      roomId: f.roomId, agentId: f.peerMemberId, toolName: "room_put_file", priceCents: 5,
      nonce: "leg3-d", roomDefaultCents: MEMBER_SPEND_DEFAULT_CENTS, nowMs: now,
    }),
    { status: 402, code: "payment_required" });
  assert.equal(error.detail.reason, "grant_revoked");
});

// --- Leg 4: owner zeroes the purse → today's exact 402 ---

test("leg 4: owner setting the default to 0 restores the exact pre-purse refusal", async t => {
  const f = roomWithPeer(t);
  setSpendDefaultRoute(f.store, f.owner.secret, f.roomId, { cents: 0 });
  const read = readSpendDefaultRoute(f.store, f.owner.secret, f.roomId);
  assert.equal(read.cents, 0);
  const response = await callTool(f, f.peer.secret, "room_put_file", fileArgs(f.roomId));
  assert.equal(response.result?.isError, true);
  const value = response.result.structuredContent;
  assert.equal(value.status, 402);
  assert.equal(value.code, "payment_required");
  assert.equal(value.detail.reason, "no_spend_grant", "zero default is today's refusal, byte for byte");
  assert.equal(authorizationRows(f).length, 0);
  // And the self-read is back to withhold-null.
  const own = readSpendGrantRoute(f.store, f.peer.secret, f.roomId);
  assert.equal(own.spend, null);
});

// --- Leg 5: owner and humans are never charged ---

test("leg 5: the owner and a human member pass the charge boundary uncharged", async t => {
  const f = roomWithPeer(t);
  assert.equal(chargeSpendBeforeCall(f.store, f.owner.secret, "room_put_file", { roomId: f.roomId }), null,
    "the room owner is never charged");
  // A human member (kind human, linked identity): never charged either.
  const human = f.store.identities.create("Human member");
  const humanMemberId = `human-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  f.store.command(f.owner.secret, f.roomId, {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: humanMemberId, displayName: "Human member", kind: "human", permissions: [] },
  });
  f.store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
    .run(f.roomId, human.identityId, humanMemberId, Date.now());
  assert.equal(chargeSpendBeforeCall(f.store, human.secret, "room_put_file", { roomId: f.roomId }), null,
    "human members are never charged");
  const rows = f.store.db.prepare(`SELECT COUNT(*) AS n FROM spend_authorizations WHERE room_id = ?`).get(f.roomId);
  assert.equal(rows.n, 0);
});

// --- Setting surface ---

test("setting: only the owner may set the default; the shape is validated", async t => {
  const f = roomWithPeer(t);
  const byPeer = capture(() => setSpendDefaultRoute(f.store, f.peer.secret, f.roomId, { cents: 10 }));
  assert.equal(byPeer.status, 403);
  assert.equal(byPeer.code, "owner_required");
  for (const bad of [{ cents: -1 }, { cents: "25" }, { cents: 2.5 }, { cents: 10, extra: 1 }, {}, { cents: 100000001 }]) {
    const error = capture(() => setSpendDefaultRoute(f.store, f.owner.secret, f.roomId, bad));
    assert.equal(error.status, 422, JSON.stringify(bad));
    assert.equal(error.code, "invalid_spend_default", JSON.stringify(bad));
  }
  // A valid set lands and reads back with its revision trail.
  setSpendDefaultRoute(f.store, f.owner.secret, f.roomId, { cents: 40 });
  const read = readSpendDefaultRoute(f.store, f.peer.secret, f.roomId);
  assert.equal(read.cents, 40);
  assert.equal(read.defaultCents, MEMBER_SPEND_DEFAULT_CENTS);
  assert.equal(read.revision, 1);
  assert.equal(read.setById, f.ownerMemberId);
  // Clearing restores the built-in default.
  setSpendDefaultRoute(f.store, f.owner.secret, f.roomId, { cents: null });
  assert.equal(readSpendDefaultRoute(f.store, f.owner.secret, f.roomId).cents, MEMBER_SPEND_DEFAULT_CENTS);
});

test("read: consumption is owner-visible per member; members see only their own row", async t => {
  const f = roomWithPeer(t);
  const other = addAgentMember(t, f, "Other agent");
  const put = await callTool(f, f.peer.secret, "room_put_file", fileArgs(f.roomId));
  assert.equal(put.result?.isError, undefined);
  const ownerRead = readSpendDefaultRoute(f.store, f.owner.secret, f.roomId);
  const peerRow = ownerRead.consumption.find(entry => entry.agentId === f.peerMemberId);
  assert.deepEqual(peerRow, { agentId: f.peerMemberId, spentCents: "5", remainingCents: "20" });
  const otherRead = readSpendDefaultRoute(f.store, other.identity.secret, f.roomId);
  assert.equal(otherRead.consumption.some(entry => entry.agentId === f.peerMemberId), false,
    "another member's consumption is not exposed");
  assert.deepEqual(otherRead.consumption, [
    { agentId: other.memberId, spentCents: "0", remainingCents: "25" },
  ], "a purse holder sees their own fresh purse");
  const peerRead = readSpendDefaultRoute(f.store, f.peer.secret, f.roomId);
  assert.deepEqual(peerRead.consumption, [peerRow]);
});

test("self-read: a grantless member's spend summary reports the purse; guests and t1 members get null", async t => {
  const f = roomWithPeer(t);
  const own = readSpendGrantRoute(f.store, f.peer.secret, f.roomId);
  assert.equal(own.spend.source, "room_default");
  assert.equal(own.spend.capCents, "25");
  assert.equal(own.spend.remainingCents, "25");
  // t1_readonly: authorizeSpend refuses outright, so no purse is shown.
  const t1 = addAgentMember(t, f, "T1 agent");
  setTier(f.store.db, f.roomId, t1.memberId, "t1_readonly", { updatedBy: f.ownerMemberId, nowMs: Date.now() });
  assert.equal(readSpendGrantRoute(f.store, t1.identity.secret, f.roomId).spend, null);
  assert.equal(memberSpendDefaultSummary(f.store.db, f.roomId, t1.memberId, { defaultCents: 25 }), null);
  // A direct authorize for the t1 member still refuses 403, purse or not.
  const error = capture(() => authorizeSpend(f.store.db, {
    roomId: f.roomId, agentId: t1.memberId, toolName: "room_put_file", priceCents: 5,
    nonce: "t1-a", roomDefaultCents: 25, nowMs: Date.now(),
  }));
  assert.equal(error.status, 403);
  assert.equal(error.code, "spend_grant_denied");
});

test("authorize: without roomDefaultCents the door keeps the old refusal; an expired grant keeps its own", async t => {
  const f = roomWithPeer(t);
  const now = Date.now();
  // Direct callers that do not pass the default get pre-purse behaviour.
  const noParam = spendError(
    () => authorizeSpend(f.store.db, {
      roomId: f.roomId, agentId: f.peerMemberId, toolName: "room_put_file", priceCents: 5, nonce: "np-1", nowMs: now,
    }),
    { status: 402, code: "payment_required" });
  assert.equal(noParam.detail.reason, "no_spend_grant");
  // An expired grant refuses as expired even with a purse in force.
  issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, {
    grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", expiresAt: now + 1000, nowMs: now,
  });
  const expired = spendError(
    () => authorizeSpend(f.store.db, {
      roomId: f.roomId, agentId: f.peerMemberId, toolName: "room_put_file", priceCents: 5,
      nonce: "np-2", roomDefaultCents: 25, nowMs: now + 2000,
    }),
    { status: 402, code: "payment_required" });
  assert.equal(expired.detail.reason, "grant_expired");
});
