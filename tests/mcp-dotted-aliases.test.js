// QA wave-2 gap: dotted tool aliases. Naming contract for the hosted MCP:
// - Canonical tool names are snake_case and match MCP_TOOL_NAME_RE.
// - Dotted aliases exist ONLY for the legacy names in MCP_TOOL_ALIASES
//   (bond.*, dm.posted, wake.*, heartbeat.*, webhook.*). They work on
//   tools/call, behave identically to their canonical tool, and stay hidden
//   from tools/list unless aliases=1.
// - Snake_case renames exist ONLY for the legacy names in MCP_TOOL_RENAMES
//   (dm_posted, add_land_item, list_land_queue, remove_land_item,
//   report_tip). Same contract as dotted aliases: they work on tools/call
//   and are advertised under aliases=1 only.
// - Any other dotted (or otherwise undocumented) name must 404 as
//   unknown_tool with a helpful hint — never reach a tool, never behave
//   differently under an undocumented name.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import {
  HOSTED_ROOM_MCP_TOOLS,
  MCP_TOOL_ALIASES,
  MCP_TOOL_RENAMES,
  MCP_TOOL_NAME_RE,
  canonicalMcpToolName,
  mcpToolAlias,
  mcpToolAliases,
} from "../src/room-mcp-join.js";
import { hostedMcpToolDefs } from "../server/mcp-hosted-tools.mjs";
import { MCP_JOIN_TOOLS } from "../server/mcp-http.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-aliases-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const identity = store.identities.create("Alias");
  rooms.create(identity.secret, {
    roomId: "alias-den", title: "Alias den", purpose: "dotted alias QA", kind: "personal", displayName: "Alias"
  });
  return { origin, secret: identity.secret };
}

