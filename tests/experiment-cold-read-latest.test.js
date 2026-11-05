// EXP-1 cold_read_latest wiring: a cold hosted room_read_messages returns the
// newest page only when the experiment is enabled, in scope and the member is
// in the `latest` arm. Explicit `after` / `latest` always win.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { callHostedStdioTool } from "../server/mcp-full-profile.mjs";

function fixture(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner");
  for (let i = 0; i < 8; i++) store.command(key, "commons", { id: `p-${i}`, type: "message.posted", data: { messageId: `m${i}`, body: `m${i}` } });
  const read = args => callHostedStdioTool(store, key, "room_read_messages", { roomId: "commons", limit: 2, ...args });
  return { read };
}

const ids = page => page.value.messages.map(m => m.messageId);

function withEnv(t, vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test("off: a cold read still returns the oldest page", async t => {
  const { read } = fixture(t);
  assert.deepEqual(ids(await read({})), ["m0", "m1"]);
});

test("on, scope all, forced latest arm: cold read returns the newest page; explicit args win", async t => {
  withEnv(t, { ROOM_EXPERIMENTS: "cold_read_latest", ROOM_EXPERIMENTS_SCOPE: "all", GROWTH_FORCE_ARMS: "cold_read_latest:latest" });
  const { read } = fixture(t);
  assert.deepEqual(ids(await read({})), ["m6", "m7"]);
  assert.deepEqual(ids(await read({ latest: false })), ["m0", "m1"]);
  assert.deepEqual(ids(await read({ after: 0 })), ["m0", "m1"]);
});

test("on but default qa scope: non-qa room keeps the oldest page", async t => {
  withEnv(t, { ROOM_EXPERIMENTS: "cold_read_latest", GROWTH_FORCE_ARMS: "cold_read_latest:latest" });
  const { read } = fixture(t);
  assert.deepEqual(ids(await read({})), ["m0", "m1"]);
});
