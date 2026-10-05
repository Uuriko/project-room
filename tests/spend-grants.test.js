// Spend-primitive MVP (qa4-spend-mvp-jill): per-agent spend grants and the
// charge-then-forward trust boundary for priced MCP tools.
//
// Contracts owned here (nothing else covers them):
// - issuance: guests/t1 refused, caps validated, credits-only denomination
//   (grants.test.js owns generic edges, not spend money terms)
// - expiry/revocation bite on the next authorization
//   (spend-allowance.test.js owns the room allowance, not per-agent grants)
// - charge-then-forward ordering: refusal → tool never runs; success → exact
//   charge settled; failure/duplicate → voided, never double-charged
// - refusal honesty: 402 + payment_required + price named in text AND in
//   structured detail (the x402 PaymentRequired shape)
// - price-in-description: every priced tool advertises its price
//   (mcp-core-profile.test.js owns the catalog shape, not the paid prefix)
//
// Authoring gate: every test names the regression it would catch; no test
// asserts implementation (all go through exported production functions or
// the real tools/call boundary).
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
import { issueGrant } from "../server/grants.mjs";
import { SPEND_GRANT_ROUTES } from "../server/routes/spend-grants.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import { hostedMcpToolDefs } from "../server/mcp-hosted-tools.mjs";
import {
  PRICED_MCP_TOOLS,
  priceForTool,
  ensureSpendGrantsSchema,
  SpendGrantError,
  issueSpendGrant,
  revokeSpendGrant,
  resolveSpendGrant,
  spendGrantSummary,
  authorizeSpend,
  settleSpend,
  voidSpend,
  chargeSpendBeforeCall,
  readSpendGrantRoute,
  issueSpendGrantRoute,
} from "../server/spend-grants.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-mvp-"));
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

