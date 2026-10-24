// TD-0: MCP per-tool call telemetry.
//
// Contracts guarded:
//  - every hosted tools/call + tools/list lands in the daily rollup by
//    invoked name, caller class and outcome — counts and metadata only,
//    no argument payloads, no identity ids (bright lines B2/B9);
//  - caller classes: anonymous / api_key / fleet_identity (configured via
//    ANALYTICS_LANE_ACTOR_IDS, never guessed) / guest / external_identity;
//  - a telemetry failure never fails a tool call;
//  - the diet programme's read side: window counts by caller class,
//    days-since-last-call, list profile mix, non-fleet legacy-name count;
//  - retention is bounded (400-day prune); a canary call to a
//    zero-traffic tool shows up in the report.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { dispatchRoomMcp } from "../server/mcp-http.mjs";
import {
  MCP_TELEMETRY_RETENTION_DAYS, classifyMcpCaller, isGuestOnlyIdentity,
  mcpReplyOutcome, mcpToolUsageReport, pruneMcpTelemetry, recordMcpTelemetry
} from "../server/analytics/mcp-telemetry.mjs";
import { serveRoomMcp } from "../client/mcp-stdio.mjs";
import { openMcpTelemetrySink, stdioCallerClass } from "../client/mcp-telemetry.mjs";

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0); // 2026-10-18 12:00 UTC

test("caller classification: anonymous, api key, fleet (configured only), guest, external", () => {
  assert.equal(classifyMcpCaller({}), "anonymous");
  assert.equal(classifyMcpCaller({ secret: "" }), "anonymous");
  assert.equal(classifyMcpCaller({ secret: "rak_abc123" }), "api_key");
  assert.equal(classifyMcpCaller({ secret: "pri_someone", identityId: "ai_one" }), "external_identity");
  assert.equal(classifyMcpCaller({ secret: "pri_someone", identityId: "ai_one", guestOnly: true }), "guest");
  const env = { ANALYTICS_LANE_ACTOR_IDS: "ai_lane1, ai_lane2" };
  assert.equal(classifyMcpCaller({ secret: "pri_someone", identityId: "ai_lane2", env }), "fleet_identity");
  // Fleet membership wins over guest, and an unconfigured id is never fleet.
  assert.equal(classifyMcpCaller({ secret: "pri_someone", identityId: "ai_lane1", guestOnly: true, env }), "fleet_identity");
  assert.equal(classifyMcpCaller({ secret: "pri_someone", identityId: "ai_lane1", env: {} }), "external_identity");
});

