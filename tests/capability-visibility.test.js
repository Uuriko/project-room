// Withheld, never refused: per-agent capability catalog filtering
// (UFO-steal slice 4, RC-2026-09-27-2731).
//
// Contract under test: tools/list for an authenticated agent omits every
// capability the agent's grants/tiers would deny at call time — the
// denied tool is ABSENT from the listing JSON, never present-but-denying.
// Call-time enforcement stays in place as defense in depth and is
// asserted alongside the listing. The public surfaces (unauthenticated
// MCP join tools, server card) stay full by design, and the member
// capabilities directory stays unchanged (it advertises unenforced
// delegation hints, not permission-gated tools; reads stay open to
// guests per #1166).
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
import { handleMcpJoinRpc } from "../server/mcp-http.mjs";
import { listedMcpTools, liveEnrolledMcpTools } from "../server/mcp-discovery.mjs";
import {
  capabilityVisibleTo,
  capabilityIsWrite,
  resolveCatalogAgent,
  GUEST_WRITABLE_TOOLS,
  T1_WRITABLE_TOOLS,
} from "../server/capability-visibility.mjs";
import { PUBLIC_WORK_MCP_TOOLS } from "../src/room-mcp-join.js";
import { demoteToReadonly } from "../server/autonomy-tiers.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-capability-visibility-"));
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

function toolNames(tools) {
  return new Set(tools.map(tool => tool.name));
}

function writeNames(tools) {
  return tools.filter(tool => tool.annotations?.readOnlyHint === false && !PUBLIC_WORK_MCP_TOOLS.includes(tool.name)).map(tool => tool.name);
}

// A t1_readonly agent with one linked room: builds the fixture once,
// returns the MCP caller bound to the demoted identity plus both rooms.
async function demotedPeer(t) {
  const { store, rooms } = setup(t);
  const owner = store.identities.create("Owen");
  const peer = store.identities.create("Peer agent");
  const created = rooms.create(owner.secret, { title: "Tier room", purpose: "Withhold", displayName: "Owner" });
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

test("t1_readonly agent's tools/list withholds denied writes but keeps the call-time carve-outs", async t => {
  const { peer, call } = await demotedPeer(t);

  for (const profile of ["core", "full"]) {
    const listed = await call("tools/list", { profile }, peer.secret);
    const tools = listed.result.tools;
    assert.ok(tools.length > 0, `${profile}: empty catalog`);
    const writes = writeNames(tools);
    for (const name of writes) {
      assert.ok(T1_WRITABLE_TOOLS.has(name),
        `${profile}: write tool ${name} is listed for a t1_readonly agent but denied at call time`);
    }
    for (const keep of T1_WRITABLE_TOOLS) {
      if (profile === "full") {
        assert.ok(toolNames(tools).has(keep), `${profile}: carve-out ${keep} must stay listed (call time admits it)`);
      }
    }
    assert.ok(!toolNames(tools).has("room_post_message"), `${profile}: room_post_message must be withheld from t1_readonly`);
    assert.ok(!toolNames(tools).has("add_land_item"), `${profile}: add_land_item must be withheld from t1_readonly`);
    assert.ok(!toolNames(tools).has("room_put_file"), `${profile}: room_put_file must be withheld from t1_readonly`);
  }
});

test("t1_readonly direct invocation is still denied at call time (defense in depth)", async t => {
  const { peer, roomId, call } = await demotedPeer(t);
  const refused = resultValue(await call("tools/call", { name: "room_post_message", arguments: { roomId, body: "hi" } }, peer.secret));
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "agent_readonly");
});