// Owner + one t2 agent peer in a fresh room, the shape the MCP boundary needs.
function roomWithPeer(t, { guest = false } = {}) {
  const { store, rooms } = setup(t);
  const owner = store.identities.create("Owen");
  const peer = store.identities.create("Peer agent");
  const created = rooms.create(owner.secret, { title: "Spend room", purpose: "Paid tools", displayName: "Owner" });
  const roomId = created.roomId;
  const ownerMemberId = created.ownerMemberId ?? owner.identityId;
  let peerMemberId;
  if (guest) {
    // Guest-class member, mirroring tests/mcp-calltime-denials.test.js.
    peerMemberId = `guest-agent-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    store.command(owner.secret, roomId, {
      id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId: peerMemberId, displayName: "Guest", kind: "agent", permissions: [] },
    });
    store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
      .run(roomId, peer.identityId, peerMemberId, Date.now());
  } else {
    const invite = store.invites.create(owner.secret, roomId, { profile: "chat", displayName: "Peer agent" }, null);
    const joined = store.invites.redeem(invite.code, { displayName: "Peer agent", identitySecret: peer.secret });
    peerMemberId = joined.memberId ?? joined.member?.id;
    assert.ok(peerMemberId, "peer member id missing from redeem response");
    setTier(store.db, roomId, peerMemberId, "t2_standard", { updatedBy: ownerMemberId, nowMs: Date.now() });
  }
  const mcp = createHostedRoomMcp(store);
  const call = (method, params, secret) => mcp(rpc(method, params), { authorization: `Bearer ${secret}` });
  return { store, rooms, owner, peer, roomId, ownerMemberId, peerMemberId, call };
}

function callTool(call, secret, name, args) {
  return call("tools/call", { name, arguments: args }, secret);
}

function errorOf(response) {
  // tools/call failures surface as isError results with structuredContent.
  assert.equal(response.result?.isError, true, `expected an error result, got ${JSON.stringify(response).slice(0, 300)}`);
  return response.result.structuredContent;
}

// assert.throws returns undefined on this Node; capture the error instead.
const capture = fn => { try { fn(); } catch (error) { return error; } throw new Error("expected the function to throw"); };
const spendError = (fn, { status, code }) => {
  const error = capture(fn);
  assert.ok(error instanceof SpendGrantError, `expected SpendGrantError, got ${error}`);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  return error;
};

// --- Issuance ---

test("issueSpendGrant records caps and the summary reports remaining", async t => {
  const f = roomWithPeer(t);
  const summary = issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, {
    grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", nowMs: Date.now(),
  });
  assert.equal(summary.denomination, "credits");
  assert.equal(summary.capCents, "100");
  assert.equal(summary.perTxCapCents, "10");
  assert.equal(summary.remainingCents, "100");
  assert.equal(summary.allowlist, null);
  const grant = resolveSpendGrant(f.store.db, f.roomId, f.peerMemberId);
  assert.ok(grant, "grant should resolve live");
  assert.equal(grant.terms.capCents, "100");
});

test("issuance refusals: guest, t1_readonly, bad caps, non-credits denomination", async t => {
  const f = roomWithPeer(t);
  const now = Date.now();
  const base = { grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", nowMs: now };
  // A t1_readonly agent can never hold a spend grant.
  const t1 = f.store.identities.create("T1 agent");
  const inv = f.store.invites.create(f.owner.secret, f.roomId, { profile: "chat", displayName: "T1" }, null);
  const joined = f.store.invites.redeem(inv.code, { displayName: "T1", identitySecret: t1.secret });
  const t1Member = joined.memberId ?? joined.member?.id;
  setTier(f.store.db, f.roomId, t1Member, "t1_readonly", { updatedBy: f.ownerMemberId, nowMs: now });
  spendError(() => issueSpendGrant(f.store.db, f.roomId, t1Member, base), { status: 422, code: "spend_grant_tier_forbidden" });
  // A guest pass can never be widened with spend.
  const g = roomWithPeer(t, { guest: true });
  spendError(() => issueSpendGrant(g.store.db, g.roomId, g.peerMemberId, { ...base, grantedBy: g.ownerMemberId }),
    { status: 422, code: "spend_grant_guest_forbidden" });
  // Bad money shapes.
  for (const bad of [
    { ...base, capCents: "0" },
    { ...base, perTxCapCents: "101" },
    { ...base, capCents: "1.5" },
    { ...base, capCents: "-5" },
    { ...base, denomination: "usdc" },
    { ...base, allowlist: ["room_post_message"] },
    { ...base, allowlist: [] },
  ]) {
    spendError(() => issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, bad), { status: 422, code: bad.denomination === "usdc" ? "spend_grant_denomination_unsupported" : "invalid_spend_grant" });
  }
});

// #1521: a grants:issue delegate can mint money. Self-issue through the
// HTTP boundary must be refused (403); the delegate keeps issuing to
// others, and the room owner (full authority) may still self-issue.
test("issueSpendGrantRoute: a grants:issue delegate cannot self-issue; the owner can", async t => {
  const f = roomWithPeer(t);
  const now = Date.now();
  issueGrant(f.store.db, f.roomId, f.peerMemberId, "grants:issue", { grantedBy: f.ownerMemberId, nowMs: now });
  const selfIssue = spendError(
    () => issueSpendGrantRoute(f.store, f.peer.secret, f.roomId,
      { agentId: f.peerMemberId, capCents: "1000000", perTxCapCents: "1000000" }),
    { status: 403, code: "spend_grant_self_issue_forbidden" });
  assert.match(selfIssue.message, /themselves/i, "the refusal names the reason");
  // The refused call minted nothing.
  assert.equal(resolveSpendGrant(f.store.db, f.roomId, f.peerMemberId, { nowMs: now }), null,
    "no grant row was written by the refused self-issue");
  // Issuing to a different member still works for the delegate.
  const plain = f.store.identities.create("Plain agent");
  const inv = f.store.invites.create(f.owner.secret, f.roomId, { profile: "chat", displayName: "Plain" }, null);
  const joined = f.store.invites.redeem(inv.code, { displayName: "Plain", identitySecret: plain.secret });
  const plainMember = joined.memberId ?? joined.member?.id;
  setTier(f.store.db, f.roomId, plainMember, "t2_standard", { updatedBy: f.ownerMemberId, nowMs: now });
  const other = issueSpendGrantRoute(f.store, f.peer.secret, f.roomId,
    { agentId: plainMember, capCents: "100", perTxCapCents: "10" });
  assert.equal(other.spend.capCents, "100", "delegates keep issuing to other members");
  // The room owner holds full authority and may self-issue.
  const own = issueSpendGrantRoute(f.store, f.owner.secret, f.roomId,
    { agentId: f.ownerMemberId, capCents: "100", perTxCapCents: "10" });
  assert.equal(own.spend.capCents, "100", "owner self-issue stays allowed");
});

test("re-issue upserts caps (explicit un-revoke path)", async t => {
  const f = roomWithPeer(t);
  const now = Date.now();
  issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, { grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", nowMs: now });
  revokeSpendGrant(f.store.db, f.roomId, f.peerMemberId, { nowMs: now });
  assert.equal(resolveSpendGrant(f.store.db, f.roomId, f.peerMemberId, { nowMs: now }), null);
  const summary = issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, { grantedBy: f.ownerMemberId, capCents: "50", perTxCapCents: "5", nowMs: now });
  assert.equal(summary.capCents, "50");
  assert.ok(resolveSpendGrant(f.store.db, f.roomId, f.peerMemberId, { nowMs: now }), "re-issue should revive the grant");
});

// --- Expiry / revocation bite at the boundary ---

test("expired and revoked grants refuse with the exact reason", async t => {
  const f = roomWithPeer(t);
  const now = Date.now();
  issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, {
    grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "50", expiresAt: now + 1000, nowMs: now,
  });
  const expired = spendError(
    () => authorizeSpend(f.store.db, { roomId: f.roomId, agentId: f.peerMemberId, toolName: "room_put_file", priceCents: 5, nonce: randomUUID(), nowMs: now + 2000 }),
    { status: 402, code: "payment_required" });
  assert.equal(expired.detail.reason, "grant_expired");
  revokeSpendGrant(f.store.db, f.roomId, f.peerMemberId, { nowMs: now });
  const revoked = spendError(
    () => authorizeSpend(f.store.db, { roomId: f.roomId, agentId: f.peerMemberId, toolName: "room_put_file", priceCents: 5, nonce: randomUUID(), nowMs: now }),
    { status: 402, code: "payment_required" });
  assert.equal(revoked.detail.reason, "grant_revoked");
  const missing = spendError(
    () => authorizeSpend(f.store.db, { roomId: f.roomId, agentId: "nobody-here", toolName: "room_put_file", priceCents: 5, nonce: randomUUID(), nowMs: now }),
    { status: 402, code: "payment_required" });
  assert.equal(missing.detail.reason, "no_spend_grant");
});

// --- Charge accounting ---

test("cap, per-tx cap, allowlist, and nonce replay are enforced", async t => {
  const f = roomWithPeer(t);
  const now = Date.now();
  const roomId = f.roomId, agentId = f.peerMemberId;
  issueSpendGrant(f.store.db, roomId, agentId, {
    grantedBy: f.ownerMemberId, capCents: "10", perTxCapCents: "6",
    allowlist: ["room_put_file"], nowMs: now,
  });
  const authz = (toolName, priceCents, nonce) =>
    authorizeSpend(f.store.db, { roomId, agentId, toolName, priceCents, nonce, nowMs: now });
  // First 6 settles; only 4 remain.
  authz("room_put_file", 6, "n1").settle();
  const capped = spendError(() => authz("room_put_file", 6, "n2"), { status: 402, code: "payment_required" });
  assert.equal(capped.detail.reason, "cap_exceeded");
  assert.equal(capped.detail.remainingCents, "4");
  // Per-tx cap bites even when the cap has room.
  const perTx = spendError(() => authz("room_put_file", 7, "n3"), { status: 402, code: "payment_required" });
  assert.equal(perTx.detail.reason, "per_tx_cap_exceeded");
  // Allowlist: a priced tool outside it is denied, not charged.
  spendError(() => authz("add_land_item", 1, "n4"), { status: 403, code: "spend_tool_not_allowlisted" });
  // Nonce replay: the same (grant, nonce) never authorizes twice. A
  // re-presented reserved nonce returns the live authorization (crash
  // recovery); a settled one returns its receipt (exactly-once); only a
  // voided nonce stays consumed.
  const first = authz("room_put_file", 4, "n5");
  assert.ok(first && !first.replayed, "first presentation authorizes");
  const again = authz("room_put_file", 4, "n5");
  assert.equal(again.replayed, "reserved", "reserved nonce re-presents the live authorization");
  assert.equal(again.settle(), true, "settling through the replayed handle settles once");
  const receipt = authz("room_put_file", 4, "n5");
  assert.equal(receipt.replayed, "settled", "settled nonce re-presents its receipt");
  assert.equal(receipt.settle(), true, "re-settling the receipt is idempotent");
  assert.equal(spendGrantSummary(f.store.db, roomId, agentId, { nowMs: now }).remainingCents, "0");
});

test("void releases the reservation; settle/void are idempotent", async t => {
  const f = roomWithPeer(t);
  const now = Date.now();
  const roomId = f.roomId, agentId = f.peerMemberId;
  issueSpendGrant(f.store.db, roomId, agentId, { grantedBy: f.ownerMemberId, capCents: "10", perTxCapCents: "10", nowMs: now });
  const handle = authorizeSpend(f.store.db, { roomId, agentId, toolName: "room_put_file", priceCents: 5, nonce: "v1", nowMs: now });
  assert.equal(spendGrantSummary(f.store.db, roomId, agentId, { nowMs: now }).remainingCents, "5");
  assert.equal(handle.void(), true);
  assert.equal(handle.void(), false, "second void is a no-op");
  spendError(() => authorizeSpend(f.store.db, { roomId, agentId, toolName: "room_put_file", priceCents: 5, nonce: "v1", nowMs: now }),
    { status: 409, code: "duplicate_nonce" });
  assert.equal(spendGrantSummary(f.store.db, roomId, agentId, { nowMs: now }).remainingCents, "10");
  const handle2 = authorizeSpend(f.store.db, { roomId, agentId, toolName: "room_put_file", priceCents: 5, nonce: "v2", nowMs: now });
  assert.equal(handle2.settle(), true);
  assert.equal(handle2.settle(), false, "second settle is a no-op");
  assert.equal(settleSpend(f.store.db, { roomId, agentId, nonce: "v1" }), false, "voided rows cannot be settled");
});

// #1525: a process crash between reserve and settle/void left a 'reserved'
// authorization permanently consuming grant cap and room allowance.
// Reserves now carry a lease (expires_at = created_at + RESERVE_LEASE_MS);
// the reaper voids orphaned reservations and releases their room
// reservations. It runs opportunistically inside authorizeSpend, so the
// next priced call after a crash reaps what the crashed one left behind.
test("reserve lease: crashed reservations are reaped and the cap returns", async t => {
  // Dynamic import: these exports do not exist on the pre-fix code, so the
  // test must fail there while the rest of the file still runs.
  const { reapExpiredSpendAuthorizations, RESERVE_LEASE_MS } = await import("../server/spend-grants.mjs");
  assert.equal(typeof reapExpiredSpendAuthorizations, "function", "reaper must exist (#1525)");
  assert.ok(Number.isSafeInteger(RESERVE_LEASE_MS) && RESERVE_LEASE_MS > 0, "the lease must be a positive timeout");
  const f = roomWithPeer(t);
  const now = Date.now();
  const roomId = f.roomId, agentId = f.peerMemberId;
  issueSpendGrant(f.store.db, roomId, agentId, {
    grantedBy: f.ownerMemberId, capCents: "10", perTxCapCents: "10", nowMs: now,
  });
  const reserve = (nonce, at, allowance = null) =>
    authorizeSpend(f.store.db, { roomId, agentId, toolName: "room_put_file", priceCents: 5, nonce, nowMs: at,
      ...(allowance === null ? {} : { roomAllowanceCents: allowance, roomCommittedCents: 0 }) });
  // The handle is dropped without settle/void: the crash.
  reserve("crash-1", now, 1000);
  assert.equal(spendGrantSummary(f.store.db, roomId, agentId, { nowMs: now }).remainingCents, "5",
    "the orphaned reservation consumes cap");
  assert.equal(
    f.store.db.prepare(`SELECT COUNT(*) AS n FROM spend_room_reservations WHERE room_id = ? AND status = 'active'`).get(roomId).n,
    1, "the room reservation is also held by the orphan");
  // Fresh reservations are NOT reaped before the lease expires.
  assert.equal(reapExpiredSpendAuthorizations(f.store.db, { roomId, nowMs: now }), 0,
    "the reaper leaves live reservations alone");
  // Past the lease the orphan is voided, the cap returns, and the room
  // reservation is released.
  const pastLease = now + RESERVE_LEASE_MS + 1;
  assert.equal(reapExpiredSpendAuthorizations(f.store.db, { roomId, nowMs: pastLease }), 1,
    "the reaper voids the orphaned reservation");
  const row = f.store.db.prepare(
    `SELECT status FROM spend_authorizations WHERE room_id = ? AND agent_id = ? AND nonce = ?`)
    .get(roomId, agentId, "crash-1");
  assert.equal(row.status, "voided", "orphans are voided, not settled");
  assert.equal(spendGrantSummary(f.store.db, roomId, agentId, { nowMs: pastLease }).remainingCents, "10",
    "the reaped cap is spendable again");
  assert.equal(
    f.store.db.prepare(`SELECT COUNT(*) AS n FROM spend_room_reservations WHERE room_id = ? AND status = 'active'`).get(roomId).n,
    0, "the room reservation was released by the reaper");
  // Opportunistic: authorizeSpend reaps past-lease rows inside its own
  // transaction, so a crashed call's cap is back for the next caller.
  reserve("crash-2", now);
  const next = reserve("after", pastLease);
  assert.ok(next, "authorizeSpend past the lease sees the freed cap");
  assert.equal(spendGrantSummary(f.store.db, roomId, agentId, { nowMs: pastLease }).remainingCents, "5");
  // Pre-migration rows (expires_at NULL, e.g. written before this fix)
  // reap from created_at, so old databases converge too.
  f.store.db.prepare(`INSERT INTO spend_authorizations
      (room_id, agent_id, nonce, tool_name, price_cents, status, created_at, expires_at)
      VALUES (?, ?, ?, 'room_put_file', '5', 'reserved', ?, NULL)`)
    .run(roomId, agentId, "legacy-row", now - RESERVE_LEASE_MS - 60_000);
  assert.equal(reapExpiredSpendAuthorizations(f.store.db, { roomId, nowMs: now }), 1,
    "legacy rows without expires_at reap from created_at");
  const legacy = f.store.db.prepare(
    `SELECT status FROM spend_authorizations WHERE room_id = ? AND agent_id = ? AND nonce = ?`)
    .get(roomId, agentId, "legacy-row");
  assert.equal(legacy.status, "voided");
});

// --- Refusal honesty ---

test("refusal names the tool and price in text and structured detail", async t => {
  const f = roomWithPeer(t);
  const error = spendError(
    () => chargeSpendBeforeCall(f.store, f.peer.secret, "room_put_file", { roomId: f.roomId }),
    { status: 402, code: "payment_required" });
  assert.match(error.message, /room_put_file/);
  assert.match(error.message, /5 credits/);
  assert.match(error.message, /nothing was charged/);
  assert.equal(error.detail.tool, "room_put_file");
  assert.equal(error.detail.priceCents, 5);
  assert.equal(error.detail.denomination, "credits");
  assert.equal(error.detail.reason, "no_spend_grant");
  // No ledger row was written by the refusal.
  const count = f.store.db.prepare(`SELECT COUNT(*) AS n FROM spend_authorizations`).get().n;
  assert.equal(count, 0);
});

test("chargeSpendBeforeCall passes through unpriced tools, humans, and the owner", async t => {
  const f = roomWithPeer(t);
  assert.equal(chargeSpendBeforeCall(f.store, f.peer.secret, "room_list_files", { roomId: f.roomId }), null);
  assert.equal(chargeSpendBeforeCall(f.store, f.owner.secret, "room_put_file", { roomId: f.roomId }), null,
    "the room owner is never charged");
});

test("chargeSpendBeforeCall routes the check+reserve through store.transaction (DO parity)", async t => {
  // Regression for qa4-fix-spend-do-txn-jill: the module-local transact()
  // issued raw BEGIN IMMEDIATE / COMMIT / ROLLBACK, which node:sqlite
  // accepts but the Durable Object wrapper (cloudflare/storage.mjs
  // DurableDatabase) cannot execute — on the DO every priced-tool call by
  // a non-owner 500d instead of 402ing. The store platform transaction is
  // the only portable boundary; this test fails on the pre-fix code
  // because the platform transaction is never entered.
  const f = roomWithPeer(t);
  let platformTxCalls = 0;
  const origTransaction = f.store.transaction.bind(f.store);
  f.store.transaction = fn => { platformTxCalls++; return origTransaction(fn); };
  const error = capture(() => chargeSpendBeforeCall(f.store, f.peer.secret, "room_put_file", { roomId: f.roomId }));
  assert.ok(error instanceof SpendGrantError, `expected SpendGrantError, got ${error}`);
  assert.equal(error.status, 402);
  assert.equal(error.code, "payment_required");
  assert.equal(platformTxCalls, 1,
    "the spend check+reserve must run inside the store platform transaction, never raw SQL");
});

// --- End-to-end through tools/call ---

const fileArgs = roomId => ({
  roomId, id: `f-${randomUUID()}`, filename: "note.txt", mediaType: "text/plain",
  data: Buffer.from("hello").toString("base64"),
});

test("tools/call: priced tool without a grant is refused and never runs", async t => {
  const f = roomWithPeer(t);
  const response = await callTool(f.call, f.peer.secret, "room_put_file", fileArgs(f.roomId));
  const value = errorOf(response);
  assert.equal(value.status, 402);
  assert.equal(value.code, "payment_required");
  assert.equal(value.detail.priceCents, 5);
  assert.match(value.detail ? JSON.stringify(value) : "", /5 credits/);
  // The refusal text names the price (x402: both structured and text).
  const text = response.result.content[0].text;
  assert.match(text, /5 credits/);
  assert.match(text, /room_put_file/);
  // The tool never ran: nothing staged.
  const listed = await callTool(f.call, f.peer.secret, "room_list_files", { roomId: f.roomId });
  assert.equal(listed.result.structuredContent.files.length, 0);
});

test("tools/call: priced tool with a grant settles exactly the price", async t => {
  const f = roomWithPeer(t);
  issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, {
    grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", nowMs: Date.now(),
  });
  const response = await callTool(f.call, f.peer.secret, "room_put_file", fileArgs(f.roomId));
  assert.equal(response.result?.isError, undefined, `expected success, got ${JSON.stringify(response).slice(0, 300)}`);
  const rows = f.store.db.prepare(
    `SELECT status, price_cents FROM spend_authorizations WHERE room_id = ? AND agent_id = ?`).all(f.roomId, f.peerMemberId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "settled");
  assert.equal(rows[0].price_cents, "5");
  const summary = spendGrantSummary(f.store.db, f.roomId, f.peerMemberId);
  assert.equal(summary.remainingCents, "95");
});

test("tools/call: idempotent duplicate retry is not charged twice", async t => {
  const f = roomWithPeer(t);
  issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, {
    grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", nowMs: Date.now(),
  });
  const args = { ...fileArgs(f.roomId), id: "dup-file-1" };
  const first = await callTool(f.call, f.peer.secret, "room_put_file", args);
  assert.equal(first.result?.isError, undefined);
  const retry = await callTool(f.call, f.peer.secret, "room_put_file", args);
  const value = retry.result.structuredContent;
  assert.equal(value.duplicate, true, "expected the idempotent duplicate receipt");
  const settled = f.store.db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(CAST(price_cents AS INTEGER)), 0) AS total
     FROM spend_authorizations WHERE room_id = ? AND agent_id = ? AND status = 'settled'`)
    .get(f.roomId, f.peerMemberId);
  assert.equal(settled.n, 1, "exactly one settled charge");
  assert.equal(settled.total, 5, "charged exactly once");
});

