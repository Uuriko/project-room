// AGENT-DOOR-AUTH stage 1, Lane C (run 2): OAuth grants at the /mcp door.
//
// A server-recognized `oat_` access token now authenticates at the hosted
// MCP door through the provider instance server/http.mjs injects into
// createHostedRoomMcp (verifyOAuthToken). The grant binds per room to its
// stamped principal — for connector clients, the agent member the
// consenting account owns via store.authenticateOAuthAgent (stage 1 bound
// the account's human member; AGENT-DOOR-AUTH stage 2 swapped the
// binding) — the provider proves the grant, the store proves the binding
// and membership — and only the profile-layer-bindable subset is callable
// (coordinator ruling, option (c)): the tools whose handlers authenticate
// at the profile layer and never pass a secret deeper.
//
// Pins here:
// - tools/list for an OAuth principal shows exactly the subset ∩ the
//   grant's scopes (catalog honesty); anonymous and identity-secret
//   catalogs are unchanged (Lane A pins);
// - each of the 8 subset tools succeeds under its scope(s), acting as the
//   bound agent member (land items record addedByMemberId = the member);
// - room_activation_pack requires rooms:read + chat:read + work:read
//   together (inseparable bundle, mirroring the REST ruling);
// - room_member_card runs with viewerIdentityId null: private directory
//   cards stay hidden (fail-closed), public/room cards are returned;
// - EVERY other tool — chat post/read, work lifecycle, the full-profile
//   tools, inbox/wake, money/bond, room_create — answers an OAuth grant
//   with 403 insufficient_scope naming the OAuth exclusion, even with all
//   five scopes granted;
// - non-member account -> 403 access_denied at the binding; unknown /
//   expired / revoked token -> -32001 MCP_AUTH_REQUIRED with the exact
//   WWW-Authenticate challenge (no resource_metadata; that is stage 3);
// - a hosted MCP constructed WITHOUT the verifier rejects oat_ exactly
//   as before stage 1 (the verifier is optional and injected).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createOAuthProvider } from "../server/oauth-provider.mjs";
import { createGrantAgentResolver } from "../server/oauth-grant-agents.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";
import { createWork } from "../server/work-claims.mjs";

const ALL_SCOPES = ["rooms:read", "chat:read", "chat:write", "work:read", "work:write"];
const WWW_AUTHENTICATE_TODAY = 'Bearer realm="project-room", charset="UTF-8"';
const ANON_MCP_TOOLS = [
  "room_join_packet", "room_join_kits", "room_join_prompt", "room_mcp_snippet",
  "public_work_recommend", "public_work_read_task", "room_identity_mint",
];
const SUBSET_SORTED = [
  "add_land_item", "list_land_queue", "remove_land_item", "report_tip",
  "room_activation_pack", "room_check_access", "room_member_card", "room_work_claim_provenance",
];

const SHA = "a".repeat(40);
function mockGitHub() {
  const fetchImpl = async (url) => {
    let body = {
      title: "Land the queue", merged: false, merge_commit_sha: null,
      mergeable: true, mergeable_state: "clean", head: { sha: SHA },
    };
    if (url.includes("/check-runs")) body = { check_runs: [{ status: "completed", conclusion: "success" }] };
    else if (url.endsWith("/status")) body = { state: "success" };
    return { status: 200, ok: true, json: async () => body };
  };
  return { fetchImpl };
}

