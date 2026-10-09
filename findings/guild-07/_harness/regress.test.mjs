// Fail-first regression tests for wave1000 guild-07 survived mutants.
// Each test FAILS against its mutant and PASSES on the original code.
// Run: node --test findings/guild-07/_harness/regress.test.mjs
// Mutant check: node findings/guild-07/_harness/run-mutants.mjs M2,M4,M5,M7,M14,M15
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const W = "/home/hatch/workspace/pr-wave1000-guild-07";
const { paginateRoomMessages } = await import(`${W}/client/room-agent.mjs`);
const { saveAgentConnection, ConnectionError } = await import(`${W}/client/agent-connection.mjs`);
const { attentionCapacity } = await import(`${W}/client/watch-journal.mjs`);
const { PublicWorkClaimsClient } = await import(`${W}/client/public-work-claims.mjs`);
const { validRoomToolArguments } = await import(`${W}/client/mcp-stdio.mjs`);
const { connectRoom } = await import(`${W}/client/agent-setup.mjs`);
const { openSetupJournal } = await import(`${W}/client/setup-journal.mjs`);

const TOK = "pri_" + "A".repeat(43);
const ORIGIN = "https://room.example.com";

// M2: forward scan must stop after exactly MESSAGE_SCAN_PAGES (100) pages.
test("M2-regress: scanForward page cap is exactly 100", async () => {
  let calls = 0;
  const fetchPage = async after => { calls++; return { events: [], hasMore: true, next: after + 100 }; };
  await paginateRoomMessages(fetchPage, { after: 0, limit: 5 });
  assert.equal(calls, 100, `expected 100 scan pages, got ${calls}`);
});

// M4: saveAgentConnection must never overwrite an existing connection.
// NOTE: saveAgentConnection requires a NEW dedicated directory (mkdir 0700, no recursive).
test("M4-regress: second save to the same directory throws config_exists", () => {
  const base = mkdtempSync(join(tmpdir(), "g07-m4-"));
  const dir = join(base, "conn"); // must not exist yet
  const value = { version: 1, origin: ORIGIN, roomId: "r1", memberId: "m1", token: TOK };
  try {
    saveAgentConnection(dir, value);
    assert.throws(() => saveAgentConnection(dir, value), err => err instanceof ConnectionError && err.code === "config_exists");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// M5: attention capacity gates on version 3 only.
test("M5-regress: attentionCapacity version gate", () => {
  assert.equal(attentionCapacity(1), 1000);
  assert.equal(attentionCapacity(2), 1000);
  assert.equal(attentionCapacity(3), 1001);
});

// M7: match() rejects limit > 5 client-side, before any network.
test("M7-regress: match limit bound is 5", async () => {
  let fetched = false;
  const client = new PublicWorkClaimsClient({ origin: ORIGIN, fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); } });
  await assert.rejects(client.match({ limit: 6 }), err => err.code === "invalid_input");
  assert.equal(fetched, false, "request was sent despite invalid limit");
});

// M14: 100 setup destinations is the hard cap.
test("M14-regress: 101st setup destination is refused before any network", async () => {
  const dir = mkdtempSync(join(tmpdir(), "g07-m14-"));
  let fetched = false;
  try {
    const journal = openSetupJournal(dir);
    const targets = {};
    for (let i = 0; i < 100; i++) targets[`k${i}`] = { origin: ORIGIN, roomId: `r${i}`, requestId: `q${i}`, approved: null };
    journal.save({ version: 1, origin: ORIGIN, name: "t", secret: TOK, identityId: null, targets });
    journal.close();
    const fetchImpl = async () => { fetched = true; throw new Error("must not fetch"); };
    await assert.rejects(
      connectRoom({ target: `${ORIGIN}/#room/rNew`, directory: dir, origin: ORIGIN, fetchImpl }),
      /Setup destination limit reached/);
    assert.equal(fetched, false, "network was hit despite the destination cap");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// M15: room_acknowledge_wake accepts a single signal id.
// The wake-ack tool only exists on the channel path of serveRoomMcp, so the
// regression drives the MCP round-trip: initialize → initialized → tools/call.
test("M15-regress: single-signal wake ack is accepted on the channel path", async () => {
  const { EventEmitter } = await import("node:events");
  const { serveRoomMcp, MCP_VERSION } = await import(`${W}/client/mcp-stdio.mjs`);
  const input = new EventEmitter();
  input.pause = () => {};
  const lines = [];
  const output = new EventEmitter();
  output.writableLength = 0;
  output.write = (line, cb) => { lines.push(line); cb(null); return true; };
  const channel = { acknowledge: async args => ({ acknowledged: args.signalIds }) };
  serveRoomMcp({ client: {}, roomId: "r1", memberId: "m1", input, output, channel, timeoutMs: 5000 });
  const send = msg => input.emit("data", Buffer.from(JSON.stringify(msg) + "\n"));
  send({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "room_acknowledge_wake", arguments: { signalIds: ["s1"] } } });
  await new Promise(r => setTimeout(r, 500));
  input.emit("end");
  const responses = lines.map(l => JSON.parse(l));
  const ack = responses.find(r => r.id === 2);
  assert.ok(ack, "no response to tools/call");
  assert.ok(!ack.error, `single-signal ack rejected: ${JSON.stringify(ack.error)}`);
  assert.deepEqual(ack.result.structuredContent.acknowledged, ["s1"]);
});