test("readonly Room membership preserves independent public contribution authority", async t => {
  const { store, peer, call } = await demotedPeer(t);
  store.projectOffers.create("commons", "owner", { requestId: "visibility-create", offerId: "visibility-task", reviewerMemberIds: ["owner"], terms: { kind: "task", title: "Public volunteer task", summary: "Catalog authority keeper", acceptanceCriteria: ["Deliver exact bytes"], repositoryUrl: "https://github.com/example/project", reward: { kind: "unpaid" }, approvalPolicy: { mode: "human" } } });
  store.projectOffers.transition("commons", "owner", "visibility-task", "publish", { requestId: "visibility-publish", expectedRevision: 1 });
  store.publicWorkClaims.enable("commons", "owner", "visibility-task", { requestId: "visibility-enable", expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: "main", files: ["public-result.js"] });
  const listed = await call("tools/list", { profile: "full" }, peer.secret);
  const claimTool = listed.result.tools.find(tool => tool.name === "public_work_claim");
  assert.equal(claimTool._meta.authorization, "saved-identity-secret");
  const claimed = resultValue(await call("tools/call", { name: "public_work_claim", arguments: { taskId: "visibility-task", requestId: "visibility-claim", expectedTermsVersion: 1 } }, peer.secret));
  assert.equal(claimed.task.claim.identityId, peer.identityId);
  assert.equal(claimed.task.claim.state, "claimed");
  assert.equal(store.publicWorkClaims.read("visibility-task").claim.identityId, peer.identityId);
});

test("owner keeps the full catalog: withholding changes nothing for the unrestricted", async t => {
  const { owner, call } = await demotedPeer(t);
  for (const profile of ["core", "full"]) {
    const listed = await call("tools/list", { profile }, owner.secret);
    const names = toolNames(listed.result.tools);
    assert.deepEqual([...names].sort(), [...toolNames(listedMcpTools(profile, false))].sort(),
      `${profile}: owner catalog must equal the unfiltered list`);
  }
});

test("resolveCatalogAgent builds fresh per-request standing from the tier rows", async t => {
  const { store, peer, roomId } = await demotedPeer(t);
  const agent = resolveCatalogAgent(store, { identityId: peer.identityId });
  assert.equal(agent.kind, "agent");
  assert.equal(agent.memberships.length, 1);
  const [m] = agent.memberships;
  assert.equal(m.roomId, roomId);
  assert.equal(m.autonomyTier, "t1_readonly");
  assert.equal(m.isGuest, false);
  assert.equal(m.isOwner, false);
});

test("guest-visible subset matches the #1166 guest semantics", () => {
  // Guests hold ga1.* tokens, never pri_ identity secrets, so no guest
  // reaches the authenticated MCP profile; the predicate + catalog
  // builder is where the guest subset is enforced and pinned.
  const guest = {
    kind: "agent",
    identityId: null,
    memberships: [{
      roomId: "commons", memberId: "guest-agent-9f2c", isGuest: true,
      autonomyTier: "t2_standard", isOwner: false, active: true,
    }],
    grants: [],
  };
  const tools = listedMcpTools("full", false, guest);
  const names = toolNames(tools);
  for (const tool of tools) {
    if (PUBLIC_WORK_MCP_TOOLS.includes(tool.name)) {
      // This unfiltered full catalog also documents public contribution tools.
      // A ga1 guest token cannot satisfy their separate global identity authority.
      assert.equal(tool._meta.authorization, ["public_work_recommend", "public_work_read_task"].includes(tool.name) ? "none" : "saved-identity-secret");
    } else if (capabilityIsWrite(tool)) {
      assert.ok(GUEST_WRITABLE_TOOLS.has(tool.name),
        `guest catalog lists write tool ${tool.name}: call time would 403 guest_scope_denied`);
    }
  }
  // The exact #1166 subset: chat posts + reactions stay, everything
  // else (drafts, work, wake, files, admin) is withheld.
  for (const keep of GUEST_WRITABLE_TOOLS) assert.ok(names.has(keep), `guest catalog must keep ${keep}`);
  assert.ok(!names.has("room_post_draft"), "guest catalog must withhold drafts (contributor-tier gated at call time)");
  assert.ok(!names.has("room_begin_work"), "guest catalog must withhold work tools");
  assert.ok(!names.has("wake_register"), "guest catalog must withhold wake tools (#1166)");
  assert.ok(names.size > GUEST_WRITABLE_TOOLS.size, "guest catalog must keep the read surface");
});