test("guest-only seat detection reads link vs guest seats", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE identity_links (room_id TEXT NOT NULL, identity_id TEXT NOT NULL, member_id TEXT NOT NULL, linked_at INTEGER NOT NULL);
    CREATE TABLE guest_members (member_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, guest_identity_id TEXT NOT NULL, tier TEXT NOT NULL, invite_id TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO identity_links VALUES ('room-a', 'id-linked', 'mem-linked', 1);
    INSERT INTO guest_members VALUES ('mem-guest', 'room-a', 'id-guest', 'contributor', 'inv-1', 1);
    INSERT INTO guest_members VALUES ('mem-both', 'room-a', 'id-mixed', 'observer', 'inv-2', 1);
    INSERT INTO identity_links VALUES ('room-b', 'id-mixed', 'mem-both-b', 1);
  `);
  assert.equal(isGuestOnlyIdentity(db, "id-guest"), true);
  assert.equal(isGuestOnlyIdentity(db, "id-linked"), false);
  assert.equal(isGuestOnlyIdentity(db, "id-mixed"), false);
  assert.equal(isGuestOnlyIdentity(db, "id-unknown"), false);
  db.close();
});

test("rollup aggregates by day, tool, caller class and outcome; report splits them back out", () => {
  const db = new DatabaseSync(":memory:");
  const base = { surface: "hosted", callerClass: "external_identity" };
  assert.equal(recordMcpTelemetry(db, { ...base, tool: "room_say", outcome: "success", at: NOW }), true);
  assert.equal(recordMcpTelemetry(db, { ...base, tool: "room_say", outcome: "success", at: NOW + 1000 }), true);
  assert.equal(recordMcpTelemetry(db, { ...base, tool: "room_say", outcome: "error", at: NOW + 2000 }), true);
  assert.equal(recordMcpTelemetry(db, { ...base, tool: "room_say", outcome: "success", at: NOW - DAY }), true);
  assert.equal(recordMcpTelemetry(db, { surface: "hosted", tool: "room_say", callerClass: "fleet_identity", outcome: "success", at: NOW }), true);
  // Canary: a tool with zero prior traffic appears after exactly one call.
  assert.equal(recordMcpTelemetry(db, { surface: "stdio", tool: "room_read_attention", callerClass: "external_identity", outcome: "success", at: NOW }), true);
  assert.equal(recordMcpTelemetry(db, { surface: "hosted", kind: "list", profile: "lean", focus: "work", callerClass: "external_identity", outcome: "success", at: NOW }), true);

  const rows = db.prepare("SELECT * FROM mcp_tool_daily ORDER BY tool_name, caller_class").all();
  assert.equal(rows.length, 6); // today+yesterday success rows stay separate per day
  // The table shape is metadata only — this column list IS the B2/B9 guard.
  assert.deepEqual(db.prepare("PRAGMA table_info(mcp_tool_daily)").all().map(column => column.name),
    ["day", "surface", "kind", "tool_name", "profile", "focus", "caller_class", "outcome", "calls", "first_at", "last_at"]);

  const report = mcpToolUsageReport(db, { days: 1, now: NOW + 3000 });
  const say = report.calls.filter(row => row.tool === "room_say");
  assert.deepEqual(say.map(row => [row.callerClass, row.calls, row.successes, row.errors]), [
    ["external_identity", 3, 2, 1],
    ["fleet_identity", 1, 1, 0]
  ]);
  const canary = report.calls.find(row => row.tool === "room_read_attention");
  assert.equal(canary.calls, 1);
  assert.equal(canary.surface, "stdio");
  assert.deepEqual(report.listRequests.map(row => [row.profile, row.focus, row.requests]), [["lean", "work", 1]]);

  const week = mcpToolUsageReport(db, { days: 7, now: NOW + 3 * DAY });
  const lastSeen = Object.fromEntries(week.lastSeen.map(row => [row.tool, row.daysSinceLastCall]));
  assert.equal(lastSeen.room_say, 2); // last call was NOW+2s, report at NOW+3d
  assert.equal(lastSeen.room_read_attention, 3);
  db.close();
});

test("non-fleet legacy-name count is the programme kill criterion input", () => {
  const db = new DatabaseSync(":memory:");
  for (const [tool, callerClass] of [["room_say", "external_identity"], ["room_say", "fleet_identity"],
    ["say", "external_identity"], ["work", "api_key"], ["room_needs_me", "anonymous"]]) {
    recordMcpTelemetry(db, { surface: "hosted", tool, callerClass, outcome: "success", at: NOW });
  }
  const report = mcpToolUsageReport(db, { days: 7, now: NOW, legacyNames: ["room_say", "say", "work", "room_board"] });
  // say + work are legacy and non-fleet; room_say's fleet use does not count
  // it twice, and its external use still counts the name once.
  assert.equal(report.nonFleetLegacy.distinctNames, 3);
  assert.deepEqual(report.nonFleetLegacy.names, ["room_say", "say", "work"]);
  assert.equal(mcpToolUsageReport(db, { days: 7, now: NOW }).nonFleetLegacy, null);
  db.close();
});

test("recording never throws and refuses malformed events", () => {
  assert.equal(recordMcpTelemetry(null, { surface: "hosted", callerClass: "anonymous", outcome: "success" }), false);
  assert.equal(recordMcpTelemetry({ prepare() { throw new Error("db down"); } },
    { surface: "hosted", callerClass: "anonymous", outcome: "success" }), false);
  const db = new DatabaseSync(":memory:");
  assert.equal(recordMcpTelemetry(db, { surface: "carrier-pigeon", callerClass: "anonymous", outcome: "success" }), false);
  assert.equal(recordMcpTelemetry(db, { surface: "hosted", callerClass: "the-ceo", outcome: "success" }), false);
  assert.equal(recordMcpTelemetry(db, { surface: "hosted", callerClass: "anonymous", outcome: "shrug" }), false);
  // A hostile tool name is dropped to empty rather than stored.
  assert.equal(recordMcpTelemetry(db, { surface: "hosted", tool: "x'); DROP TABLE rooms;--", callerClass: "anonymous", outcome: "success", at: NOW }), true);
  assert.equal(db.prepare("SELECT tool_name FROM mcp_tool_daily").get().tool_name, "");
  // Report on a store with no telemetry table is an empty report, not a throw.
  const bare = new DatabaseSync(":memory:");
  assert.deepEqual(mcpToolUsageReport(bare, { now: NOW }).calls, []);
  db.close(); bare.close();
});

test("retention prune expires rows past the window", () => {
  const db = new DatabaseSync(":memory:");
  recordMcpTelemetry(db, { surface: "hosted", tool: "room_old", callerClass: "anonymous", outcome: "success", at: NOW - (MCP_TELEMETRY_RETENTION_DAYS + 1) * DAY });
  recordMcpTelemetry(db, { surface: "hosted", tool: "room_new", callerClass: "anonymous", outcome: "success", at: NOW });
  // The write at NOW already pruned opportunistically; an explicit prune is
  // a no-op afterwards.
  assert.equal(pruneMcpTelemetry(db, { now: NOW }), 0);
  assert.deepEqual(db.prepare("SELECT tool_name FROM mcp_tool_daily ORDER BY tool_name").all().map(row => row.tool_name), ["room_new"]);
  db.close();
});

function hostedSetup(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-telemetry-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store, { rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }) });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, hosted: createHostedRoomMcp(store, { agentRooms: rooms }) };
}
const rpc = (method, params) => ({ jsonrpc: "2.0", id: "t", method, ...(params === undefined ? {} : { params }) });
const telemetryRows = db => db.prepare("SELECT kind, tool_name, profile, focus, caller_class, outcome, calls FROM mcp_tool_daily ORDER BY rowid").all().map(row => ({ ...row }));

test("hosted profile counts list + call by caller class, including failures", async t => {
  const { store, hosted } = hostedSetup(t);
  const identity = store.identities.create("Telemetry agent");
  const auth = `Bearer ${identity.secret}`;

  const list = await hosted(rpc("tools/list"), { authorization: auth });
  assert.equal(list.error, undefined);
  const call = await hosted(rpc("tools/call", { name: "room_check_access", arguments: {} }), { authorization: auth });
  assert.equal(mcpReplyOutcome(call), "success", JSON.stringify(call).slice(0, 200));
  const unknown = await hosted(rpc("tools/call", { name: "room_no_such_tool", arguments: {} }), { authorization: auth });
  assert.equal(mcpReplyOutcome(unknown), "error");
  const rejected = await hosted(rpc("tools/call", { name: "room_check_access", arguments: {} }), { authorization: "Bearer pri_forged" });
  assert.equal(rejected.error?.code, -32001);

  assert.deepEqual(telemetryRows(store.db), [
    { kind: "list", tool_name: "", profile: "core", focus: "", caller_class: "external_identity", outcome: "success", calls: 1 },
    { kind: "call", tool_name: "room_check_access", profile: "", focus: "", caller_class: "external_identity", outcome: "success", calls: 1 },
    { kind: "call", tool_name: "room_no_such_tool", profile: "", focus: "", caller_class: "external_identity", outcome: "error", calls: 1 },
    { kind: "call", tool_name: "room_check_access", profile: "", focus: "", caller_class: "external_identity", outcome: "error", calls: 1 }
  ]);
});

test("hosted profile classifies fleet identities from the configured lane set only", async t => {
  const { store, hosted } = hostedSetup(t);
  const identity = store.identities.create("Lane agent");
  const auth = `Bearer ${identity.secret}`;
  await hosted(rpc("tools/call", { name: "room_check_access", arguments: {} }), { authorization: auth });
  process.env.ANALYTICS_LANE_ACTOR_IDS = identity.identityId;
  try {
    await hosted(rpc("tools/call", { name: "room_check_access", arguments: {} }), { authorization: auth });
  } finally { delete process.env.ANALYTICS_LANE_ACTOR_IDS; }
  assert.deepEqual(telemetryRows(store.db).map(row => row.caller_class), ["external_identity", "fleet_identity"]);
});

test("identity mint counts as an anonymous call to room_identity_mint", async t => {
  const { store, hosted } = hostedSetup(t);
  const reply = await hosted(rpc("tools/call", { name: "room_identity_mint", arguments: { displayName: "Telemetry Mint" } }), {});
  assert.equal(mcpReplyOutcome(reply), "success", JSON.stringify(reply).slice(0, 200));
  assert.deepEqual(telemetryRows(store.db), [
    { kind: "call", tool_name: "room_identity_mint", profile: "", focus: "", caller_class: "anonymous", outcome: "success", calls: 1 }
  ]);
});

test("dispatch counts the anonymous join surface itself and never double-counts delegation", async () => {
  const events = [];
  const telemetry = event => events.push(event);
  const list = await dispatchRoomMcp(rpc("tools/list"), { mcpUrl: "https://room.example/mcp", telemetry });
  assert.ok(list.result?.tools?.length > 0);
  const call = await dispatchRoomMcp(rpc("tools/call", { name: "room_join_packet", arguments: {} }), { mcpUrl: "https://room.example/mcp", telemetry });
  assert.equal(mcpReplyOutcome(call), "success", JSON.stringify(call).slice(0, 200));
  assert.deepEqual(events, [
    { kind: "list", profile: "public", callerClass: "anonymous", outcome: "success" },
    { tool: "room_join_packet", callerClass: "anonymous", outcome: "success" }
  ]);
  // With a credential, dispatch delegates and stays silent: the hosted
  // profile wrapper is the single count point for authed traffic.
  events.length = 0;
  await dispatchRoomMcp(rpc("tools/call", { name: "room_say", arguments: {} }),
    { mcpUrl: "https://room.example/mcp", authorization: "Bearer pri_x", roomMcp: async () => ({ jsonrpc: "2.0", id: "t", result: {} }), telemetry });
  assert.deepEqual(events, []);
});

test("stdio adapter counts list + call + unknown tool through its sink", async t => {
  const events = [];
  const input = new PassThrough(), output = new PassThrough();
  const server = serveRoomMcp({
    client: { checkConnection: async () => ({ access: "ok" }) },
    roomId: "commons", memberId: "agent", input, output,
    telemetry: event => events.push(event), callerClass: "fleet_identity"
  });
  t.after(() => { server.stop(); input.destroy(); output.destroy(); });
  let buffer = "", next = 0; const pending = new Map();
  output.on("data", chunk => { buffer += chunk; let end; while ((end = buffer.indexOf("\n")) >= 0) {
    const reply = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    pending.get(reply.id)?.(reply); pending.delete(reply.id);
  } });
  const rpcStdio = (method, params = {}) => new Promise(resolve => { const id = ++next; pending.set(id, resolve);
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  await rpcStdio("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await rpcStdio("tools/list");
  const ok = await rpcStdio("tools/call", { name: "room_check_access", arguments: {} });
  assert.equal(ok.result?.isError, undefined, JSON.stringify(ok).slice(0, 200));
  const bad = await rpcStdio("tools/call", { name: "room_nope", arguments: {} });
  assert.equal(bad.error?.code, -32602);
  assert.deepEqual(events, [
    { callerClass: "fleet_identity", kind: "list", profile: "stdio", outcome: "success" },
    { callerClass: "fleet_identity", tool: "room_check_access", outcome: "success" },
    { callerClass: "fleet_identity", tool: "room_nope", outcome: "error" }
  ]);
});

test("stdio sink writes the same queryable table; a broken sink path is simply absent", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-telemetry-sink-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sink = openMcpTelemetrySink(join(directory, "telemetry.sqlite"));
  assert.ok(sink);
  assert.equal(sink.record({ tool: "room_say", callerClass: "external_identity", outcome: "success" }), true);
  sink.close();
  const db = new DatabaseSync(join(directory, "telemetry.sqlite"), { readOnly: true });
  const report = mcpToolUsageReport(db, { days: 7 });
  assert.equal(report.calls.find(row => row.tool === "room_say")?.calls, 1);
  assert.equal(report.calls[0].surface, "stdio");
  db.close();
  assert.equal(openMcpTelemetrySink(join(directory, "missing-dir", "x.sqlite")), null);
  assert.equal(stdioCallerClass("rak_key"), "api_key");
  assert.equal(stdioCallerClass("pri_identity"), "external_identity");
  assert.equal(stdioCallerClass("pri_identity", "fleet_identity"), "fleet_identity");
  assert.equal(stdioCallerClass("pri_identity", "bogus"), "external_identity");
});
