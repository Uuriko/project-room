// P1 recheck: priced-tool 500 (wave500-g2-p1-priced-500).
//
// The spend-gated tools/call path must fail honest — 401/402/422 — BEFORE any
// spend, never 500. Money-adjacent: test-only, no real spend; the peer holds
// no grant in any test and every test asserts zero spend_authorizations rows.
//
// Contracts owned here (nothing else covers them):
// - an unknown/revoked bearer calling a priced tool is refused at the auth
//   envelope (-32001), before the spend gate is ever consulted
// - a valid identity with no room membership calling a priced tool gets an
//   honest 401 (not a 500 from a null member dereference), nothing charged
// - malformed arguments are refused (invalid_arguments) BEFORE the charge —
//   the "invalid input is refused before payment" invariant from
//   server/spend-grants.mjs; a regression that charges before validating
//   would write spend rows for calls that never should have priced
//
// Authoring gate: all three go through the real tools/call boundary with a
// real RoomStore (no doubles); the without-funds 402 case stays owned by
// tests/spend-grants.test.js ("priced tool without a grant is refused and
// never runs") and is not duplicated here.
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

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-priced-500-"));
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

// Owner + one t2 agent peer in a fresh room, mirroring
// tests/spend-grants.test.js. The peer holds NO spend grant in any test.
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
  return { store, rooms, owner, peer, roomId, ownerMemberId, peerMemberId, mcp, call };
}

const fileArgs = roomId => ({
  roomId, id: `f-${randomUUID()}`, filename: "note.txt", mediaType: "text/plain",
  data: Buffer.from("hello").toString("base64"),
});

function callTool(call, secret, name, args) {
  return call("tools/call", { name, arguments: args }, secret);
}

// Money-adjacent invariant: no authorization row may exist for this room.
function assertNoSpend(store, roomId) {
  const rows = store.db.prepare(
    `SELECT tool_name, price_cents, status FROM spend_authorizations WHERE room_id = ?`).all(roomId);
  assert.equal(rows.length, 0, `expected zero spend rows, got ${JSON.stringify(rows)}`);
}

function errorOf(response) {
  // tools/call failures surface as isError results with structuredContent.
  assert.equal(response.result?.isError, true, `expected an error result, got ${JSON.stringify(response).slice(0, 300)}`);
  return response.result.structuredContent;
}

test("priced tool with an unknown credential is refused at the auth envelope, nothing charged", async t => {
  const f = roomWithPeer(t);
  // Well-formed identity secret shape, never minted: exercises the
  // resolveMcpIdentity miss, not just the bearer-format check.
  const unknownSecret = `pri_${"0".repeat(64)}`;
  const response = await f.mcp(
    rpc("tools/call", { name: "room_put_file", arguments: fileArgs(f.roomId) }),
    { authorization: `Bearer ${unknownSecret}` });
  assert.equal(response.error?.code, -32001, `expected auth_required, got ${JSON.stringify(response).slice(0, 200)}`);
  assertNoSpend(f.store, f.roomId);
});

test("priced tool with a valid identity outside the room is refused honest (401), nothing charged", async t => {
  const f = roomWithPeer(t);
  const outsider = f.store.identities.create("Outsider");
  const response = await callTool(f.call, outsider.secret, "room_put_file", fileArgs(f.roomId));
  const value = errorOf(response);
  assert.ok(value.status === 401 || value.status === 403,
    `expected an honest 401/403, got status ${value.status} (${JSON.stringify(value).slice(0, 200)})`);
  assert.notEqual(value.status, 500, "must never 500 on the spend-gated path");
  assertNoSpend(f.store, f.roomId);
});

test("priced tool with malformed params is refused before charge, nothing charged, tool never runs", async t => {
  const f = roomWithPeer(t);
  // room_put_file requires id/filename/data: arguments are validated by the
  // router before chargeSpendBeforeCall ever runs.
  const response = await callTool(f.call, f.peer.secret, "room_put_file", { roomId: f.roomId });
  assert.equal(response.error?.code, -32602, `expected invalid_arguments, got ${JSON.stringify(response).slice(0, 200)}`);
  assert.equal(response.error?.message, "invalid_arguments");
  assert.equal(response.error?.data?.tool, "room_put_file");
  // The charge never happened: no authorization rows for anyone.
  assertNoSpend(f.store, f.roomId);
  // The tool never ran: nothing staged.
  const listed = await callTool(f.call, f.peer.secret, "room_list_files", { roomId: f.roomId });
  assert.equal(listed.result.structuredContent.files.length, 0);
});

test("priced tool on the hosted-stdio path (bounty_post) without a grant is refused 402, nothing charged", async t => {
  // Second chargeSpendBeforeCall call site (server/mcp-full-profile.mjs
  // callHostedStdioTool, { value, isError } contract): the 402 must surface
  // through the shared failureValue mapping, never as a 500, and the bounty
  // must never be posted.
  const f = roomWithPeer(t);
  const args = {
    roomId: f.roomId, title: "Priced recheck probe", criteria: "no real bounty",
    amount: 1, deadline: new Date(Date.now() + 86400000).toISOString(),
  };
  const response = await callTool(f.call, f.peer.secret, "bounty_post", args);
  const value = errorOf(response);
  assert.equal(value.status, 402, `expected 402, got ${JSON.stringify(value).slice(0, 200)}`);
  assert.equal(value.code, "payment_required");
  assert.equal(value.detail?.priceCents, 10);
  assertNoSpend(f.store, f.roomId);
});