function signedCard(agentId) {
  const card = {
    name: "Card Agent", description: "A signed card.", url: "https://agent.example/card",
    capabilities: ["chat"], version: "1.0.0",
  };
  const keyPair = generateKeyPair();
  return { card, keyPair, signature: signCard({ agentId, card, privateKey: keyPair.privateKey }) };
}

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "agent-door-auth-mcp-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.bindHumanAccount("commons", "owner", "account-owner");
  store.createAccount("account-other");
  const ownerKey = store.issueAccessKey("commons", "owner", 7 * 86400000, "account-owner");
  // Two agent members with directory cards: one public, one private.
  const identity = store.identities.create("Door Agent");
  store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, memberId: "agent", displayName: "Door Agent", permissions: [],
  });
  const pub = signedCard("agent");
  store.agentPlugin.publishCard({
    identityId: identity.identityId, agentId: "agent",
    card: pub.card, publicKey: pub.keyPair.publicKey, signature: pub.signature, visibility: "public",
  });
  const cardIdentity = store.identities.create("Card Agent");
  store.identities.link(ownerKey, "commons", {
    identityId: cardIdentity.identityId, memberId: "card-agent", displayName: "Card Agent", permissions: [],
  });
  const priv = signedCard("card-agent");
  store.agentPlugin.publishCard({
    identityId: cardIdentity.identityId, agentId: "card-agent",
    card: priv.card, publicKey: priv.keyPair.publicKey, signature: priv.signature, visibility: "private",
  });
  store.workClaims.set("commons", createWork({ id: "claim-1", title: "seeded claim-1" }, { now: Date.now() - 60000 }));
  store.landQueue.configure({ token: "<MASKED_SECRET_001>", fetchImpl: mockGitHub().fetchImpl });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rpc = async (method, params, token) => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, ...(params === undefined ? {} : { params }) }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body, headers: response.headers };
  };
  const call = (name, args, token) => rpc("tools/call", { name, arguments: args }, token);
  // Mint tokens the SERVER's provider verifies: a second provider instance
  // over the same database (the Lane B pattern).
  const provider = createOAuthProvider({
    db: store.db, clock: () => store.now(),
    resolveGrantAgent: createGrantAgentResolver(store),
  });
  provider.registerClient({
    clientId: "muse", name: "Muse", redirectUris: ["https://muse.ai/oauth/callback"],
  });
  const mintWith = (mintProvider, userId, scopes) => {
    const verifier = `v-${randomUUID()}`.padEnd(43, "d").slice(0, 43);
    const codeChallenge = Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url");
    const { code } = mintProvider.issueCode({
      clientId: "muse", userId, redirectUri: "https://muse.ai/oauth/callback", scopes, codeChallenge,
    });
    const { accessToken } = mintProvider.exchangeCode({
      code, clientId: "muse", redirectUri: "https://muse.ai/oauth/callback", codeVerifier: verifier,
    });
    assert.match(accessToken, /^oat_[A-Za-z0-9_-]{43}$/);
    return accessToken;
  };
  const mint = (userId, scopes) => mintWith(provider, userId, scopes);
  const mintExpired = (userId, scopes) => {
    const past = createOAuthProvider({ db: store.db, clock: () => store.now() - 2 * 3600_000 });
    past.registerClient({
      clientId: "muse", name: "Muse", redirectUris: ["https://muse.ai/oauth/callback"],
    });
    return mintWith(past, userId, scopes);
  };
  return { store, rpc, call, mint, mintExpired, provider, identity };
}

test("oauth catalog: tools/list shows exactly the callable subset narrowed by the grant's scopes", async t => {
  const f = await serve(t);

  const init = await f.rpc("initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mcp-oauth", version: "1" },
  }, f.mint("account-owner", ALL_SCOPES));
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, "project-room");

  const all = await f.rpc("tools/list", undefined, f.mint("account-owner", ALL_SCOPES));
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.result.tools.map(tool => tool.name).sort(), SUBSET_SORTED);

  const workRead = await f.rpc("tools/list", undefined, f.mint("account-owner", ["work:read"]));
  assert.deepEqual(workRead.body.result.tools.map(tool => tool.name).sort(),
    ["list_land_queue", "room_work_claim_provenance"]);

  const roomsRead = await f.rpc("tools/list", undefined, f.mint("account-owner", ["rooms:read"]));
  assert.deepEqual(roomsRead.body.result.tools.map(tool => tool.name).sort(),
    ["room_check_access", "room_member_card"]);

  // Asking for the full profile never widens an OAuth catalog.
  const full = await f.rpc("tools/list", { profile: "full" }, f.mint("account-owner", ["work:read"]));
  assert.deepEqual(full.body.result.tools.map(tool => tool.name).sort(),
    ["list_land_queue", "room_work_claim_provenance"]);
});