// --- Visibility: withhold, never refuse ---

test("readSpendGrantRoute: agents see their grant; guests and grant-less members see null", async t => {
  const f = roomWithPeer(t);
  issueSpendGrant(f.store.db, f.roomId, f.peerMemberId, {
    grantedBy: f.ownerMemberId, capCents: "100", perTxCapCents: "10", nowMs: Date.now(),
  });
  const own = readSpendGrantRoute(f.store, f.peer.secret, f.roomId);
  assert.equal(own.spend.capCents, "100");
  assert.equal(own.spend.remainingCents, "100");
  assert.ok(!JSON.stringify(own).includes("secret"), "no funding secret exists to leak");
  const plain = f.store.identities.create("Plain agent");
  const inv = f.store.invites.create(f.owner.secret, f.roomId, { profile: "chat", displayName: "Plain" }, null);
  const joined = f.store.invites.redeem(inv.code, { displayName: "Plain", identitySecret: plain.secret });
  const plainMember = joined.memberId ?? joined.member?.id;
  setTier(f.store.db, f.roomId, plainMember, "t2_standard", { updatedBy: f.ownerMemberId, nowMs: Date.now() });
  const none = readSpendGrantRoute(f.store, plain.secret, f.roomId);
  assert.equal(none.spend, null, "grant-less member sees null, not a refusal");
});

