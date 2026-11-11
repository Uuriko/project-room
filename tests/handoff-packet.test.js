import test from "node:test";
import assert from "node:assert/strict";
import { buildHandoffPacket, collectDecisions, handoffPacketEnabled } from "../server/handoff-packet.mjs";

test("flag is off by default and accepts 1/true/on", () => {
  assert.equal(handoffPacketEnabled({}), false);
  assert.equal(handoffPacketEnabled({ ROOM_HANDOFF_PACKET: "0" }), false);
  for (const v of ["1", "true", "ON"]) assert.equal(handoffPacketEnabled({ ROOM_HANDOFF_PACKET: v }), true);
});

test("collectDecisions pages, keeps the newest, and reports truncation", () => {
  const pages = [
    { events: [{ type: "decision.recorded", sequence: 1, data: { statement: "a" } }], next: 10, hasMore: true },
    { events: [{ type: "message.posted", sequence: 11 }, { type: "owner.decision_recorded", sequence: 12, data: { decision: "b" } }], next: 20, hasMore: false }
  ];
  let i = 0;
  const got = collectDecisions(() => pages[i++]);
  assert.deepEqual(got.decisions.map(d => d.statement), ["a", "b"]);
  assert.equal(got.truncated, false);
  const endless = collectDecisions(after => ({ events: [{ type: "decision.recorded", sequence: after + 1, data: { statement: String(after) } }], next: after + 1, hasMore: true }), { max: 2, maxPages: 3 });
  assert.equal(endless.truncated, true);
  assert.equal(endless.decisions.length, 2);
});

test("buildHandoffPacket retains only the supplied caller-owned summary fields", () => {
  const packet = buildHandoffPacket({
    context: { roomId: "r", viewerId: "me", cursors: { eventCursor: 5 }, orient: {
      instructions: { charter: { text: "be kind" }, pinned: [{ messageId: "p1" }] },
      claims: [{ id: "c1", title: "Own claim", state: "claimed" }],
      workItems: [{ id: "w1" }]
    } },
    decisions: { decisions: [{ statement: "ship it" }], total: 1, truncated: false },
    now: Date.parse("2026-11-04T00:00:00Z")
  });
  assert.equal(packet.contract.name, "project-room/handoff-packet");
  assert.equal(packet.rules.charter.text, "be kind");
  assert.equal(packet.rules.pinned.length, 1);
  assert.deepEqual(packet.claims.yours.map(c => c.id), ["c1"]);
  assert.equal(packet.claims.total, 1);
  assert.equal(packet.claims.scope, "caller_owned_summaries");
  assert.equal(packet.claims.yours[0].holder, undefined);
  assert.equal(packet.decisions[0].statement, "ship it");
  assert.equal(packet.yourWork.length, 1);
});

test("room_handoff_packet is not listed or callable with the flag off", async () => {
  const { HOSTED_ROOM_MCP_TOOLS } = await import("../src/room-mcp-join.js");
  if (handoffPacketEnabled()) return;
  assert.equal(HOSTED_ROOM_MCP_TOOLS.includes("room_handoff_packet"), false);
});

test("with the flag on, the hosted tool returns rules, decisions and claims", async t => {
  const { spawnSync } = await import("node:child_process");
  const run = spawnSync(process.execPath, ["--test", "tests/handoff-packet.flag-on.mjs"], {
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT")), ROOM_HANDOFF_PACKET: "1" }, encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stdout.slice(-3000) + run.stderr.slice(-2000));
  void t;
});