test("oauth subset: each of the 8 tools succeeds under its scope(s), as the bound agent member", async t => {
  const f = await serve(t);
  const all = f.mint("account-owner", ALL_SCOPES);
  // AGENT-DOOR-AUTH stage 2: the grant binds to the agent member the
  // account owns (stage 1 bound the human member); every attribution
  // below names that agent member / identity.
  const grant = f.provider.verifyAccessToken(all);

  const access = await f.call("room_check_access", { roomId: "commons" }, f.mint("account-owner", ["rooms:read"]));
  assert.equal(access.status, 200);
  assert.equal(access.body.result.isError, undefined);
  assert.equal(access.body.result.structuredContent.status, "credential_accepted");
  assert.equal(access.body.result.structuredContent.memberId, grant.agentIdentityId);
  assert.equal(access.body.result.structuredContent.kind, "agent");
  // Attribution: the caller's agent identity is stamped; no session exists.
  assert.equal(access.body.result.structuredContent.identityId, grant.agentIdentityId);

  const card = await f.call("room_member_card", { roomId: "commons", memberId: "agent" }, f.mint("account-owner", ["rooms:read"]));
  assert.equal(card.body.result.isError, undefined);
  assert.equal(card.body.result.structuredContent.agentId, "agent");

  const pack = await f.call("room_activation_pack", { roomId: "commons" },
    f.mint("account-owner", ["rooms:read", "chat:read", "work:read"]));
  assert.equal(pack.body.result.isError, undefined);
  assert.equal(pack.body.result.structuredContent.room.slug, "commons");

  const provenance = await f.call("room_work_claim_provenance", { roomId: "commons", claimId: "claim-1" },
    f.mint("account-owner", ["work:read"]));
  assert.equal(provenance.body.result.isError, undefined);
  assert.equal(provenance.body.result.structuredContent.claimId, "claim-1");
  assert.equal(provenance.body.result.structuredContent.root, "claim-1");

  const empty = await f.call("list_land_queue", { roomId: "commons" }, f.mint("account-owner", ["work:read"]));
  assert.equal(empty.body.result.isError, undefined);
  assert.deepEqual(empty.body.result.structuredContent.items, []);

  const added = await f.call("add_land_item", { roomId: "commons", repo: "Uuriko/project-room", prNumber: 4055 },
    f.mint("account-owner", ["work:write"]));
  assert.equal(added.body.result.isError, undefined);
  assert.equal(added.body.result.structuredContent.item.repo, "Uuriko/project-room");
  assert.equal(added.body.result.structuredContent.item.prNumber, 4055);
  // The land item records the bound agent member as its actor.
  assert.equal(added.body.result.structuredContent.item.addedByMemberId, grant.agentIdentityId);
  const itemId = added.body.result.structuredContent.item.itemId;
  assert.equal(typeof itemId, "string");

  const listed = await f.call("list_land_queue", { roomId: "commons" }, all);
  assert.equal(listed.body.result.structuredContent.items.length, 1);
  assert.equal(listed.body.result.structuredContent.items[0].addedByMemberId, grant.agentIdentityId);

  const tipped = await f.call("report_tip", { roomId: "commons", itemId, sourceRevision: "deadbeefcafe" },
    f.mint("account-owner", ["work:write"]));
  assert.equal(tipped.body.result.isError, undefined);

  const removed = await f.call("remove_land_item", { roomId: "commons", itemId },
    f.mint("account-owner", ["work:write"]));
  assert.equal(removed.body.result.isError, undefined);
  assert.equal(removed.body.result.structuredContent.removed, true);
});

test("oauth member card: a private card stays hidden from an OAuth viewer (fail-closed)", async t => {
  const f = await serve(t);
  const res = await f.call("room_member_card", { roomId: "commons", memberId: "card-agent" },
    f.mint("account-owner", ALL_SCOPES));
  assert.equal(res.body.result.isError, true);
  assert.equal(res.body.result.structuredContent.status, 404);
  assert.equal(res.body.result.structuredContent.code, "unknown_card");
});

test("oauth scope gates: missing scope is 403 insufficient_scope naming the scope", async t => {
  const f = await serve(t);

  const pack = await f.call("room_activation_pack", { roomId: "commons" },
    f.mint("account-owner", ["rooms:read", "chat:read"]));
  assert.equal(pack.body.result.isError, true);
  assert.equal(pack.body.result.structuredContent.status, 403);
  assert.equal(pack.body.result.structuredContent.code, "insufficient_scope");
  assert.match(pack.body.result.structuredContent.message, /work:read/);

  const access = await f.call("room_check_access", { roomId: "commons" }, f.mint("account-owner", ["work:read"]));
  assert.equal(access.body.result.structuredContent.code, "insufficient_scope");
  assert.match(access.body.result.structuredContent.message, /rooms:read/);

  const add = await f.call("add_land_item", { roomId: "commons", repo: "Uuriko/project-room", prNumber: 4055 },
    f.mint("account-owner", ["work:read"]));
  assert.equal(add.body.result.structuredContent.code, "insufficient_scope");
  assert.match(add.body.result.structuredContent.message, /work:write/);
});

