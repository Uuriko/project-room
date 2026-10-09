// MCP ergonomics (lane 4, plug-in crew): confusing tool names get canonical
// renames with backward-compatible aliases, and dm_send mints messageId like
// room_post_message does.
//
// Authoring gate (.agents/skills/test-audit/SKILL.md):
// 1. Protects the rename backward-compat contract: after a canonical rename,
//    the old snake_case name must still dispatch on tools/call, and tools/list
//    must advertise the new name (old names only under aliases=1). Also
//    protects dm_send's messageId defaulting (parity with room_post_message).
// 2. Credible regressions: a rename drops the alias map entry (production
//    clients calling the old name get unknown_tool); a rename misses the
//    spend-pricing or focus-group maps (tool silently unpriced or undiscoverable);
//    dm_send without messageId 422s.
// 3. Existing coverage: tests/mcp-dotted-aliases.test.js pins the dotted
//    legacy map only; nothing covers snake_case renames, the aliases=1
//    listing of old names, or dm messageId minting.
// 4. No production seams: every assertion goes through the real HTTP MCP
//    boundary (POST /room/mcp) or the exported canonical-name helpers.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";
import {
  HOSTED_ROOM_MCP_TOOLS, MCP_TOOL_RENAMES, canonicalMcpToolName, mcpToolRename,
  isHostedMcpToolName, MCP_TOOL_NAME_RE,
} from "../src/room-mcp-join.js";
import { hostedMcpToolDefs } from "../server/mcp-hosted-tools.mjs";
import { priceForTool } from "../server/spend-grants.mjs";

// Old confusing name -> new canonical name. Pinned explicitly (not derived
// from the source) so a dropped or added rename fails loudly here.
const EXPECTED_RENAMES = Object.freeze({
  "dm_posted": "dm_send",
  "add_land_item": "room_add_land_item",
  "list_land_queue": "room_list_land_queue",
  "remove_land_item": "room_remove_land_item",
  "report_tip": "room_report_land_tip",
});

test("rename registry: the documented rename set is exactly the pinned contract", () => {
  assert.deepEqual({ ...MCP_TOOL_RENAMES }, { ...EXPECTED_RENAMES });
  for (const [oldName, canonical] of Object.entries(EXPECTED_RENAMES)) {
    assert.match(canonical, MCP_TOOL_NAME_RE, `${canonical} must be a legal tool name`);
    assert.equal(canonicalMcpToolName(oldName), canonical, `${oldName} must canonicalize`);
    assert.equal(canonicalMcpToolName(canonical), canonical, `${canonical} must be stable`);
    assert.equal(mcpToolRename(canonical), oldName, `reverse map for ${canonical}`);
    assert.ok(HOSTED_ROOM_MCP_TOOLS.includes(canonical), `${canonical} must be a hosted tool`);
    assert.ok(!HOSTED_ROOM_MCP_TOOLS.includes(oldName), `${oldName} must not be canonical anymore`);
    assert.equal(isHostedMcpToolName(oldName), true, `${oldName} must still be callable`);
  }
  assert.equal(mcpToolRename("room_post_message"), null, "tools without a rename have no reverse entry");
});

test("rename registry: canonical tool definitions match the renamed catalog", () => {
  const defNames = hostedMcpToolDefs.map(entry => entry.name);
  assert.deepEqual(defNames, [...HOSTED_ROOM_MCP_TOOLS], "definitions must follow the canonical catalog order");
  for (const canonical of Object.values(EXPECTED_RENAMES)) {
    assert.ok(defNames.includes(canonical), `definition for ${canonical}`);
  }
});

test("rename registry: spend pricing follows the canonical land-queue name", () => {
  assert.equal(priceForTool("room_add_land_item"), 1, "renamed tool keeps its 1c price");
  assert.equal(priceForTool("add_land_item"), null, "old name is not priced separately");
});

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "mcp-ergonomics-"));
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
  return { body, value: body.result?.structuredContent, isError: body.result?.isError === true };
}

async function listTools(origin, secret, query = "") {
  const { body } = await rpc(origin, "tools/list", { profile: "full" }, secret, query);
  return body.result.tools;
}

