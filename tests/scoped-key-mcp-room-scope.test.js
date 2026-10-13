// Lane A1 auth audit: a scoped rak_ API key must not exceed its scopes over
// the hosted MCP core-profile room tools. HTTP already confines api-key
// callers to rooms:read (GET/HEAD) / rooms:write (writes) on every room
// route; the MCP core-profile dispatch called the same store methods with
// no scope check, so a key minted for a narrow purpose (e.g.
// skills:publish) could read and write any linked room — including
// membership-admin tools — over MCP while HTTP 403'd it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { API_KEY_PREFIX } from "../server/agent-api-keys.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "scoped-key-mcp-scope-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, rooms };
}

async function call(origin, name, args, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } })
  });
  const body = await response.json();
  return { status: response.status, body, value: body.result?.structuredContent };
}

async function fixture(t) {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Scope owner");
  const agent = store.identities.create("Scope agent");
  const created = rooms.create(owner.secret, {
    roomId: "scope-room", title: "Scope room", purpose: "scoped-key MCP scope test",
    kind: "personal", displayName: "Scope owner"
  });
  store.identities.link(owner.secret, created.roomId, {
    identityId: agent.identityId, displayName: "Scope agent", permissions: []
  });
  setTier(store.db, created.roomId, agent.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const issue = scopes => API_KEY_PREFIX + store.agentPlugin.issueApiKey({ identityId: agent.identityId, scopes }).secret;
  return { origin, store, roomId: created.roomId, owner, issue };
}

test("narrow key cannot post to the room over MCP (parity with HTTP 403)", async t => {
  const { origin, roomId, issue } = await fixture(t);
  const narrow = issue(["skills:publish"]);
  // HTTP control: the same key is refused on the HTTP command route.
  const viaHttp = await fetch(`${origin}/api/rooms/${roomId}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${narrow}` },
    body: JSON.stringify({ id: "http-1", type: "message.posted", data: { messageId: "http-m1", body: "http" } })
  });
  assert.equal(viaHttp.status, 403);
  // MCP must refuse the same way instead of posting.
  const posted = await call(origin, "room_post_message",
    { roomId, id: "narrow-1", messageId: "narrow-m1", body: "scope escape" }, narrow);
  assert.equal(posted.body.result.isError, true);
  assert.equal(posted.value.status, 403);
  assert.equal(posted.value.code, "insufficient_scope");
});

test("narrow key cannot read the room over MCP", async t => {
  const { origin, roomId, issue } = await fixture(t);
  const narrow = issue(["skills:publish"]);
  for (const [name, args] of [
    ["room_read_board", { roomId }],
    ["room_list_events", { roomId, after: 0, limit: 5 }],
    ["get_room_context", { roomId }],
  ]) {
    const read = await call(origin, name, args, narrow);
    assert.equal(read.body.result.isError, true, name);
    assert.equal(read.value.status, 403, name);
    assert.equal(read.value.code, "insufficient_scope", name);
  }
});

test("narrow key cannot use membership-admin tools over MCP", async t => {
  const { origin, roomId, owner, issue } = await fixture(t);
  const narrow = issue(["heartbeats:report"]);
  const invite = await call(origin, "room_create_agent_invite", { roomId, profile: "chat" }, owner.secret);
  assert.equal(invite.body.result.isError ?? false, false);
  const listedBefore = await call(origin, "room_list_agent_invites", { roomId }, owner.secret);
  const inviteId = listedBefore.value.invites?.[0]?.inviteId;
  assert.ok(inviteId, "owner creates an invite to revoke");
  const revoked = await call(origin, "room_revoke_agent_invite", { roomId, inviteId }, narrow);
  assert.equal(revoked.body.result.isError, true);
  assert.equal(revoked.value.status, 403);
  assert.equal(revoked.value.code, "insufficient_scope");
  // The invite survives the refused call.
  const listed = await call(origin, "room_list_agent_invites", { roomId }, narrow);
  assert.equal(listed.body.result.isError, true);
  assert.equal(listed.value.code, "insufficient_scope");
});

