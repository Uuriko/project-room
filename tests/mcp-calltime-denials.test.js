// UFO-steal track 2 (RC-2026-09-27-2743): call-time tier denials mirroring
// the #1170 catalog filter.
//
// Contract: every write tool the catalog withholds from a restricted agent
// must also deny at call time. A direct tools/call for a withheld tool gets
// a 403 (agent_readonly / guest_scope_denied) — never silent success, never
// a filter-invisibility bypass. The carve-outs (t1 heartbeats, guest
// chat/react), the roomless onboarding surface, and the unrestricted keep
// working: no regression.
//
// Each denial test fails on the pre-fix code (the handler had no check, so
// the call succeeded or failed for an unrelated reason) and passes after
// the handler-side guard. tests/capability-visibility.test.js owns the
// tools/list half of this contract; these tests own the tools/call half.
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
import { EVENT_TYPES as T } from "../src/events.js";
import {
  capabilityVisibleTo,
  catalogCallDenial,
  membershipClasses,
} from "../server/capability-visibility.mjs";
import { demoteToReadonly } from "../server/autonomy-tiers.mjs";

const write = name => ({ name, annotations: { readOnlyHint: false } });
const read = name => ({ name, annotations: { readOnlyHint: true } });

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-calltime-denials-"));
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

const denied = value => {
  assert.equal(value.status, 403, `expected 403 denial, got ${JSON.stringify(value).slice(0, 200)}`);
  assert.ok(value.isError === true || value.code, "denial must be an error result");
  return value.code;
};

// A t1_readonly agent with one linked room: the demoted peer from the
// #1170 listing tests, driven against tools/call instead.
async function demotedPeer(t) {
  const { store, rooms } = setup(t);
  const owner = store.identities.create("Owner");
  const peer = store.identities.create("Peer agent");
  const created = rooms.create(owner.secret, { title: "Tier room", purpose: "Call-time", displayName: "Owner" });
  const invite = store.invites.create(owner.secret, created.roomId, { profile: "chat", displayName: "Peer agent" }, null);
  const joined = store.invites.redeem(invite.code, { displayName: "Peer agent", identitySecret: peer.secret });
  const peerMemberId = joined.memberId ?? joined.member?.id;
  assert.ok(peerMemberId, "peer member id missing from redeem response");
  demoteToReadonly(store.db, created.roomId, peerMemberId, { updatedBy: "owner", nowMs: Date.now() });

  const mcp = createHostedRoomMcp(store);
  const call = (method, params, secret) =>
    mcp(rpc(method, params), { authorization: `Bearer ${secret}` });
  return { store, rooms, owner, peer, roomId: created.roomId, call };
}