async function fixture(t) {
  const { origin, store, rooms } = await serve(t);
  const ada = store.identities.create("Ada");
  const bob = store.identities.create("Bob");
  const roomId = rooms.create(ada.secret, {
    roomId: "dm-den", title: "DM den", purpose: "Ergonomics", kind: "personal", displayName: "Ada",
  }).roomId;
  for (const identity of [bob]) {
    store.identities.link(ada.secret, roomId, { identityId: identity.identityId, displayName: "Bob", permissions: [] });
    setTier(store.db, roomId, identity.identityId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  }
  return { origin, store, ada, bob, roomId };
}

test("tools/list advertises canonical names; old names appear only with aliases=1", async t => {
  const { origin, ada } = await fixture(t);
  const names = (await listTools(origin, ada.secret)).map(tool => tool.name);
  for (const canonical of Object.values(EXPECTED_RENAMES)) {
    assert.ok(names.includes(canonical), `listed: ${canonical}`);
  }
  for (const oldName of Object.keys(EXPECTED_RENAMES)) {
    assert.ok(!names.includes(oldName), `hidden by default: ${oldName}`);
  }
  const aliased = await listTools(origin, ada.secret, "?aliases=1");
  const dmSend = aliased.find(tool => tool.name === "dm_send");
  assert.ok(dmSend, "dm_send listed with aliases=1");
  assert.ok((dmSend.aliases ?? []).includes("dm_posted"), "old snake_case name shown as alias");
  assert.ok((dmSend.aliases ?? []).includes("dm.posted"), "dotted legacy name still shown as alias");
  const landAdd = aliased.find(tool => tool.name === "room_add_land_item");
  assert.ok((landAdd.aliases ?? []).includes("add_land_item"), "old land-queue name shown as alias");
});

test("old names still dispatch on tools/call", async t => {
  const { origin, ada, roomId } = await fixture(t);
  const listed = await call(origin, "list_land_queue", { roomId }, ada.secret);
  assert.equal(listed.isError, false, JSON.stringify(listed.body));
  assert.ok(Array.isArray(listed.value.items), "old list_land_queue dispatches to the land queue");
  const canonical = await call(origin, "room_list_land_queue", { roomId }, ada.secret);
  assert.deepEqual(canonical.value, listed.value, "alias and canonical return the same value");
});

test("dm_send mints messageId when omitted, like room_post_message", async t => {
  const { origin, ada, bob, roomId } = await fixture(t);
  const proposed = await call(origin, "bond_propose", { roomId, id: "bond-1", to: bob.identityId }, ada.secret);
  assert.equal(proposed.isError, false, JSON.stringify(proposed.body));
  const bondId = proposed.value.event.data.bondId;
  const accepted = await call(origin, "bond_accept", { roomId, id: "bond-2", bondId, scopes: ["peer.dm"] }, bob.secret);
  assert.equal(accepted.value.status, "accepted");
  // New canonical name, no messageId: the server mints one.
  const sent = await call(origin, "dm_send", { roomId, id: "dm-1", to: bob.identityId, body: "hello without messageId" }, ada.secret);
  assert.equal(sent.isError, false, JSON.stringify(sent.body));
  assert.equal(sent.value.status, "posted");
  assert.match(sent.value.command.data.messageId, /^[0-9a-f-]{36}$/, "minted messageId is a UUID");
  // Old name still works and also mints.
  const legacy = await call(origin, "dm_posted", { roomId, id: "dm-2", to: bob.identityId, body: "hello legacy" }, ada.secret);
  assert.equal(legacy.isError, false, JSON.stringify(legacy.body));
  assert.match(legacy.value.command.data.messageId, /^[0-9a-f-]{36}$/, "legacy name mints too");
  // Explicit messageId is still honored.
  const explicit = await call(origin, "dm_send", { roomId, id: "dm-3", to: bob.identityId, messageId: "my-msg", body: "hello explicit" }, ada.secret);
  assert.equal(explicit.value.command.data.messageId, "my-msg");
});
