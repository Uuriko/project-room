// WAKE0-3a: scripts/room-listen.mjs --mode bridge.
// The bridge binds the operator-registered wake endpoint; a wake ping is
// an untrusted pointer whose only effect is "the listener child runs".
// Contract under test:
//  1. a wake-shaped POST starts the listener child exactly once;
//  2. a duplicate ping while the child lives is a no-op;
//  3. after the child exits, the next ping starts it again;
//  4. non-wake POSTs are ignored and start nothing;
//  5. the bridge starts no model and answers /health.
//
// Synthetic fixtures only — the child is a fake spawn; no real processes.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { serveWakeBridge } from "../scripts/room-listen.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.kill = () => { child.killed = true; };
  return child;
}

async function rig(t, opts = {}) {
  const spawns = [];
  const children = [];
  const spawnImpl = (cmd, args, spawnOpts) => {
    const child = fakeChild();
    spawns.push({ cmd, args, env: spawnOpts?.env });
    children.push(child);
    return child;
  };
  const bridge = await serveWakeBridge({
    host: "bridge-host", cadenceSeconds: 30, port: 0, bind: "127.0.0.1",
    env: { ROOM_AGENT_CONFIG: "/unused/fixture.json" }, spawnImpl,
    log: () => {}, ...opts,
  });
  t.after(async () => { await bridge.close(); });
  const base = `http://127.0.0.1:${bridge.port}`;
  const post = (body, path = "/wake") => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { bridge, spawns, children, base, post };
}

test("a wake ping starts the listener child once; duplicates are no-ops", async t => {
  const { bridge, spawns, post } = await rig(t);
  const first = await (await post({ event: "agent.wake", agentId: "ai_x", signal: { signalId: "sig-1" } })).json();
  assert.deepEqual(first, { ok: true, listenerRunning: true, started: true });
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args.slice(1), ["--mode", "poll", "--host", "bridge-host", "--cadence-seconds", "30"],
    "the child is this script's poll listener with the bridge's host config");
  assert.equal(spawns[0].args[0].endsWith("room-listen.mjs"), true);
  const dupe = await (await post({ event: "agent.wake", agentId: "ai_x", signal: { signalId: "sig-1" } })).json();
  assert.equal(dupe.started, false, "duplicate ping: no second spawn");
  assert.equal(spawns.length, 1);
  assert.equal(bridge.listenerRunning(), true);
});

test("journal delivery envelopes and push doorbells also count as pings", async t => {
  const { spawns, children, post } = await rig(t);
  await post({ eventType: "agent.wake", deliveryId: "del-1", data: { event: "agent.wake" } });
  assert.equal(spawns.length, 1, "a journaled agent.wake delivery wakes the bridge");
  children[0].emit("exit", 0, null);
  const doorbell = await (await post({ eventType: "message.posted", roomId: "commons", id: "evt-1", ts: 1 }, "/push")).json();
  assert.equal(doorbell.started, true, "a push doorbell wakes the bridge on any path");
  assert.equal(spawns.length, 2);
});

test("after the child exits, the next ping starts it again", async t => {
  const { bridge, spawns, children, post } = await rig(t);
  await post({ event: "agent.wake" });
  children[0].emit("exit", 1, null);
  assert.equal(bridge.listenerRunning(), false, "an exited child reads as down");
  await post({ event: "agent.wake" });
  assert.equal(spawns.length, 2, "the next ping restarts the listener");
});

test("non-wake POSTs are ignored and start nothing; health reports state", async t => {
  const { spawns, base, post } = await rig(t);
  const health = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(health, { ok: true, mode: "bridge", listenerRunning: false });
  for (const body of [{ hello: "world" }, { eventType: "room.deleted" }, "not json", { event: "agent.wake.extra" }]) {
    const res = await (await post(body)).json();
    assert.deepEqual(res, { ok: true, ignored: true }, `ignored: ${JSON.stringify(body)}`);
  }
  assert.equal(spawns.length, 0);
  const missing = await fetch(`${base}/nope`);
  assert.equal(missing.status, 404);
});

test("close kills the listener child", async t => {
  const { bridge, children, post } = await rig(t);
  await post({ event: "agent.wake" });
  assert.equal(children[0].killed, undefined);
  await bridge.close();
  assert.equal(children[0].killed, true, "closing the bridge stops its listener");
});

test("channel listener mode is passed through to the child", async t => {
  const { spawns, post } = await rig(t, { listenerMode: "channel" });
  await post({ event: "agent.wake" });
  assert.equal(spawns[0].args[2], "channel", "the child runs the channel listener when configured");
});
