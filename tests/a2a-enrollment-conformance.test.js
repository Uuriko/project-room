// A2A card / SWARM-PLUG-IN.md enrollment conformance — hard task 93.
//
// One test client that walks the documented agent-to-agent enrollment flow
// end to end against a local room, asserting every step the way any AI
// would: machine discovery first, then mint identity, create an agent-owned
// room, mint a one-time invite code, redeem it as a peer, and confirm with
// the activation pack — plus the documented guarantees (single-use codes,
// agent-safe permissions only, no identity-secret leak at redeem).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { agentRoomSchema } from "../server/agent-rooms.mjs";

const COLLABORATE = ["steer", "accept_work", "complete_work", "verify"];

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-a2a-conformance-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, { token, data } = {}) => fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(data ?? {}),
  }).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));
  const get = (path, token) => fetch(`${origin}${path}`, {
    headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }).then(async res => ({ status: res.status, text: await res.text() }));
  return { store, origin, post, get };
}

test("any AI discovers the room through the machine-readable doors", async t => {
  const { get } = await serve(t);
  // SWARM-PLUG-IN.md "Machine discovery": agent.json, the A2A card, llms.txt.
  const card = await get("/.well-known/agent-card.json");
  assert.equal(card.status, 200, "A2A card is served");
  const cardJson = JSON.parse(card.text);
  assert.ok(typeof cardJson.name === "string" && cardJson.name.length > 0, "card names the agent");
  assert.ok(typeof cardJson.url === "string" && cardJson.url.length > 0, "card points at the service");
  const agent = await get("/.well-known/agent.json");
  assert.equal(agent.status, 200, "agent.json discovery door is served");
  const llms = await get("/llms.txt");
  assert.equal(llms.status, 200, "llms.txt onboarding packet is served");
  assert.match(llms.text, /After paste/i, "llms.txt carries the shared-invitation flow");
});

test("SWARM-PLUG-IN.md enrollment end to end: mint identity, own room, invite, redeem, confirm", async t => {
  const { store, post, get } = await serve(t);

  // Step 1 — mint an identity with only the service origin. 201; secret shown once.
  const minted = await post("/api/agent-identities", { data: { displayName: "Conformance Owner" } });
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  assert.match(minted.json.identityId, /^ai_/);
  assert.match(minted.json.secret, /^pri_/, "the identity secret is a pri_ credential");
  const ownerSecret = minted.json.secret;

  // Step 2 — create an agent-owned room with the identity secret. No human token.
  const roomId = "a2a-conformance-den";
  const created = await post("/api/agent-rooms", {
    token: ownerSecret,
    data: { roomId, title: "A2A Conformance Den", purpose: "Enrollment conformance", kind: "personal", displayName: "Den Keeper" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.roomId, roomId);
  assert.equal(created.json.ownerMemberId, minted.json.identityId, "the identity becomes the room owner");
  assert.equal(created.json.duplicate, false);
  const invitePath = created.json.next?.find(n => n.action === "invite-members")?.path;
  assert.ok(invitePath?.includes(`/api/rooms/${roomId}/agent-invites`),
    "the room-create response names the invite-mint path as the next step");

  // Step 3 — mint a one-time invite for a peer: profile maps server-side to a fixed set.
  const invite = await post(`/api/rooms/${roomId}/agent-invites`, {
    token: ownerSecret,
    data: { profile: "collaborate", expiresInMinutes: 60, displayName: "Conformance Peer" },
  });
  assert.equal(invite.status, 201, JSON.stringify(invite.json));
  assert.match(invite.json.code, /^RM-/, "v2 one-time code");
  assert.deepEqual(invite.json.permissions, COLLABORATE, "collaborate maps to its fixed server-side set");
  for (const forbidden of ["manage_members", "decide", "invite_member"]) {
    assert.ok(!invite.json.permissions.includes(forbidden), `invites can never grant ${forbidden}`);
  }

  // Step 4 — the peer redeems with origin + code only.
  const redeemed = await post("/api/agent-invites/redeem", { data: { code: invite.json.code, displayName: "Conformance Peer" } });
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.json));
  assert.equal(redeemed.json.roomId, roomId);
  assert.match(redeemed.json.identityId, /^ai_/, "the peer gets its own identity");
  assert.equal(redeemed.json.memberId, redeemed.json.identityId, "peer member id is its identity");
  assert.deepEqual(redeemed.json.permissions, COLLABORATE, "redemption grants the code's scope and nothing more");
  assert.match(redeemed.json.mcpToken.credential, /^rak_/, "the peer gets a room-scoped rak_ token");
  const serialized = JSON.stringify(redeemed.json);
  assert.ok(!serialized.includes("\"secret\":\"pri_"), "no pri_ secret leaks in the redeem response");

  // The roster agrees: the peer holds agent-safe permissions only.
  const member = store.room(roomId).state.members[redeemed.json.memberId];
  assert.equal(member.kind, "agent");
  assert.deepEqual([...member.permissions].sort(), [...COLLABORATE].sort());
  assert.equal(member.referredBy, minted.json.identityId, "the minter is attributed as the referrer");

  // Step 5 — confirm: the peer reads its activation pack with the room token. 200 = in.
  const pack = await get(`/api/rooms/${roomId}/activation-pack`, redeemed.json.mcpToken.credential);
  assert.equal(pack.status, 200, "activation-pack 200 means the peer is enrolled");
});

test("documented guarantees: single-use codes, no admin bits, identity-wide routes refuse room tokens", async t => {
  const { store, post } = await serve(t);
  const minted = await post("/api/agent-identities", { data: { displayName: "Guarantee Owner" } });
  assert.equal(minted.status, 201);
  const created = await post("/api/agent-rooms", {
    token: minted.json.secret,
    data: { roomId: "a2a-guarantee-den", title: "Guarantee Den", purpose: "guarantees", kind: "personal", displayName: "Keeper" },
  });
  assert.equal(created.status, 201);
  const roomId = "a2a-guarantee-den";

  // Admin bits are rejected at issuance, not just filtered at redeem.
  const evil = await post(`/api/rooms/${roomId}/agent-invites`, {
    token: minted.json.secret,
    data: { permissions: ["accept_work", "manage_members"], expiresInMinutes: 60 },
  });
  assert.equal(evil.status, 422, "an invite can never be minted with manage_members");
  assert.equal(evil.json.error.code, "invalid_invite_scope");

  const invite = await post(`/api/rooms/${roomId}/agent-invites`, {
    token: minted.json.secret,
    data: { profile: "contribute", expiresInMinutes: 60 },
  });
  assert.equal(invite.status, 201);
  const first = await post("/api/agent-invites/redeem", { data: { code: invite.json.code, displayName: "First Peer" } });
  assert.equal(first.status, 201);
  // A code is single-use: the second redemption fails, it never re-enrolls.
  const second = await post("/api/agent-invites/redeem", { data: { code: invite.json.code, displayName: "Second Peer" } });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, "invite_already_used");

  // The room-scoped rak_ token is room-scoped: identity-wide routes refuse it.
  const rooms = await post("/api/agent-rooms", {
    token: first.json.mcpToken.credential,
    data: { roomId: "a2a-escape-den", title: "Escape", purpose: "no", kind: "personal", displayName: "No" },
  });
  assert.ok([401, 403].includes(rooms.status), "a room token cannot mint rooms identity-wide");
});
