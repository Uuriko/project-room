// MCP route regression: scope pins — hard task 94.
//
// Locks in the MCP tool surface so a scope widening or an unregistered tool
// fails loudly. For every served tool the suite pins the exact listing
// surfaces it appears on (public / core / full / enrolled / focus:*) and
// whether it is withheld from guest and t1_readonly agent catalogs. The
// checked-in tests/mcp-scope-snapshot.json is the contract: changing a
// tool's surface membership is a deliberate, reviewable act, never a silent
// catalog edit. Companion: tests/mcp-tools-reconciliation.test.js pins the
// catalog <-> profile <-> handler reconciliation.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { listedMcpTools, livePublicMcpTools, liveEnrolledMcpTools } from "../server/mcp-discovery.mjs";
import { capabilityVisibleTo } from "../server/capability-visibility.mjs";

const require = createRequire(import.meta.url);
const SNAPSHOT = require("./mcp-scope-snapshot.json");

const FOCUSES = ["work", "conversation", "review", "automation", "public_work"];

// The two restricted catalog views whose withholding must never silently shrink.
const guestAgent = { kind: "agent", identityId: "ai_guest", grants: [],
  memberships: [{ roomId: "r", memberId: "guest-agent-x", isGuest: true, autonomyTier: "t2_standard", isOwner: false, active: true }] };
const t1Agent = { kind: "agent", identityId: "ai_t1", grants: [],
  memberships: [{ roomId: "r", memberId: "ai_t1", isGuest: false, autonomyTier: "t1_readonly", isOwner: false, active: true }] };

function liveSnapshot() {
  const surfaces = {
    public: livePublicMcpTools(),
    core: listedMcpTools("core"),
    full: listedMcpTools("full"),
    enrolled: liveEnrolledMcpTools(),
  };
  for (const focus of FOCUSES) surfaces[`focus:${focus}`] = listedMcpTools("core", false, null, focus);
  const defs = {}, map = {};
  for (const [surface, tools] of Object.entries(surfaces)) {
    for (const tool of tools) {
      defs[tool.name] ??= tool;
      (map[tool.name] ??= []);
      if (!map[tool.name].includes(surface)) map[tool.name].push(surface);
    }
  }
  const snap = {};
  for (const name of Object.keys(map).sort()) {
    snap[name] = {
      surfaces: map[name].sort(),
      guestHidden: !capabilityVisibleTo(guestAgent, defs[name]),
      t1Hidden: !capabilityVisibleTo(t1Agent, defs[name]),
    };
  }
  return snap;
}

test("the MCP tool scope snapshot is exact: no tool's scope may widen or shrink silently", () => {
  const live = liveSnapshot();
  const liveNames = Object.keys(live), snapNames = Object.keys(SNAPSHOT);
  const added = liveNames.filter(n => !Object.hasOwn(SNAPSHOT, n));
  const removed = snapNames.filter(n => !Object.hasOwn(live, n));
  assert.deepEqual(added, [], `NEW tools appeared unregistered — review and add to tests/mcp-scope-snapshot.json: ${added.join(", ")}`);
  assert.deepEqual(removed, [], `tools vanished from the catalog: ${removed.join(", ")}`);
  const drifted = [];
  for (const name of liveNames) {
    const want = JSON.stringify(SNAPSHOT[name]), got = JSON.stringify(live[name]);
    if (want !== got) drifted.push(`${name}: snapshot=${want} live=${got}`);
  }
  assert.deepEqual(drifted, [],
    `tool scope drift — a tool's listing surfaces or catalog withholding changed. ` +
    `If this widening is intentional, update tests/mcp-scope-snapshot.json in the same PR:\n${drifted.join("\n")}`);
});

test("a guest and a t1_readonly agent never see write tools they cannot call", () => {
  const live = liveSnapshot();
  // Spot-check the contract shape: write tools stay withheld from restricted
  // catalogs (withheld, never refused), reads stay visible.
  const guestHidden = Object.entries(live).filter(([, v]) => v.guestHidden).map(([n]) => n);
  const t1Hidden = Object.entries(live).filter(([, v]) => v.t1Hidden).map(([n]) => n);
  assert.ok(guestHidden.length > 0, "guest agents have tools withheld from their catalog");
  assert.ok(t1Hidden.length > 0, "t1_readonly agents have tools withheld from their catalog");
  // Guests may chat (room_post_message, room_react) but nothing else that writes;
  // t1_readonly agents may not write at all.
  for (const name of ["room_begin_work", "room_create_agent_invite"]) {
    assert.ok(guestHidden.includes(name), `${name} stays withheld from guest catalogs`);
    assert.ok(t1Hidden.includes(name), `${name} stays withheld from t1 catalogs`);
  }
  for (const name of ["room_post_message", "room_react"]) {
    assert.ok(!guestHidden.includes(name), `guests keep ${name} (chat)`);
    assert.ok(t1Hidden.includes(name), `${name} stays withheld from t1 catalogs`);
  }
  for (const name of ["room_read_inbox", "room_check_access", "room_read_messages"]) {
    assert.ok(!guestHidden.includes(name), `${name} stays visible to guests`);
    assert.ok(!t1Hidden.includes(name), `${name} stays visible to t1 agents`);
  }
});

test("identity-secret access check: unauthenticated tools/call on a room tool is 401", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-scope-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (name, secret) => fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: "scope", method: "tools/call", params: { name, arguments: {} } }),
  }).then(async res => ({ status: res.status, body: await res.json() }));
  // A room write tool without any credential: auth required, never a silent allow.
  const anon = await call("room_post_message");
  assert.equal(anon.status, 401, "unauthenticated call is 401");
  assert.equal(anon.body.error.code, -32001, "MCP_AUTH_REQUIRED");
  // A forged identity secret: same refusal, no tool executed.
  const forged = await call("room_post_message", "pri_" + "z".repeat(43));
  assert.equal(forged.status, 401, "forged identity secret is 401");
  assert.equal(forged.body.error.code, -32001);
});
