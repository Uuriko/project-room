// room-acp B4: agent crash restart with backoff, the crash-loop pause, and
// thread sessions resumed with session/load (or rebuilt with full context
// when the agent cannot load sessions).
import test from "node:test";
import assert from "node:assert/strict";
import { Bridge, CRASH_LIMIT } from "../room-acp/src/bridge.mjs";
import { join } from "../room-acp/src/join.mjs";
import { SessionMap } from "../room-acp/src/sessions.mjs";
import { startRoom, FAKE_AGENT } from "./room-acp-fixture.mjs";

const waitFor = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("timed out waiting");
};

async function startBridge(t, room, mode) {
  const connection = await join({ link: room.invite().link, displayName: "Coder", env: room.env });
  const bridge = new Bridge({ connection, candidate: { id: "fake", label: "Fake", command: process.execPath, args: [FAKE_AGENT] },
    env: { ...room.env, FAKE_ACP_MODE: mode }, waitMs: 200, restartDelayMs: 30 });
  const done = bridge.run();
  t.after(async () => { bridge.stop(); await done; });
  await waitFor(() => bridge.members);
  return { bridge, connection };
}
const repliesTo = (room, rootId, memberId) => room.messages().filter(message => message.replyToId === rootId && message.authorId === memberId);

test("session map persists, survives reload, and stays bounded", t => {
  const env = { ROOM_ACP_HOME: `${process.env.TMPDIR ?? "/tmp"}/room-acp-sessions-${process.pid}` };
  t.after(async () => (await import("node:fs")).rmSync(env.ROOM_ACP_HOME, { recursive: true, force: true }));
  const map = new SessionMap({ roomId: "r", hostId: "h", env });
  for (let i = 0; i < 205; i++) map.set(`t${i}`, `s${i}`);
  const again = new SessionMap({ roomId: "r", hostId: "h", env });
  assert.equal(again.get("t204"), "s204");
  assert.equal(again.get("t0"), null);
});

test("a crashed agent restarts and the thread resumes with session/load", async t => {
  const room = await startRoom(t);
  const { bridge, connection } = await startBridge(t, room, "echo");
  const rootId = room.say("@Coder remember this");
  await waitFor(() => repliesTo(room, rootId, connection.memberId).length === 1);
  const before = bridge.host.sessions.get(rootId);
  bridge.host.process.child.kill("SIGKILL");
  await waitFor(() => bridge.crashes.length === 1);
  room.say("@Coder still there?", { replyToId: rootId });
  const list = await waitFor(() => { const all = repliesTo(room, rootId, connection.memberId); return all.length === 2 ? all : null; });
  assert.equal(bridge.host.sessions.get(rootId), before, "same ACP session after restart");
  assert.ok(!list[1].body.includes("Thread so far"), "loaded session gets only the new message");
});

test("without loadSession a restarted thread gets the full context again", async t => {
  const room = await startRoom(t);
  const { bridge, connection } = await startBridge(t, room, "no-loadSession");
  const rootId = room.say("@Coder first");
  await waitFor(() => repliesTo(room, rootId, connection.memberId).length === 1);
  bridge.host.process.child.kill("SIGKILL");
  await waitFor(() => bridge.crashes.length === 1);
  room.say("@Coder second", { replyToId: rootId });
  const list = await waitFor(() => { const all = repliesTo(room, rootId, connection.memberId); return all.length === 2 ? all : null; });
  assert.match(list[1].body, /Thread so far[\s\S]*first[\s\S]*second/);
});

test(`${CRASH_LIMIT} crashes mid-turn post honest failures, then pause`, async t => {
  const room = await startRoom(t);
  const { bridge, connection } = await startBridge(t, room, "crash-mid-turn");
  for (let i = 0; i < CRASH_LIMIT; i++) {
    const rootId = room.say(`@Coder task ${i}`);
    const [reply] = await waitFor(() => { const all = repliesTo(room, rootId, connection.memberId); return all.length ? all : null; });
    assert.match(reply.body, /turn failed/);
  }
  await waitFor(() => bridge.pausedUntil > Date.now());
  const pausedRoot = room.say("@Coder while paused");
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(repliesTo(room, pausedRoot, connection.memberId).length, 0, "no turn runs while paused");
});
