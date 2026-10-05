// MCP bounty tools must surface escrow validation errors honestly.
//
// Bug: server/mcp-room-profile.mjs `failureValue` mapped every EscrowError to
// 500 "internal" — the escrow module's structured codes (missing_citations,
// invalid_state, not_authorized, unknown_bounty) that the HTTP routes map to
// 404/403/409/422 (server/bounty-escrow-routes.mjs runPure). An agent driving
// the bounty lifecycle over MCP got "Request could not be completed" with
// zero diagnostic value on every escrow validation failure.
//
// Contract: the MCP boundary maps EscrowError the same way the HTTP routes
// do — unknown_bounty/unknown_flag -> 404, not_authorized -> 403,
// already_claimed/dispute_exists/idempotency_* -> 409, everything else -> 422.
// Unknown errors still become 500, never leaking internals.
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
import { setTier } from "../server/autonomy-tiers.mjs";

const rpc = (method, params) => ({ jsonrpc: "2.0", id: "c", method, ...(params === undefined ? {} : { params }) });

function roomWithPeer(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-escrow-err-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const owner = store.identities.create("Owen");
  const peer = store.identities.create("Peer agent");
  const created = rooms.create(owner.secret, { title: "Bounty room", purpose: "Escrow error mapping", displayName: "Owner" });
  const roomId = created.roomId;
  const invite = store.invites.create(owner.secret, roomId, { profile: "chat", displayName: "Peer agent" }, null);
  const joined = store.invites.redeem(invite.code, { displayName: "Peer agent", identitySecret: peer.secret });
  const peerMemberId = joined.memberId ?? joined.member?.id;
  assert.ok(peerMemberId, "peer member id missing from redeem response");
  setTier(store.db, roomId, peerMemberId, "t2_standard", { updatedBy: created.ownerMemberId ?? owner.identityId, nowMs: Date.now() });
  const mcp = createHostedRoomMcp(store);
  const call = (method, params, secret) => mcp(rpc(method, params), { authorization: `Bearer ${secret}` });
  return { store, roomId, owner, peer, call };
}

const tool = async (call, secret, name, args) => call("tools/call", { name, arguments: args }, secret);
const structured = response => response.result?.structuredContent ?? JSON.parse(response.result.content[0].text);
const futureIso = () => new Date(Date.now() + 7 * 864e5).toISOString();

async function submittedBounty(t, f) {
  const posted = await tool(f.call, f.owner.secret, "bounty_post", { roomId: f.roomId, title: "T", criteria: "C",
    amount: 10, deadline: futureIso(), rubric: [{ criterionId: "c1", description: "one thing" }] });
  assert.equal(posted.result?.isError, undefined, `bounty_post failed: ${JSON.stringify(posted).slice(0, 300)}`);
  const bountyId = structured(posted).bounty.bountyId;
  const funded = await tool(f.call, f.owner.secret, "bounty_fund", { roomId: f.roomId, bountyId, idempotencyKey: `fund-${randomUUID()}` });
  assert.equal(funded.result?.isError, undefined, `bounty_fund failed: ${JSON.stringify(funded).slice(0, 300)}`);
  const claimed = await tool(f.call, f.peer.secret, "bounty_claim", { roomId: f.roomId, bountyId, idempotencyKey: `claim-${randomUUID()}` });
  assert.equal(claimed.result?.isError, undefined, `bounty_claim failed: ${JSON.stringify(claimed).slice(0, 300)}`);
  const submitted = await tool(f.call, f.peer.secret, "bounty_submit", { roomId: f.roomId, bountyId,
    evidenceUrl: "https://example.com/work", summary: "done", evidenceKind: "document",
    checksClaimed: ["c1"], idempotencyKey: `sub-${randomUUID()}` });
  assert.equal(submitted.result?.isError, undefined, `bounty_submit failed: ${JSON.stringify(submitted).slice(0, 300)}`);
  return bountyId;
}

test("bounty_accept with malformed attestation surfaces missing_citations/422, not 500", async t => {
  const f = roomWithPeer(t);
  const bountyId = await submittedBounty(t, f);
  const accepted = await tool(f.call, f.owner.secret, "bounty_accept", { roomId: f.roomId, bountyId,
    verifierAttestation: { attestations: [{ criterionId: "c1", verdict: "pass" }] }, // wrong shape: citations required
    idempotencyKey: `acc-${randomUUID()}` });
  assert.equal(accepted.result?.isError, true, "expected an error result");
  const value = structured(accepted);
  assert.equal(value.status, 422, `expected 422, got ${value.status}: ${JSON.stringify(value).slice(0, 200)}`);
  assert.equal(value.code, "missing_citations", `expected missing_citations, got ${value.code}`);
});

test("bounty_accept on an unknown bounty surfaces unknown_bounty/404, not 500", async t => {
  const f = roomWithPeer(t);
  const accepted = await tool(f.call, f.owner.secret, "bounty_accept", { roomId: f.roomId, bountyId: "NOPE-1",
    verifierAttestation: { citations: [{ criterionId: "c1", verdict: "pass" }] }, idempotencyKey: `acc-${randomUUID()}` });
  assert.equal(accepted.result?.isError, true, "expected an error result");
  const value = structured(accepted);
  assert.equal(value.status, 404, `expected 404, got ${value.status}: ${JSON.stringify(value).slice(0, 200)}`);
  assert.equal(value.code, "unknown_bounty", `expected unknown_bounty, got ${value.code}`);
});

test("bounty_claim on an already-claimed bounty surfaces already_claimed/409, not 500", async t => {
  const f = roomWithPeer(t);
  const posted = await tool(f.call, f.owner.secret, "bounty_post", { roomId: f.roomId, title: "T", criteria: "C",
    amount: 10, deadline: futureIso() });
  const bountyId = structured(posted).bounty.bountyId;
  await tool(f.call, f.owner.secret, "bounty_fund", { roomId: f.roomId, bountyId, idempotencyKey: `fund-${randomUUID()}` });
  const first = await tool(f.call, f.peer.secret, "bounty_claim", { roomId: f.roomId, bountyId, idempotencyKey: `claim-${randomUUID()}` });
  assert.equal(first.result?.isError, undefined, `first claim failed: ${JSON.stringify(first).slice(0, 200)}`);
  const peer2 = f.store.identities.create("Peer two");
  const invite = f.store.invites.create(f.owner.secret, f.roomId, { profile: "chat", displayName: "Peer two" }, null);
  f.store.invites.redeem(invite.code, { displayName: "Peer two", identitySecret: peer2.secret });
  const second = await tool(f.call, peer2.secret, "bounty_claim", { roomId: f.roomId, bountyId, idempotencyKey: `claim2-${randomUUID()}` });
  assert.equal(second.result?.isError, true, "expected an error result");
  const value = structured(second);
  assert.equal(value.status, 409, `expected 409, got ${value.status}: ${JSON.stringify(value).slice(0, 200)}`);
  assert.equal(value.code, "already_claimed", `expected already_claimed, got ${value.code}`);
});