test("oauth exclusions: every other tool fails insufficient_scope even with all five scopes", async t => {
  const f = await serve(t);
  const all = f.mint("account-owner", ALL_SCOPES);
  const excluded = [
    ["room_post_message", { roomId: "commons", body: "hello from oauth" }],
    ["room_list_work", { roomId: "commons" }],
    ["room_accept_work", { roomId: "commons" }],
    ["bond_propose", { roomId: "commons", id: randomUUID(), to: randomUUID() }],
    ["room_create", { title: "Nope", purpose: "oauth must not create rooms" }],
    ["inbox_list_attachments", {}],
    ["wake_pause", { roomId: "commons" }],
    ["room_run_action", { name: "room_post_message", arguments: { roomId: "commons", body: "smuggled" } }],
  ];
  for (const [name, args] of excluded) {
    const res = await f.call(name, args, all);
    assert.equal(res.body.result?.isError, true, name);
    assert.equal(res.body.result.structuredContent.status, 403, name);
    assert.equal(res.body.result.structuredContent.code, "insufficient_scope", name);
    assert.match(res.body.result.structuredContent.message, /not available to OAuth grants/, name);
  }
  // The identity-wide check_access form is not bindable per room either.
  const identityWide = await f.call("room_check_access", {}, all);
  assert.equal(identityWide.body.result.structuredContent.code, "insufficient_scope");
});

test("oauth door failures: non-member binds 403; expired, revoked and unknown tokens get -32001 with the exact challenge", async t => {
  const f = await serve(t);

  const nonMember = await f.call("room_check_access", { roomId: "commons" }, f.mint("account-other", ALL_SCOPES));
  assert.equal(nonMember.body.result.isError, true);
  assert.equal(nonMember.body.result.structuredContent.status, 403);
  assert.equal(nonMember.body.result.structuredContent.code, "access_denied");
  assert.equal(nonMember.body.result.structuredContent.message, "This account has no membership in that Room");

  const revoked = f.mint("account-owner", ALL_SCOPES);
  assert.equal(f.provider.revoke(revoked), true);
  for (const [label, token] of [
    ["expired", f.mintExpired("account-owner", ALL_SCOPES)],
    ["revoked", revoked],
    ["fabricated", "oat_" + "Z".repeat(43)],
  ]) {
    const listed = await f.rpc("tools/list", undefined, token);
    assert.equal(listed.status, 401, label);
    assert.equal(listed.body.error.code, -32001, label);
    assert.equal(listed.body.error.message, "Hosted room tools require a live identity or room token", label);
    assert.equal(listed.body.error.data, undefined, label);
    const challenge = listed.headers.get("www-authenticate");
    assert.equal(challenge, WWW_AUTHENTICATE_TODAY, label);
    assert.equal(challenge.includes("resource_metadata"), false, label);
  }
});

test("no-verifier construction: oat_ is rejected exactly as before stage 1", async t => {
  const f = await serve(t);
  const token = f.mint("account-owner", ALL_SCOPES);
  const hosted = createHostedRoomMcp(f.store);
  const reply = await hosted(
    { jsonrpc: "2.0", id: "t", method: "tools/list" },
    { authorization: `Bearer ${token}` },
  );
  assert.equal(reply.error.code, -32001);
  assert.equal(reply.error.message, "Hosted room tools require a live identity or room token");
});

test("identity secret and anonymous behaviour at the /mcp door are unchanged", async t => {
  const f = await serve(t);

  const anonList = await f.rpc("tools/list");
  assert.equal(anonList.status, 200);
  assert.deepEqual(anonList.body.result.tools.map(tool => tool.name), ANON_MCP_TOOLS);

  const identityList = await f.rpc("tools/list", undefined, f.identity.secret);
  assert.equal(identityList.status, 200);
  assert.equal(identityList.body.result.profile, "core");

  const access = await f.call("room_check_access", { roomId: "commons" }, f.identity.secret);
  assert.equal(access.status, 200);
  assert.equal(access.body.result.structuredContent.status, "credential_accepted");
  assert.equal(access.body.result.structuredContent.memberId, "agent");
});
