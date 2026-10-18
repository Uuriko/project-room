// MCP front door: opt-in lean profile, room_search_actions and room_run_action.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { listedMcpTools } from "../server/mcp-discovery.mjs";
import { LEAN_MCP_TOOLS, searchActions, isRunnableAction } from "../server/mcp-action-search.mjs";
import { hostedMcpToolDefs } from "../server/mcp-hosted-tools.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-search-"));
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

async function rpc(origin, method, params, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method, params })
  });
  return response.json();
}

async function member(t) {
  const env = await serve(t);
  const ada = env.store.identities.create("Ada");
  env.rooms.create(ada.secret, { roomId: "ada-den", title: "Ada den", purpose: "Search actions", kind: "personal", displayName: "Ada" });
  return { ...env, secret: ada.secret };
}

// operationId is minted per call; everything else must match.
const stable = body => JSON.parse(JSON.stringify(body, (key, value) => key === "operationId" ? undefined : value));
const size = tools => JSON.stringify(tools).length;

test("lean is the default: core and full are unchanged and one explicit profile away", () => {
  const core = listedMcpTools("core"), full = listedMcpTools("full"), lean = listedMcpTools("lean");
  assert.deepEqual(listedMcpTools(), lean, "listedMcpTools with no profile serves lean");
  assert.equal(core.length, 22, "core is unchanged");
  assert.equal(full.length, 117, "full is unchanged");
  assert.ok(!core.some(tool => tool.name === "room_search_actions"), "meta tools are not added to core");
  const names = lean.map(tool => tool.name);
  for (const name of LEAN_MCP_TOOLS) assert.ok(names.includes(name), `lean lists ${name}`);
  assert.ok(lean.every(Boolean) && names.every(name => typeof name === "string"));
  assert.ok(size(lean) < size(core) * 0.75, `lean ${size(lean)} B should be well under core ${size(core)} B`);
});

test("every lean name is a real definition or join tool", () => {
  for (const tool of listedMcpTools("lean")) assert.ok(tool.inputSchema && tool.description, tool.name);
});

test("search detail levels: name only, name+description by default, full schema on request", () => {
  const close = searchActions("close board claim", { detail: "full" });
  assert.equal(close.matches[0].name, "room_close_work_claim");
  const def = hostedMcpToolDefs.find(tool => tool.name === "room_close_work_claim");
  assert.deepEqual(close.matches[0].inputSchema, def.inputSchema);
  const land = searchActions("land queue remove", { limit: 3 });
  assert.ok(land.matches.some(match => match.name === "remove_land_item"));
  assert.ok(land.matches.length <= 3);
  const withRest = searchActions("squads list").matches.find(match => match.name === "squads_list");
  assert.match(withRest.rest, /^GET \/api\/rooms\/:roomId\/squads/);
  assert.deepEqual(searchActions("zzzz qqqq").matches, []);

  // Default detail is summary: names + one-line descriptions, no schemas.
  const summary = searchActions("close board claim");
  assert.equal(summary.detail, "summary");
  assert.ok(summary.matches.every(match => match.inputSchema === undefined && typeof match.summary === "string"));
  // Names only is the floor.
  const names = searchActions("close board claim", { detail: "name" });
  assert.deepEqual(Object.keys(names.matches[0]), ["name"]);
  // The slimming that pays: the old always-schema shape cost 12,588 B on
  // the wire for this query (measured on main 4612f3659); the default
  // structured answer is now a small fraction of it.
  assert.ok(size(summary) < 2000, `default search answer is ${size(summary)} B`);
  assert.ok(size(names) < size(summary) && size(summary) < size(close));
});

test("run_action refuses itself, search, join and public-work tools, and unknown names", () => {
  for (const name of ["room_run_action", "room_search_actions", "room_join_packet", "public_work_claim", "nope"]) {
    assert.equal(isRunnableAction(name), false, name);
  }
  assert.equal(isRunnableAction("squads_list"), true);
});

