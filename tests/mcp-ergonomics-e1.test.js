// MCP ergonomics, lane E1 (residual scope after wave40-W06 PR #1941):
// actionable argument errors, honest room_create idempotency docs, and
// optional receipt keys on bond/DM writes (parity with room_post_message).
//
// Authoring gate (.agents/skills/test-audit/SKILL.md):
// 1. Protects three observable contracts: (a) tools/call -32602 errors for
//    XOR-style parameters name the specific missing choice instead of the
//    generic "does not match the tool input"; (b) the room_create tool
//    description no longer claims a defaulted roomId is an idempotency key
//    (the default slug carries a random suffix, so an omitted roomId is not
//    retry-safe; only an explicit roomId replays); (c) bond_propose,
//    bond_accept, bond_decline, bond_revoke, and dm_posted accept an omitted
//    id and return a server-minted receipt key, like room_post_message and
//    room_react already do.
// 2. Credible regressions: a validation refactor collapses the XOR cases
//    back to the generic message (agents guess instead of fixing); a doc
//    edit re-adds the idempotency claim (agents retry room_create and get
//    duplicate rooms); a schema edit re-requires id (agents must mint UUIDs
//    for bond/DM writes while post/react mint server-side).
// 3. Existing coverage: tests/mcp-ergonomics.test.js (#1941, unmerged)
//    covers renames and dm messageId minting; tests/mcp-calltime-denials
//    covers denials; none covers XOR diagnosis specificity, the room_create
//    description, or id-optionality on bond/DM writes.
// 4. No production seams: every assertion goes through the real HTTP MCP
//    boundary (POST /room/mcp) or the exported tool-definition list.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import { hostedMcpToolDefs } from "../server/mcp-hosted-tools.mjs";

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "mcp-e1-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, store, rooms });
  }));
}