// A guest-class identity: a guest-agent-* member linked to an identity
// secret, which is what resolveCatalogAgent reads for the call-time check.
async function guestPeer(t) {
  const { store, rooms } = setup(t);
  const owner = store.identities.create("Owner");
  const guest = store.identities.create("Guest agent");
  const created = rooms.create(owner.secret, { title: "Guest room", purpose: "Call-time", displayName: "Owner" });
  const memberId = `guest-agent-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  store.command(owner.secret, created.roomId, {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId, displayName: "Guest", kind: "agent", permissions: [] },
  });
  store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
    .run(created.roomId, guest.identityId, memberId, Date.now());

  const mcp = createHostedRoomMcp(store);
  const call = (method, params, secret) =>
    mcp(rpc(method, params), { authorization: `Bearer ${secret}` });
  return { store, rooms, owner, guest, roomId: created.roomId, call };
}

test("catalogCallDenial mirrors the catalog predicate for every class", () => {
  const guest = { kind: "agent", memberships: [{ roomId: "r", memberId: "guest-agent-x", isGuest: true, autonomyTier: "t2_standard", isOwner: false, active: true }] };
  const t1 = { kind: "agent", memberships: [{ roomId: "r", memberId: "m", isGuest: false, autonomyTier: "t1_readonly", isOwner: false, active: true }] };
  const full = { kind: "agent", memberships: [{ roomId: "r", memberId: "m", isGuest: false, autonomyTier: "t2_standard", isOwner: false, active: true }] };
  const roomless = { kind: "agent", memberships: [] };

  // Denied classes get the same codes the room paths use.
  assert.deepEqual([...membershipClasses(guest)], ["guest"]);
  assert.deepEqual([...membershipClasses(t1)], ["t1"]);
  const guestDenial = catalogCallDenial(guest, write("wake_register"));
  assert.equal(guestDenial?.status, 403);
  assert.equal(guestDenial?.code, "guest_scope_denied");
  const t1Denial = catalogCallDenial(t1, write("wake_register"));
  assert.equal(t1Denial?.status, 403);
  assert.equal(t1Denial?.code, "agent_readonly");

  // Carve-outs and the unrestricted stay allowed.
  assert.equal(catalogCallDenial(t1, write("heartbeat_set")), null);
  assert.equal(catalogCallDenial(t1, write("heartbeat_ack")), null);
  assert.equal(catalogCallDenial(guest, write("room_post_message")), null);
  assert.equal(catalogCallDenial(guest, write("room_react")), null);
  assert.equal(catalogCallDenial(full, write("wake_register")), null);
  assert.equal(catalogCallDenial(roomless, write("wake_register")), null);
  assert.equal(catalogCallDenial(t1, read("room_list_events")), null);

  // The denial agrees with the listing predicate on every tool the
  // catalog test pins: denied at call time iff withheld from the listing.
  for (const agent of [guest, t1]) {
    for (const name of ["wake_register", "webhook_subscribe", "inbox_put_attachment", "room_create", "wake_pause", "add_land_item"]) {
      assert.equal(catalogCallDenial(agent, write(name)) !== null, !capabilityVisibleTo(agent, write(name)),
        `${name}: denial and listing disagree`);
    }
  }
});

test("t1_readonly direct calls are denied at call time (identity-scoped tools)", async t => {
  const { peer, call } = await demotedPeer(t);
  const cases = [
    ["wake_register", { hostId: "h1", wakeUrl: "https://example.com/wake" }],
    ["wake_clear", { hostId: "h1" }],
    ["webhook_subscribe", { url: "https://example.com/hook", events: ["message.posted"] }],
    ["webhook_unsubscribe", { subscriptionId: "sub-1" }],
    ["inbox_put_attachment", { id: "a1", filename: "note.txt", mediaType: "text/plain", data: Buffer.from("hi").toString("base64") }],
    ["inbox_discard_attachment", { id: "a1" }],
    ["room_create", { title: "Sneaky", purpose: "tier escalation" }],
    ["room_join", { linkToken: "bogus-token" }],
    ["wake_pause", { roomId: "unused-here", requestId: randomUUID() }],
  ];
  for (const [name, args] of cases) {
    const value = resultValue(await call("tools/call", { name, arguments: args }, peer.secret));
    assert.equal(denied(value), "agent_readonly", `${name}: expected agent_readonly denial`);
  }
});

test("t1_readonly carve-outs still succeed (no regression)", async t => {
  const { peer, call } = await demotedPeer(t);
  const set = resultValue(await call("tools/call", {
    name: "heartbeat_set", arguments: { hostId: "h1", mode: "pull-only" },
  }, peer.secret));
  assert.ok(!set.isError, `heartbeat_set must keep working for t1: ${JSON.stringify(set).slice(0, 200)}`);
  const ack = resultValue(await call("tools/call", {
    name: "heartbeat_ack", arguments: { signalIds: ["no-such-signal"] },
  }, peer.secret));
  assert.ok(!ack.isError, `heartbeat_ack must keep working for t1: ${JSON.stringify(ack).slice(0, 200)}`);
});

test("guest-class direct calls are denied at call time", async t => {
  const { guest, roomId, call } = await guestPeer(t);
  const cases = [
    ["inbox_put_attachment", { id: "g1", filename: "note.txt", mediaType: "text/plain", data: Buffer.from("hi").toString("base64") }],
    ["webhook_subscribe", { url: "https://example.com/hook", events: ["message.posted"] }],
    ["heartbeat_set", { hostId: "h1", mode: "pull-only" }],
    ["heartbeat_ack", { signalIds: ["no-such-signal"] }],
    ["wake_register", { hostId: "h1", wakeUrl: "https://example.com/wake" }],
    ["room_create", { title: "Sneaky", purpose: "guest escalation" }],
    ["add_land_item", { roomId, repo: "Uuriko/project-room", prNumber: 1 }],
  ];
  for (const [name, args] of cases) {
    const value = resultValue(await call("tools/call", { name, arguments: args }, guest.secret));
    assert.equal(denied(value), "guest_scope_denied", `${name}: expected guest_scope_denied`);
  }
});

test("guest chat carve-outs still succeed (no regression)", async t => {
  const { guest, roomId, call } = await guestPeer(t);
  const posted = resultValue(await call("tools/call", {
    name: "room_post_message", arguments: { roomId, body: "hello from guest" },
  }, guest.secret));
  assert.ok(!posted.isError, `room_post_message must keep working for guests: ${JSON.stringify(posted).slice(0, 200)}`);
  const messageId = posted.messageId ?? posted.command?.data?.messageId;
  assert.ok(messageId, "guest post should return a message id");
  const reacted = resultValue(await call("tools/call", {
    name: "room_react", arguments: { roomId, messageId, reaction: "👍" },
  }, guest.secret));
  assert.ok(!reacted.isError, `room_react must keep working for guests: ${JSON.stringify(reacted).slice(0, 200)}`);
});

test("unrestricted agent keeps every gapped tool (no regression)", async t => {
  const { owner, roomId, call } = await demotedPeer(t);
  const ok = async (name, args) => {
    const value = resultValue(await call("tools/call", { name, arguments: args }, owner.secret));
    assert.ok(!value.isError, `${name} must keep working for the unrestricted: ${JSON.stringify(value).slice(0, 200)}`);
    return value;
  };
  await ok("wake_clear", { hostId: "owner-host" });
  await ok("heartbeat_set", { hostId: "owner-host", mode: "pull-only" });
  await ok("inbox_put_attachment", { id: "o1", filename: "note.txt", mediaType: "text/plain", data: Buffer.from("hi").toString("base64") });
  const created = await ok("room_create", { title: "Owner room", purpose: "regression probe" });
  assert.ok(created.roomId, "room_create should return a room id");
  await ok("wake_pause", { roomId, requestId: randomUUID() });
  await ok("wake_resume", { roomId, requestId: randomUUID() });
});

test("roomless identity keeps the onboarding surface (no regression)", async t => {
  const { store } = setup(t);
  const fresh = store.identities.create("Brand new");
  const mcp = createHostedRoomMcp(store);
  const call = (method, params, secret) =>
    mcp(rpc(method, params), { authorization: `Bearer ${secret}` });
  const cleared = resultValue(await call("tools/call", {
    name: "wake_clear", arguments: { hostId: "fresh-host" },
  }, fresh.secret));
  assert.ok(!cleared.isError, `wake_clear must stay reachable roomless: ${JSON.stringify(cleared).slice(0, 200)}`);
  const created = resultValue(await call("tools/call", {
    name: "room_create", arguments: { title: "First room", purpose: "onboarding" },
  }, fresh.secret));
  assert.ok(!created.isError, `room_create must stay reachable roomless: ${JSON.stringify(created).slice(0, 200)}`);
});
