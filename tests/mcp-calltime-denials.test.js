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
import { demoteToReadonly } from "../server/autonomy-tiers.mjs";

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
  return { store, rooms, owner, guest, roomId: created.roomId, ownerMemberId: created.ownerMemberId, guestMemberId: memberId, call };
}

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
  const { store, owner, ownerMemberId, guest, roomId, call } = await guestPeer(t);
  // This authorization fixture must not depend on live GitHub availability,
  // rate limits or ambient runner credentials. Keep the real queue handler.
  const githubReads = [];
  const sha = "a".repeat(40);
  store.landQueue.configure({ token: null, fetchImpl: async (url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    githubReads.push(url);
    if (url.endsWith("/pulls/7")) return Response.json({
      title: "Fixture pull request", merged: false, mergeable: true,
      mergeable_state: "clean", head: { sha }
    });
    if (url.endsWith(`/commits/${sha}/status`)) return Response.json({ state: "pending", total_count: 0, statuses: [] });
    if (url.includes(`/commits/${sha}/check-runs?`)) return Response.json({ total_count: 0, check_runs: [] });
    assert.fail(`Unexpected GitHub fixture read: ${url}`);
  } });
  // Seed a land item so report/remove reach the handler (rather than a
  // missing-item error) on the pre-fix code.
  const added = resultValue(await call("tools/call", {
    name: "add_land_item", arguments: { roomId, repo: "Uuriko/project-room", prNumber: 7 },
  }, owner.secret));
  assert.ok(!added.isError, `owner add_land_item must work: ${JSON.stringify(added).slice(0, 200)}`);
  const itemId = added.item?.itemId ?? added.itemId;
  assert.ok(itemId, "expected a land item id");
  assert.equal(githubReads.length, 3, "owner seed must exercise the real GitHub-backed queue read");
  const seeded = store.landQueue.list(roomId, ownerMemberId);
  assert.equal(seeded.items.length, 1);
  assert.equal(seeded.items[0].itemId, itemId);
  assert.equal(seeded.items[0].headSha, sha);
  const cases = [
    ["inbox_put_attachment", { id: "g1", filename: "note.txt", mediaType: "text/plain", data: Buffer.from("hi").toString("base64") }],
    ["webhook_subscribe", { url: "https://example.com/hook", events: ["message.posted"] }],
    ["heartbeat_set", { hostId: "h1", mode: "pull-only" }],
    ["heartbeat_ack", { signalIds: ["no-such-signal"] }],
    ["wake_register", { hostId: "h1", wakeUrl: "https://example.com/wake" }],
    ["room_create", { title: "Sneaky", purpose: "guest escalation" }],
    ["add_land_item", { roomId, repo: "Uuriko/project-room", prNumber: 1 }],
    ["remove_land_item", { roomId, itemId }],
    ["report_tip", { roomId, itemId, sourceRevision: "abc123", buildId: "b1" }],
  ];
  for (const [name, args] of cases) {
    const value = resultValue(await call("tools/call", { name, arguments: args }, guest.secret));
    assert.equal(denied(value), "guest_scope_denied", `${name}: expected guest_scope_denied`);
  }
  assert.equal(githubReads.length, 3, "denied guest calls must not fetch GitHub");
  assert.deepEqual(store.landQueue.list(roomId, ownerMemberId), seeded, "denied calls must not remove or change the seeded item");
});

test("guest-class hosted stdio chat-hole tools are denied at call time", async t => {
  // The hosted stdio path bypasses callRoomTool, and the store.command
  // guest gate admits message.posted chat posts — so without a
  // handler-side check, guests could reach tools the catalog withholds:
  // room_introduce_outside_agent writes the shared outside-agent
  // directory, room_request_reply creates formal reply requests, and
  // room_reply posts reply-shaped messages, all encoded as plain
  // message.posted.
  const { guest, ownerMemberId, roomId, call } = await guestPeer(t);
  const cases = [
    ["room_introduce_outside_agent", { roomId, externalRef: "agent-x", displayName: "Agent X", origin: "mcp" }],
    ["room_request_reply", { roomId, requestId: randomUUID(), toMemberId: ownerMemberId, body: "a formal request from a guest" }],
    ["room_reply", { roomId, requestId: "guest-reply-1", replyToId: "msg-1", body: "a reply-shaped post from a guest" }],
  ];
  for (const [name, args] of cases) {
    const value = resultValue(await call("tools/call", { name, arguments: args }, guest.secret));
    assert.equal(denied(value), "guest_scope_denied", `${name}: expected guest_scope_denied`);
  }
});