async function rpc(origin, method, params, secret, query = "") {
  const response = await fetch(`${origin}/room/mcp${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, params }),
  });
  return response.json().then(body => ({ status: response.status, body }));
}

async function call(origin, name, args, secret) {
  const { body } = await rpc(origin, "tools/call", { name, arguments: args }, secret);
  return { body, value: body.result?.structuredContent, isError: body.result?.isError === true, error: body.error };
}

async function fixture(t) {
  const { origin, store, rooms } = await serve(t);
  const ada = store.identities.create("Ada");
  const bob = store.identities.create("Bob");
  const roomId = rooms.create(ada.secret, {
    roomId: "e1-den", title: "E1 den", purpose: "Ergonomics", kind: "personal", displayName: "Ada",
  }).roomId;
  store.identities.link(ada.secret, roomId, { identityId: bob.identityId, displayName: "Bob", permissions: [] });
  setTier(store.db, roomId, bob.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  return { origin, store, ada, bob, roomId };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("room_join names the missing choice instead of the generic message", async t => {
  const { origin, ada, roomId } = await fixture(t);
  const neither = await call(origin, "room_join", {}, ada.secret);
  assert.equal(neither.error?.code, -32602);
  assert.equal(neither.error.data.invalid.linkToken, "pass exactly one of linkToken, inviteCode");
  assert.ok(!("arguments" in (neither.error.data.invalid ?? {})), "no generic fallback");
  const both = await call(origin, "room_join", { linkToken: "x", inviteCode: "y" }, ada.secret);
  assert.equal(both.error?.code, -32602);
  assert.equal(both.error.data.invalid.linkToken, "pass exactly one of linkToken, inviteCode");
  // Sanity: a real join path still validates the token itself, not the shape.
  const bad = await call(origin, "room_join", { linkToken: "nope" }, ada.secret);
  assert.equal(bad.value?.code, "link_unavailable");
  void roomId;
});

test("room_create_agent_invite names the missing scope instead of the generic message", async t => {
  const { origin, ada, roomId } = await fixture(t);
  const neither = await call(origin, "room_create_agent_invite", { roomId }, ada.secret);
  assert.equal(neither.error?.code, -32602);
  assert.equal(neither.error.data.invalid.profile, "pass profile or permissions (not both)");
  assert.ok(!("arguments" in (neither.error.data.invalid ?? {})), "no generic fallback");
});

test("room_create description is honest about the idempotency key", () => {
  const def = hostedMcpToolDefs.find(entry => entry.name === "room_create");
  assert.ok(def, "room_create is a hosted tool");
  assert.ok(!def.description.includes("is the idempotency key"),
    "the defaulted roomId must not be called the idempotency key: the default slug carries a random suffix");
  assert.match(def.description, /explicit roomId/i, "documents the explicit-roomId replay");
  assert.match(def.description, /random/i, "documents the random suffix on the default");
});

test("bond_propose mints id when omitted, honors it when given", async t => {
  const { origin, ada, bob, roomId } = await fixture(t);
  const minted = await call(origin, "bond_propose", { roomId, to: bob.identityId }, ada.secret);
  assert.equal(minted.isError, false, JSON.stringify(minted.body));
  assert.equal(minted.value.status, "proposed");
  assert.match(minted.value.command.id, UUID_RE, "server-minted receipt key is a UUID");
  const explicit = await call(origin, "bond_propose", { roomId, id: "e1-bond-explicit", to: bob.identityId }, ada.secret);
  assert.equal(explicit.isError, false, JSON.stringify(explicit.body));
  assert.equal(explicit.value.command.id, "e1-bond-explicit", "explicit id is honored");
});

test("bond_accept, bond_decline, and bond_revoke mint id when omitted", async t => {
  const { origin, ada, bob, roomId } = await fixture(t);
  const p1 = await call(origin, "bond_propose", { roomId, id: "e1-b1", to: bob.identityId }, ada.secret);
  const bondId = p1.value.event.data.bondId;
  const accepted = await call(origin, "bond_accept", { roomId, bondId, scopes: ["peer.dm"] }, bob.secret);
  assert.equal(accepted.isError, false, JSON.stringify(accepted.body));
  assert.equal(accepted.value.status, "accepted");
  assert.match(accepted.value.command.id, UUID_RE, "bond_accept mints id");
  const revoked = await call(origin, "bond_revoke", { roomId, bondId }, ada.secret);
  assert.equal(revoked.isError, false, JSON.stringify(revoked.body));
  assert.equal(revoked.value.status, "revoked");
  assert.match(revoked.value.command.id, UUID_RE, "bond_revoke mints id");
  const p2 = await call(origin, "bond_propose", { roomId, id: "e1-b2", to: bob.identityId }, ada.secret);
  const declined = await call(origin, "bond_decline", { roomId, bondId: p2.value.event.data.bondId }, bob.secret);
  assert.equal(declined.isError, false, JSON.stringify(declined.body));
  assert.equal(declined.value.status, "declined");
  assert.match(declined.value.command.id, UUID_RE, "bond_decline mints id");
});

test("dm_posted mints id when omitted", async t => {
  const { origin, ada, bob, roomId } = await fixture(t);
  const p = await call(origin, "bond_propose", { roomId, id: "e1-dm-b1", to: bob.identityId }, ada.secret);
  await call(origin, "bond_accept", { roomId, id: "e1-dm-b2", bondId: p.value.event.data.bondId, scopes: ["peer.dm"] }, bob.secret);
  const sent = await call(origin, "dm_posted",
    { roomId, to: bob.identityId, messageId: "e1-dm-m1", body: "hello without id" }, ada.secret);
  assert.equal(sent.isError, false, JSON.stringify(sent.body));
  assert.equal(sent.value.status, "posted");
  assert.match(sent.value.command.id, UUID_RE, "server-minted command id is a UUID");
  assert.equal(sent.value.command.data.messageId, "e1-dm-m1", "explicit messageId still honored");
});