// --- Price-in-description contract ---

test("every priced tool advertises its price in its description", async t => {
  for (const [name, cents] of Object.entries(PRICED_MCP_TOOLS)) {
    const def = hostedMcpToolDefs.find(entry => entry.name === name);
    assert.ok(def, `${name} must exist in the hosted tool catalog`);
    assert.match(def.description, /^\[paid: room-credits\] /,
      `${name}: description must open with the machine-readable paid prefix`);
    assert.match(def.description, new RegExp(`\\b${cents} credits?\\b`),
      `${name}: description must name its ${cents}-credit price`);
  }
  assert.equal(priceForTool("room_list_files"), null, "unpriced tools stay free");
  assert.equal(priceForTool("no_such_tool"), null);
});

test("route table: the three spend-grant routes are registered with room auth", () => {
  // Regression: the RT allowlist gate rejects new legacy-chain routes, so
  // these must live in server/routes/table.mjs via SPEND_GRANT_ROUTES.
  const byId = Object.fromEntries(SPEND_GRANT_ROUTES.map(r => [r.id, r]));
  assert.equal(SPEND_GRANT_ROUTES.length, 3);
  assert.deepEqual(
    SPEND_GRANT_ROUTES.map(r => `${r.method} ${r.path}`),
    ["POST /api/rooms/{roomId}/spend-grants",
     "DELETE /api/rooms/{roomId}/spend-grants/{agentId}",
     "GET /api/rooms/{roomId}/spend-grant"]);
  for (const route of SPEND_GRANT_ROUTES) {
    assert.equal(route.auth, "room");
    assert.equal(route.scope, "room");
    assert.equal(typeof route.handler, "function");
  }
  assert.equal(typeof byId["issue-spend-grant"].handler, "function");
  // Regression (buildqa 2026-10-04): the RT row schema drifted from
  // docs/openapi.yaml and the handler — expiresAt was typed "string" while
  // both the public spec and issueSpendGrant take epoch-ms integers, and the
  // required fields the spec lists were missing. The openapi gate only checks
  // method coverage, so this guards the schema contract at its owner.
  const issueBody = byId["issue-spend-grant"].schema.body;
  assert.deepEqual(issueBody.required, ["agentId", "capCents", "perTxCapCents"]);
  // The runtime validator (schemaErrors) learned "integer" in the 2026-10-04
  // bughunt fix; before that it had no integer branch, so "integer" rejected
  // every numeric value. "integer" matches docs/openapi.yaml and the
  // issueSpendGrant safe-integer gate as closely as the validator expresses.
  assert.equal(issueBody.properties.expiresAt.type, "integer");
});
