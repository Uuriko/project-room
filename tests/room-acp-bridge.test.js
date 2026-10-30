// room-acp B3: the bridge loop end to end against a real local Room server
// and the scripted fake ACP agent: mention -> one turn -> threaded reply ->
// ack; owner-only by default; mid-turn messages batch into the next turn.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TurnRecorder, renderTurn, TRAILER_LINES } from "../room-acp/src/render.mjs";
import { ThreadQueue } from "../room-acp/src/queue.mjs";
import { mayTalk, Bridge } from "../room-acp/src/bridge.mjs";
import { join } from "../room-acp/src/join.mjs";
import { startRoom, FAKE_AGENT } from "./room-acp-fixture.mjs";

const waitFor = async (check, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("timed out waiting");
};

test("render: text plus a bounded tool trailer, never thoughts", () => {
  const recorder = new TurnRecorder();
  recorder.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "SECRET" } });
  recorder.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } });
  for (let i = 0; i < 25; i++) recorder.update({ sessionUpdate: "tool_call", toolCallId: `t${i}`, title: `step ${i}`, status: "completed" });
  recorder.update({ sessionUpdate: "tool_call_update", toolCallId: "t0", status: "failed" });
  const out = renderTurn(recorder);
  assert.ok(!out.includes("SECRET"));
  assert.ok(out.startsWith("Done."));
  const trailer = out.split("\n").slice(2);
  assert.equal(trailer.length, TRAILER_LINES);
  assert.equal(trailer[0], "✗ step 0");
  assert.match(trailer.at(-1), /and 16 more tool calls/);
  assert.match(renderTurn(new TurnRecorder(), { error: "boom" }), /turn failed: boom/);
});

test("queue: one turn in flight per thread, later items batch", async () => {
  const calls = [];
  let release;
  const queue = new ThreadQueue({ concurrency: 2, run: async (key, batch) => { calls.push([key, batch.map(item => item.messageId)]); if (calls.length === 1) await new Promise(resolve => { release = resolve; }); } });
  queue.push("a", { messageId: "1" });
  queue.push("a", { messageId: "2" });
  queue.push("a", { messageId: "3" });
  assert.equal(queue.push("a", { messageId: "3" }), false);
  queue.push("b", { messageId: "4" });
  await new Promise(resolve => setTimeout(resolve, 10));
  release();
  await queue.idle(); await queue.idle();
  assert.deepEqual(calls, [["a", ["1"]], ["b", ["4"]], ["a", ["2", "3"]]]);
});

test("mayTalk: owner and the owner's agents by default; anyone when opted in", () => {
  const members = { owner: { id: "owner", kind: "human" }, guest: { id: "guest", kind: "human" }, helper: { id: "helper", kind: "agent", accountableHumanId: "owner" }, me: { id: "me", kind: "agent", accountableHumanId: "owner" } };
  const base = { members, me: members.me, ownerId: "owner", respondTo: "owner" };
  assert.equal(mayTalk({ ...base, authorId: "owner" }), true);
  assert.equal(mayTalk({ ...base, authorId: "helper" }), true);
  assert.equal(mayTalk({ ...base, authorId: "guest" }), false);
  assert.equal(mayTalk({ ...base, authorId: "me" }), false);
  assert.equal(mayTalk({ ...base, authorId: "guest", respondTo: "anyone" }), true);
});

async function startBridge(t, room, { mode = "echo", respondTo = "owner" } = {}) {
  const connection = await join({ link: room.invite().link, displayName: "Coder", env: room.env });
  const env = { ...room.env, FAKE_ACP_MODE: mode, FAKE_ACP_DELAY_MS: "4000" };
  const bridge = new Bridge({ connection, candidate: { id: "fake", label: "Fake", command: process.execPath, args: [FAKE_AGENT] }, env, respondTo, waitMs: 3000, cadenceSeconds: 30, log: process.env.RA_DEBUG ? (...a) => console.error("[bridge]", ...a) : () => {} });
  const done = bridge.run();
  t.after(async () => { bridge.stop(); await done; });
  await waitFor(() => bridge.members && bridge.fencingToken);
  return { bridge, connection, done };
}

const repliesTo = (room, rootId, memberId) => room.messages().filter(message => message.replyToId === rootId && message.authorId === memberId);

test("bridge: an owner mention gets one threaded reply, then the wake is acked", async t => {
  const room = await startRoom(t);
  const { bridge, connection } = await startBridge(t, room);
  const rootId = room.say("@Coder hello there");
  const [reply] = await waitFor(() => { const list = repliesTo(room, rootId, connection.memberId); return list.length ? list : null; });
  assert.match(reply.body, /^echo: /);
  assert.match(reply.body, /hello there/);
  await waitFor(() => bridge.stats.acked === 1);
  // A follow-up in the same thread reuses the session and replies in the same thread.
  room.say("@Coder again", { replyToId: rootId });
  const list = await waitFor(() => { const all = repliesTo(room, rootId, connection.memberId); return all.length === 2 ? all : null; });
  assert.match(list[1].body, /again/);
  assert.ok(!list[1].body.includes("Thread so far"), "later turns send only the new messages");
  assert.equal(bridge.host.sessions.size, 1);
});

test("bridge: a guest's mention is ignored by default and acked", async t => {
  const room = await startRoom(t);
  const { bridge, connection } = await startBridge(t, room);
  const guestKey = room.f.store.issueAccessKey("commons", "guest");
  room.f.store.command(guestKey, "commons", { id: randomUUID(), type: "message.posted", data: { messageId: "g1", body: "@Coder do something" } });
  await waitFor(() => bridge.stats.skipped === 1);
  assert.equal(repliesTo(room, "g1", connection.memberId).length, 0);
});

test("bridge: messages during a slow turn batch into one next turn", async t => {
  const room = await startRoom(t);
  const { bridge, connection } = await startBridge(t, room, { mode: "slow" });
  const rootId = room.say("@Coder first");
  await waitFor(() => bridge.queue.active === 1);
  room.say("@Coder second", { replyToId: rootId });
  room.say("@Coder third", { replyToId: rootId });
  const list = await waitFor(() => { const all = repliesTo(room, rootId, connection.memberId); return all.length === 2 ? all : null; }, 20000);
  assert.match(list[1].body, /second[\s\S]*third/);
  await waitFor(() => bridge.stats.acked === 3);
});