test("guest cannot answer a formal reply request at call time", async t => {
  const { owner, guest, guestMemberId, roomId, call } = await guestPeer(t);
  const opened = resultValue(await call("tools/call", {
    name: "room_request_reply", arguments: { roomId, requestId: randomUUID(), toMemberId: guestMemberId, body: "please confirm" },
  }, owner.secret));
  assert.ok(!opened.isError, `owner request must open: ${JSON.stringify(opened).slice(0, 200)}`);
  const requestMessageId = opened.requestMessageId;
  assert.ok(requestMessageId, "expected a requestMessageId");
  const read = resultValue(await call("tools/call", {
    name: "room_read_request", arguments: { roomId, requestMessageId },
  }, guest.secret));
  const template = read.responseActions?.[0]?.arguments;
  assert.ok(template, "expected a response template");
  const value = resultValue(await call("tools/call", {
    name: "room_respond_to_request",
    arguments: { roomId, ...template, requestId: randomUUID(), body: "confirmed" },
  }, guest.secret));
  assert.equal(denied(value), "guest_scope_denied", "guest respond must be denied");
});

test("full members keep the hosted stdio write tools (no regression)", async t => {
  const { owner, guestMemberId, roomId, call } = await guestPeer(t);
  const introduced = resultValue(await call("tools/call", {
    name: "room_introduce_outside_agent",
    arguments: { roomId, externalRef: "agent-y", displayName: "Agent Y", origin: "mcp" },
  }, owner.secret));
  assert.ok(!introduced.isError, `owner introduce must work: ${JSON.stringify(introduced).slice(0, 200)}`);
  const requested = resultValue(await call("tools/call", {
    name: "room_request_reply", arguments: { roomId, requestId: randomUUID(), toMemberId: guestMemberId, body: "owner request" },
  }, owner.secret));
  assert.ok(!requested.isError, `owner request must work: ${JSON.stringify(requested).slice(0, 200)}`);
  const replied = resultValue(await call("tools/call", {
    name: "room_reply", arguments: { roomId, requestId: "owner-reply-1", replyToId: "msg-1", body: "owner reply" },
  }, owner.secret));
  assert.ok(!replied.isError, `owner reply must work: ${JSON.stringify(replied).slice(0, 200)}`);
});

test("contributor-tier guest keeps the call-time draft allowance (no regression)", async t => {
  // The catalog withholds room_post_draft from every guest, but the
  // contributor tier stays gated at call time (documented in
  // capability-visibility.mjs, pinned by
  // tests/capability-visibility.test.js). The hosted stdio enforcement
  // must not close that allowance.
  const { store, guest, ownerMemberId, guestMemberId, roomId, call } = await guestPeer(t);
  // Promote the guest row to contributor tier through the real tables.
  const now = Date.now();
  store.db.prepare(`INSERT INTO guest_invites(id,code_hash,room_id,tier,credential_ttl_ms,guest_label,minted_by_member_id,issue_request_id,created_at,redeem_by,status,redeemed_at,redeemed_by_identity_id,redeemed_member_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("invite-test", "a".repeat(64), roomId, "contributor", 3600000, "drafts", ownerMemberId, randomUUID(), now, now + 3600000, "redeemed", now, guest.identityId, guestMemberId);
  store.db.prepare("INSERT INTO guest_members(member_id,room_id,guest_identity_id,tier,invite_id,created_at) VALUES(?,?,?,?,?,?)")
    .run(guestMemberId, roomId, guest.identityId, "contributor", "invite-test", now);
  const value = resultValue(await call("tools/call", {
    name: "room_post_draft",
    arguments: { roomId, requestId: randomUUID(), workItemId: "w-missing", packetId: "p1", basisRevision: 0, body: "draft body" },
  }, guest.secret));
  assert.notEqual(value.code, "guest_scope_denied",
    `contributor draft must not hit the guest scope gate: ${JSON.stringify(value).slice(0, 200)}`);
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