test("read-scoped key reads but does not write over MCP", async t => {
  const { origin, roomId, issue } = await fixture(t);
  const reader = issue(["rooms:read"]);
  const read = await call(origin, "room_read_board", { roomId }, reader);
  assert.equal(read.body.result.isError ?? false, false);
  const posted = await call(origin, "room_post_message",
    { roomId, id: "reader-1", messageId: "reader-m1", body: "nope" }, reader);
  assert.equal(posted.body.result.isError, true);
  assert.equal(posted.value.status, 403);
  assert.equal(posted.value.code, "insufficient_scope");
});

test("write-scoped key keeps working over MCP (no regression)", async t => {
  const { origin, roomId, issue } = await fixture(t);
  const writer = issue(["rooms:read", "rooms:write"]);
  const posted = await call(origin, "room_post_message",
    { roomId, id: "writer-1", messageId: "writer-m1", body: "allowed" }, writer);
  assert.equal(posted.body.result.isError ?? false, false);
  assert.equal(posted.value.status, "posted");
  const read = await call(origin, "room_read_board", { roomId }, writer);
  assert.equal(read.body.result.isError ?? false, false);
});

test("onboarding MCP token keeps its full room+inbox+wake surface", async t => {
  const { origin, store, roomId, owner } = await fixture(t);
  const agent = store.identities.create("Onboard agent");
  store.identities.link(owner.secret, roomId, {
    identityId: agent.identityId, displayName: "Onboard agent", permissions: []
  });
  const token = store.agentPlugin.issueOnboardingMcpToken({ identityId: agent.identityId, roomId, label: "probe" });
  const key = token.credential;
  assert.deepEqual(token.scopes, [`mcp:room:${roomId}`, "rooms:read", "rooms:write", "mcp:inbox", "mcp:wake"]);
  const posted = await call(origin, "room_post_message",
    { roomId, id: "ob-1", messageId: "ob-m1", body: "onboarding post" }, key);
  assert.equal(posted.body.result.isError ?? false, false);
  assert.equal(posted.value.status, "posted");
});