function rpc(origin, method, params, secret, query = "") {
  return fetch(`${origin}/room/mcp${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, ...(params === undefined ? {} : { params }) })
  }).then(res => res.json().then(body => ({ status: res.status, body })));
}

async function call(origin, name, args, secret, query = "") {
  return rpc(origin, "tools/call", { name, arguments: args ?? {} }, secret, query);
}

async function list(origin, params, secret, query = "") {
  const { body } = await rpc(origin, "tools/list", params, secret, query);
  return body.result.tools;
}

// The documented dotted-alias contract: these 16 legacy dotted names must keep
// working on tools/call. Pinned explicitly (not derived from the source) so a
// removed or added alias fails loudly here instead of silently shifting the
// contract agents rely on.
const EXPECTED_ALIASES = Object.freeze({
  "bond.propose": "bond_propose",
  "bond.accept": "bond_accept",
  "bond.decline": "bond_decline",
  "bond.revoke": "bond_revoke",
  "bond.list": "bond_list",
  "dm.posted": "dm_send",
  "wake.register": "wake_register",
  "wake.clear": "wake_clear",
  "heartbeat.set": "heartbeat_set",
  "heartbeat.get": "heartbeat_get",
  "heartbeat.ack": "heartbeat_ack",
  "wake.pause": "wake_pause",
  "wake.resume": "wake_resume",
  "webhook.subscribe": "webhook_subscribe",
  "webhook.list": "webhook_list",
  "webhook.unsubscribe": "webhook_unsubscribe",
});

// The documented snake_case-rename contract: these 5 legacy names must keep
// working on tools/call. Pinned explicitly (not derived from the source) so a
// removed or added rename fails loudly here instead of silently shifting the
// contract agents rely on.
const EXPECTED_RENAMES = Object.freeze({
  "dm_posted": "dm_send",
  "add_land_item": "room_add_land_item",
  "list_land_queue": "room_list_land_queue",
  "remove_land_item": "room_remove_land_item",
  "report_tip": "room_report_land_tip",
});

test("rename registry: the documented snake_case-rename set is exactly the pinned contract", () => {
  assert.deepEqual({ ...MCP_TOOL_RENAMES }, { ...EXPECTED_RENAMES },
    "MCP_TOOL_RENAMES must match the documented rename contract exactly");
  for (const [oldName, canonical] of Object.entries(EXPECTED_RENAMES)) {
    assert.match(canonical, MCP_TOOL_NAME_RE, `rename target ${canonical} must be a legal tool name`);
    assert.ok(HOSTED_ROOM_MCP_TOOLS.includes(canonical), `rename ${oldName} must map to a hosted canonical tool`);
    assert.ok(!HOSTED_ROOM_MCP_TOOLS.includes(oldName), `rename ${oldName} must not stay canonical`);
    assert.equal(canonicalMcpToolName(oldName), canonical, `${oldName} must canonicalize on tools/call`);
  }
});

test("canonical registry: every hosted tool name is legal snake_case, no dotted names", () => {
  const defNames = hostedMcpToolDefs.map(entry => entry.name);
  assert.deepEqual([...defNames].sort(), [...HOSTED_ROOM_MCP_TOOLS].sort(),
    "hostedMcpToolDefs and HOSTED_ROOM_MCP_TOOLS must enumerate the same tools");
  for (const name of defNames) {
    assert.match(name, MCP_TOOL_NAME_RE, `${name} must be a legal snake_case tool name`);
    assert.ok(!name.includes("."), `${name} must not contain a dot`);
  }
  for (const entry of MCP_JOIN_TOOLS) {
    assert.match(entry.name, MCP_TOOL_NAME_RE, `join tool ${entry.name} must be legal snake_case`);
  }
});

test("alias registry: the documented dotted-alias set is exactly the pinned contract", () => {
  assert.deepEqual({ ...MCP_TOOL_ALIASES }, { ...EXPECTED_ALIASES },
    "MCP_TOOL_ALIASES must match the documented dotted-alias contract exactly");
  for (const [alias, canonical] of Object.entries(EXPECTED_ALIASES)) {
    assert.ok(!MCP_TOOL_NAME_RE.test(alias), `alias ${alias} must be the legacy dotted name, not snake_case`);
    assert.ok(alias.includes("."), `alias ${alias} must contain a dot`);
    assert.ok(HOSTED_ROOM_MCP_TOOLS.includes(canonical),
      `alias ${alias} must map to a hosted canonical tool (got ${canonical})`);
    assert.equal(canonicalMcpToolName(alias), canonical);
    assert.equal(mcpToolAlias(canonical), alias, "alias lookup must round-trip");
  }
  // canonicalMcpToolName is the identity on canonical names and unknown names.
  for (const name of HOSTED_ROOM_MCP_TOOLS) assert.equal(canonicalMcpToolName(name), name);
  assert.equal(canonicalMcpToolName("room.create"), "room.create", "undocumented names pass through untouched");
  // No two dotted names share a canonical tool.
  assert.equal(new Set(Object.values(EXPECTED_ALIASES)).size, Object.keys(EXPECTED_ALIASES).length,
    "aliases must be a bijection");
});

test("documented dotted aliases call through and behave identically to canonical", async t => {
  const { origin, secret } = await serve(t);
  // heartbeat.get / webhook.list are identity-scoped reads with no side effects:
  // the dotted call must return byte-identical results to the canonical call.
  for (const [alias, canonical] of [["heartbeat.get", "heartbeat_get"], ["webhook.list", "webhook_list"]]) {
    const viaAlias = await call(origin, alias, {}, secret);
    const viaCanonical = await call(origin, canonical, {}, secret);
    assert.ok(!viaAlias.body.error, `${alias} must not error: ${JSON.stringify(viaAlias.body.error)}`);
    assert.ok(!viaCanonical.body.error, `${canonical} must not error`);
    assert.deepEqual(viaAlias.body.result, viaCanonical.body.result,
      `${alias} must behave identically to ${canonical}`);
  }
  // Every other documented alias must at least route: with empty args the
  // canonical tool's own argument validation runs (invalid_arguments), never
  // unknown_tool. Arg validation precedes execution, so no side effects occur.
  for (const [alias, canonical] of Object.entries(EXPECTED_ALIASES)) {
    if (alias === "heartbeat.get" || alias === "webhook.list") continue;
    const { body } = await call(origin, alias, {}, secret);
    assert.ok(!body.error || body.error.message !== "unknown_tool",
      `${alias} must resolve to ${canonical}, got: ${JSON.stringify(body.error)}`);
  }
});

test("undocumented dotted names 404 as unknown_tool with a helpful hint", async t => {
  const { origin, secret } = await serve(t);
  // Dotted forms of real tools that have NO documented alias.
  const undocumented = ["room.create", "room.join", "room.post_message", "get.room_context",
    "room.list_work", "room.check_access", "add.land_item", "list.land_queue", "bond.propose.x"];
  for (const name of undocumented) {
    assert.ok(!(name in MCP_TOOL_ALIASES), `${name} must stay undocumented for this check`);
    const { body } = await call(origin, name, {}, secret);
    assert.ok(body.error, `${name} must fail, not reach a tool`);
    assert.equal(body.error.code, -32602, name);
    assert.equal(body.error.message, "unknown_tool", name);
    assert.equal(body.error.data.reason, "unknown_tool", name);
    assert.equal(body.error.data.tool, name, "the error must echo the called name");
    assert.ok(typeof body.error.data.hint === "string" && body.error.data.hint.includes("tools/list"),
      `${name} hint must point at tools/list: ${body.error.data.hint}`);
    assert.ok(Array.isArray(body.error.data.next) && body.error.data.next.length > 0,
      `${name} must carry machine-readable next actions`);
  }
  // Near-miss: room.create suggests room_create.
  const { body } = await call(origin, "room.create", {}, secret);
  assert.equal(body.error.data.suggestion, "room_create");
  assert.match(body.error.data.hint, /Did you mean "room_create"\?/);
  // Far-miss: room.post is not a near-miss of any tool, so no bogus suggestion.
  const far = await call(origin, "room.post", {}, secret);
  assert.equal(far.body.error.message, "unknown_tool");
  assert.equal(far.body.error.data.suggestion, null);
  assert.match(far.body.error.data.hint, /No tool has a name close to that/);
});

test("no tool is reachable under a malformed or undocumented name", async t => {
  const { origin, secret } = await serve(t);
  const hostile = ["room..create", ".room_create", "room_create.", "ROOM_CREATE", "Room_Create",
    "room-create", "bondpropose", "bond. propose", "bond .propose", "", " ", "room.create ",
    "heartbeat..get", "webhook. list", "room_post_message ", "null", "undefined"];
  for (const name of hostile) {
    const { body } = await call(origin, name, {}, secret);
    assert.ok(body.error, `${JSON.stringify(name)} must not reach a tool`);
    assert.equal(body.error.message, "unknown_tool", JSON.stringify(name));
    assert.equal(body.error.data.reason, "unknown_tool", JSON.stringify(name));
  }
});

test("tools/list hides dotted aliases by default and reveals them with aliases=1", async t => {
  const { origin, secret } = await serve(t);
  const full = await list(origin, { profile: "full" }, secret);
  const listedNames = full.map(tool => tool.name);
  assert.ok(listedNames.every(name => !name.includes(".")), "default list must contain no dotted tool names");
  assert.ok(listedNames.every(name => MCP_TOOL_NAME_RE.test(name)), "default list must be snake_case only");
  assert.ok(full.every(tool => !("aliases" in tool)), "default list must not leak aliases metadata");

  const withAliases = await list(origin, { profile: "full", aliases: 1 }, secret);
  assert.ok(withAliases.every(tool => !tool.name.includes(".")),
    "even with aliases=1, tool entries keep canonical names");
  const aliasEntries = withAliases.filter(tool => "aliases" in tool);
  assert.ok(aliasEntries.length > 0, "aliases=1 must surface the documented aliases");
  for (const tool of aliasEntries) {
    assert.deepEqual(tool.aliases, mcpToolAliases(tool.name),
      `${tool.name} must advertise exactly its documented legacy names`);
    assert.ok(tool.aliases.every(a => a.includes(".") || Object.hasOwn(EXPECTED_RENAMES, a)),
      "advertised legacy names must be dotted aliases or documented renames");
  }
  const aliasedCanonicals = new Set([...Object.values(EXPECTED_ALIASES), ...Object.values(EXPECTED_RENAMES)]);
  assert.deepEqual(new Set(aliasEntries.map(tool => tool.name)), aliasedCanonicals,
    "exactly the documented alias and rename targets may advertise legacy names");

  // ?aliases=1 query form behaves the same.
  const viaQuery = await list(origin, { profile: "full" }, secret, "?aliases=1");
  assert.deepEqual(
    viaQuery.filter(tool => "aliases" in tool).map(tool => tool.name).sort(),
    aliasEntries.map(tool => tool.name).sort());
});
