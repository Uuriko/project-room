// Issue #993: hosted MCP land-queue writes (add_land_item, remove_land_item,
// report_tip) skipped the t1_readonly gate because callLandTool writes the
// land queue directly without going through store.command().
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { demoteToReadonly, getTier } from "../server/autonomy-tiers.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "land-queue-tier-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms };
}

const rpc = (method, params) => ({ jsonrpc: "2.0", id: "c", method, ...(params === undefined ? {} : { params }) });

function resultValue(response) {
  if (response.error) return { ...response.error.data, message: response.error.message };
  if (response.result?.structuredContent) return response.result.structuredContent;
  const text = response.result?.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return {}; }
}

test("t1_readonly agent is refused MCP land-queue writes but can list", async t => {
  const { store, rooms } = setup(t);
  const owner = store.identities.create("Owner");
  const peer = store.identities.create("Peer agent");
  const created = rooms.create(owner.secret, { title: "Land room", purpose: "Queue lands", displayName: "Owner" });

  const invite = store.invites.create(owner.secret, created.roomId, { profile: "chat", displayName: "Peer agent" }, null);
  const joined = store.invites.redeem(invite.code, { displayName: "Peer agent", identitySecret: peer.secret });
  const peerMemberId = joined.memberId ?? joined.member?.id;
  assert.ok(peerMemberId, "peer member id missing from redeem response");

  demoteToReadonly(store.db, created.roomId, peerMemberId, { updatedBy: "owner", nowMs: Date.now() });
  assert.equal(getTier(store.db, created.roomId, peerMemberId).autonomyTier, "t1_readonly");

  const mcp = createHostedRoomMcp(store);
  const call = (name, args) => mcp(rpc("tools/call", { name, arguments: args }), { authorization: `Bearer ${peer.secret}` });

  const refused = resultValue(await call("add_land_item", { roomId: created.roomId, repo: "acme/demo", prNumber: 1 }));
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "agent_readonly");

  // listing is a read: still allowed at the read-only tier
  const listed = resultValue(await call("list_land_queue", { roomId: created.roomId }));
  assert.notEqual(listed.status, 403);
});

test("t2_standard agent keeps full land-queue access; owner unaffected", async t => {
  const { store, rooms } = setup(t);
  const owner = store.identities.create("Owner");
  const created = rooms.create(owner.secret, { title: "Owner room", purpose: "Queue lands", displayName: "Owner" });

  const mcp = createHostedRoomMcp(store);
  const call = (name, args) => mcp(rpc("tools/call", { name, arguments: args }), { authorization: `Bearer ${owner.secret}` });

  const added = resultValue(await call("add_land_item", { roomId: created.roomId, repo: "acme/demo", prNumber: 7 }));
  assert.notEqual(added.status, 403);

  const removed = resultValue(await call("remove_land_item", { roomId: created.roomId, itemId: "missing" }));
  // unknown id errors for its own reasons, never for the tier
  assert.notEqual(removed.code, "agent_readonly");
});