test("keys without rooms scopes are refused on MCP post and read, as REST /commands is", async t => {
  const { origin, roomId, issue } = await fixture(t);
  for (const scopes of [["heartbeats:read"], ["nothing:here"], [`mcp:room:${roomId}`]]) {
    const key = issue(scopes);
    const label = scopes.join(",");
    const viaHttp = await fetch(`${origin}/api/rooms/${roomId}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ id: "m-http", type: "message.posted", data: { messageId: "m-http", body: "http" } })
    });
    assert.equal(viaHttp.status, 403, label);
    const posted = await call(origin, "room_post_message", { roomId, id: "m-1", messageId: "m-1", body: "x" }, key);
    assert.equal(posted.value.code, "insufficient_scope", `${label} post`);
    const read = await call(origin, "room_read_board", { roomId }, key);
    assert.equal(read.value.code, "insufficient_scope", `${label} read`);
  }
});

test("hosted full-profile tools are gated the same way", async t => {
  const { origin, roomId, issue } = await fixture(t);
  const none = issue(["nothing:here"]);
  const read = await call(origin, "room_read_messages", { roomId }, none);
  assert.equal(read.value.code, "insufficient_scope");
  const reader = issue(["rooms:read"]);
  const readOk = await call(origin, "room_read_messages", { roomId }, reader);
  assert.notEqual(readOk.value?.code, "insufficient_scope");
  // room_close_work_claim retires a claim: a write, refused for a read-only key.
  const close = await call(origin, "room_close_work_claim", { roomId, claimId: "no-such-claim" }, reader);
  assert.equal(close.value.code, "insufficient_scope");
});

test("a room-pinned key with rooms:read and rooms:write keeps working", async t => {
  const { origin, roomId, issue } = await fixture(t);
  const key = issue([`mcp:room:${roomId}`, "rooms:read", "rooms:write"]);
  const posted = await call(origin, "room_post_message", { roomId, id: "p-1", messageId: "p-m1", body: "pinned" }, key);
  assert.equal(posted.value.status, "posted");
});

import { hostedMcpToolDefs } from "../server/mcp-hosted-tools.mjs";
import { hostedStdioToolDefinitions } from "../server/mcp-full-profile.mjs";

// Minimal schema-valid arguments, so a call reaches the scope gate (which runs
// after argument validation) instead of failing on its shape.
function sampleArgs(name, roomId) {
  const def = [...hostedMcpToolDefs, ...hostedStdioToolDefinitions()].find(entry => entry.name === name);
  assert.ok(def, `${name} is an exposed tool`);
  const args = {};
  for (const key of def.inputSchema.required ?? []) {
    const spec = def.inputSchema.properties[key];
    const type = Array.isArray(spec.type) ? spec.type[0] : spec.type;
    args[key] = key === "roomId" ? roomId : spec.enum ? spec.enum[0]
      : type === "integer" || type === "number" ? 1 : type === "boolean" ? true : type === "array" ? []
        : key === "deadline" ? "2099-01-01T00:00:00.000Z" : "x1";
  }
  return args;
}

// Every family of write tool: ordinary messages, reactions, reply requests and
// responses, help offers, work actions, drafts, claims, bounties. A mutant that
// classifies any of them as a read lets a rooms:read key through.
const WRITE_TOOLS = [
  "room_post_message", "room_react",
  "room_reply", "room_respond_to_request", "room_request_reply", "room_cancel_request",
  "room_offer_help", "room_select_help_offer", "room_withdraw_help_offer",
  "room_begin_work", "room_start_work", "room_propose_work", "room_record_completion",
  "room_post_draft", "room_close_work_claim",
  "bounty_post", "bounty_claim",
  "room_create", "squads_create", "room_decide_access_request", "bond_propose", "bond_accept", "dm_posted", "room_discard_file", "remove_land_item",
];

test("a rooms:read key is refused 403 on every write tool family over MCP", async t => {
  const { origin, roomId, issue } = await fixture(t);
  const reader = issue(["rooms:read"]);
  for (const name of WRITE_TOOLS) {
    const result = await call(origin, name, sampleArgs(name, roomId), reader);
    assert.equal(result.value?.code, "insufficient_scope", `${name}: ${JSON.stringify(result.value ?? result.body).slice(0, 160)}`);
    assert.equal(result.value.status, 403, name);
    assert.match(result.value.message ?? "", /rooms:write/, name);
  }
});

test("a read-only key still reaches the read tools of the same families", async t => {
  const { origin, roomId, issue } = await fixture(t);
  const reader = issue(["rooms:read"]);
  for (const name of ["room_list_requests", "room_read_inbox", "room_read_board", "bounty_list"]) {
    const result = await call(origin, name, sampleArgs(name, roomId), reader);
    assert.notEqual(result.value?.code, "insufficient_scope", name);
  }
});

test("a key pinned to another room is told it is limited to its room, on read and write, as REST says", async t => {
  const { origin, roomId, issue } = await fixture(t);
  for (const scopes of [["mcp:room:other"], ["mcp:room:other", "rooms:read", "rooms:write"]]) {
    const key = issue(scopes);
    for (const [name, args] of [["room_read_board", { roomId }], ["room_post_message", { roomId, id: "p1", messageId: "p1", body: "x" }]]) {
      const result = await call(origin, name, args, key);
      assert.equal(result.value.code, "insufficient_scope", `${scopes} ${name}`);
      assert.equal(result.value.message, "This key is limited to its room", `${scopes} ${name}`);
    }
  }
});