test("capabilityVisibleTo: mixed standing unions the call-time carve-outs", () => {
  const agent = kinds => ({ kind: "agent", identityId: "x", memberships: kinds, grants: [] });
  const write = name => ({ name, annotations: { readOnlyHint: false } });
  const read = name => ({ name, annotations: { readOnlyHint: true } });

  assert.equal(capabilityVisibleTo({ kind: "human" }, write("room_post_message")), true);
  assert.equal(capabilityVisibleTo(agent([]), write("room_create")), true, "roomless identity keeps onboarding reachable");
  assert.equal(capabilityVisibleTo(agent([]), read("wake_list")), true);
  assert.equal(capabilityVisibleTo(agent([{ active: true, isGuest: false, isOwner: false, autonomyTier: "t2_standard" }]), write("room_post_message")), true);

  // guest in room A, t1_readonly in room B: each class keeps its own
  // call-time subset, nothing else.
  const mixed = agent([
    { active: true, isGuest: true, isOwner: false, autonomyTier: "t2_standard" },
    { active: true, isGuest: false, isOwner: false, autonomyTier: "t1_readonly" },
  ]);
  assert.equal(capabilityVisibleTo(mixed, write("room_post_message")), true, "guest class keeps chat");
  assert.equal(capabilityVisibleTo(mixed, write("room_react")), true, "guest class keeps reactions");
  assert.equal(capabilityVisibleTo(mixed, write("heartbeat_set")), true, "t1 class keeps heartbeats");
  assert.equal(capabilityVisibleTo(mixed, write("room_create")), false, "no class admits room_create: withheld");
  assert.equal(capabilityVisibleTo(mixed, read("wake_list")), true, "reads are never withheld");

  // owner exemption survives a stale tier row (autonomy-tiers.mjs).
  const owner = agent([{ active: true, isGuest: false, isOwner: true, autonomyTier: "t1_readonly" }]);
  assert.equal(capabilityVisibleTo(owner, write("room_post_message")), true);

  // unknown capabilities default to visible: never hide a usable tool.
  assert.equal(capabilityVisibleTo(agent([{ active: true, isGuest: true }]), { name: "mystery_tool" }), true);
});

test("capabilityVisibleTo: grant-edge seam refines tiers (slice-1 plug-in point)", () => {
  const base = { kind: "agent", identityId: "x", grants: [], memberships: [] };
  const gated = { name: "room_put_file", annotations: { readOnlyHint: false }, requiresGrant: "files.write" };
  assert.equal(capabilityVisibleTo(base, gated), false, "declared grant without the edge: withheld");
  assert.equal(capabilityVisibleTo({ ...base, grants: ["files.write"] }, gated), true, "grant edge held: visible");
  assert.equal(capabilityVisibleTo({ ...base, grants: ["files.write"] },
    { name: "room_post_message", annotations: { readOnlyHint: false } }), true,
    "tools without a declared grant are unaffected by the seam");
});

test("listing endpoints: no leaks, no over-filtering", async t => {
  // 1. Anonymous MCP: four join documents, two executable read-only work tools,
  //    and the identity mint.
  const publicList = handleMcpJoinRpc(rpc("tools/list"));
  assert.deepEqual(toolNames(publicList.result.tools),
    new Set(["room_join_packet", "room_join_kits", "room_join_prompt", "room_mcp_snippet", "public_work_recommend", "public_work_read_task", "room_identity_mint"]));

  // 2. Server card: public by design, full unfiltered list.
  assert.deepEqual(toolNames(liveEnrolledMcpTools()), toolNames(listedMcpTools("core", false, null, "public_work")));

  // 3. Member capabilities directory: reads stay open to guests (#1166);
  //    it advertises unenforced delegation hints, not permission-gated
  //    tools, so the withhold predicate does not apply.
  const directory = mkdtempSync(join(tmpdir(), "room-capability-dir-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });

  const mint = await request("/api/rooms/commons/guest-invites", {
    method: "POST", token: ownerKey,
    data: { requestId: randomUUID(), guestLabel: "catalog probe", expectedOwnerRevision: 0 },
  });
  assert.equal(mint.status, 201);
  const { code } = await mint.json();
  const identity = store.identities.create("Catalog probe guest");
  const keys = generateKeyPair();
  const cardBody = { name: "probe", description: "catalog probe", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: keys.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: keys.privateKey }) };
  const redeemed = await request("/api/guest-invites/redeem", {
    method: "POST", token: identity.secret, data: { inviteCode: code, card },
  });
  assert.equal(redeemed.status, 201);
  const guestToken = (await redeemed.json()).token;

  const dir = await request("/api/rooms/commons/capabilities", { token: guestToken });
  assert.equal(dir.status, 200);
  const body = await dir.json();
  assert.ok(Array.isArray(body.members), "directory keeps its shape for guests");
});