test("over MCP: lean list, search, then run a long-tail action with the same result as a direct call", async t => {
  const { origin, secret } = await member(t);
  const listed = await rpc(origin, "tools/list", { profile: "lean" }, secret);
  assert.equal(listed.result.profile, "lean");
  assert.ok(listed.result.tools.some(tool => tool.name === "room_search_actions"));

  const found = await rpc(origin, "tools/call", { name: "room_search_actions", arguments: { query: "list squads" } }, secret);
  assert.equal(found.result.isError, undefined);
  assert.ok(found.result.structuredContent.matches.some(match => match.name === "squads_list"));

  const direct = await rpc(origin, "tools/call", { name: "squads_list", arguments: { roomId: "ada-den" } }, secret);
  const viaRun = await rpc(origin, "tools/call", { name: "room_run_action", arguments: { name: "squads_list", arguments: { roomId: "ada-den" } } }, secret);
  assert.deepEqual(stable(viaRun.result), stable(direct.result), "run_action returns exactly what the direct call returns");

  // Argument checks still apply inside run_action.
  const badInner = await rpc(origin, "tools/call", { name: "room_run_action", arguments: { name: "squads_list", arguments: { roomId: "ada-den", bogus: 1 } } }, secret);
  const badDirect = await rpc(origin, "tools/call", { name: "squads_list", arguments: { roomId: "ada-den", bogus: 1 } }, secret);
  assert.deepEqual(stable(badInner), stable(badDirect));

  // Room access is still checked: a room this identity is not in.
  const foreign = await rpc(origin, "tools/call", { name: "room_run_action", arguments: { name: "squads_list", arguments: { roomId: "not-my-room" } } }, secret);
  const foreignDirect = await rpc(origin, "tools/call", { name: "squads_list", arguments: { roomId: "not-my-room" } }, secret);
  assert.deepEqual(stable(foreign), stable(foreignDirect));

  const recursion = await rpc(origin, "tools/call", { name: "room_run_action", arguments: { name: "room_run_action", arguments: {} } }, secret);
  assert.ok(recursion.error || recursion.result?.isError, "run_action cannot call itself");

  const badSearch = await rpc(origin, "tools/call", { name: "room_search_actions", arguments: { query: "" } }, secret);
  assert.ok(badSearch.error || badSearch.result?.isError, "empty query is refused");

  const badProfile = await rpc(origin, "tools/list", { profile: "tiny" }, secret);
  assert.ok(badProfile.error || badProfile.result?.isError);
});

test("over MCP: search text never duplicates a schema, and detail is validated", async t => {
  const { origin, secret } = await member(t);
  const full = await rpc(origin, "tools/call", { name: "room_search_actions", arguments: { query: "close board claim", detail: "full" } }, secret);
  assert.ok(full.result.structuredContent.matches[0].inputSchema, "full detail carries the schema in structuredContent");
  assert.ok(!full.result.content[0].text.includes(JSON.stringify(full.result.structuredContent.matches[0].inputSchema)), "text block must not repeat the schema JSON");
  assert.ok(!full.result.content[0].text.includes('"inputSchema":'), "text block must not repeat the schema");
  assert.ok(!full.result.content[0].text.includes('"properties"'), "text block must not repeat the schema");
  const slim = await rpc(origin, "tools/call", { name: "room_search_actions", arguments: { query: "close board claim" } }, secret);
  assert.equal(slim.result.structuredContent.detail, "summary");
  assert.ok(slim.result.structuredContent.matches.every(match => match.inputSchema === undefined));
  const badDetail = await rpc(origin, "tools/call", { name: "room_search_actions", arguments: { query: "squads", detail: "everything" } }, secret);
  assert.ok(badDetail.error || badDetail.result?.isError, "unknown detail level is refused");
});

test("rev-skip: initialize, needs-me and tools/list agree on rev + digest, and a matching list call answers not_modified", async t => {
  const { origin, secret } = await member(t);
  const init = await rpc(origin, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "rev-skip-test", version: "1" }
  }, secret);
  const catalog = init.result._meta.catalog;
  assert.ok(catalog.deployedRev && catalog.catalogDigest, "initialize exposes rev + digest");
  assert.equal(catalog.defaultProfile, "lean");
  assert.match(catalog.skipContract, /skip the fetch/);

  const needsMe = await rpc(origin, "tools/call", { name: "room_needs_me", arguments: {} }, secret);
  assert.equal(needsMe.result.structuredContent.catalog.deployedRev, catalog.deployedRev);
  assert.equal(needsMe.result.structuredContent.catalog.catalogDigest, catalog.catalogDigest);

  // Default list is lean now, and its _meta stamps the digest to store.
  const listed = await rpc(origin, "tools/list", {}, secret);
  assert.equal(listed.result.profile, "lean");
  assert.equal(listed.result._meta.catalog.catalogDigest, catalog.tiers.lean.digest);

  const skipsBefore = listed.result._meta.catalog && catalog.skipStats ? catalog.skipStats.skips : 0;
  const skipped = await rpc(origin, "tools/list", { since_rev: catalog.deployedRev, since_digest: catalog.tiers.lean.digest }, secret);
  assert.equal(skipped.result.not_modified, true);
  assert.equal(skipped.result.tools, undefined, "a skip answers no catalog body");
  assert.ok(skipped.result.catalog.skipStats.skips > skipsBefore, "the skip is counted for later skip-rate measurement");

  // A stale digest gets the real list, never a false not_modified.
  const stale = await rpc(origin, "tools/list", { since_rev: catalog.deployedRev, since_digest: "0".repeat(64) }, secret);
  assert.ok(Array.isArray(stale.result.tools), "stale digest re-lists");
  // Core and full stay one explicit call away.
  for (const profile of ["core", "full"]) {
    const res = await rpc(origin, "tools/list", { profile }, secret);
    assert.equal(res.result.profile, profile);
    assert.ok(res.result.tools.length > listed.result.tools.length);
  }
});

test("meta tools need an identity: anonymous calls are refused", async t => {
  const { origin } = await serve(t);
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name: "room_search_actions", arguments: { query: "squads" } } })
  });
  const body = await response.json();
  assert.ok(body.error || body.result?.isError, "no anonymous search");
});
