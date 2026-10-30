// #5382 follow-up: a bridge that stops says goodbye, so presence stops
// reading online at once and mentions show as queued; the next heartbeat
// brings the host back. A crash (no goodbye) still ages out after 180s.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AgentHeartbeats, agentHeartbeatSchema } from "../server/agent-heartbeats.mjs";
import { Bridge } from "../room-acp/src/bridge.mjs";
import { join } from "../room-acp/src/join.mjs";
import { startRoom, FAKE_AGENT } from "./room-acp-fixture.mjs";

const T0 = 1_750_000_000_000;
function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  t.after(() => db.close());
  const transaction = fn => { if (db.isTransaction) return fn(); db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { if (db.isTransaction) db.exec("ROLLBACK"); throw e; } };
  return { hb: new AgentHeartbeats({ db, now: () => at, transaction }, {}), advance: ms => { at += ms; } };
}

test("disconnectHost: offline at once, lease released, next heartbeat is online again", t => {
  const { hb, advance } = unit(t);
  hb.heartbeat({ agentId: "ai_bye", hostId: "h1", mode: "pull-only" });
  const lease = hb.acquireListenerLease({ agentId: "ai_bye", roomId: "r1", listenerId: "l1", ttlMs: 60000 });
  assert.equal(hb.statusOf("ai_bye").status, "online");
  advance(1000);
  const out = hb.disconnectHost({ agentId: "ai_bye", hostId: "h1", roomId: "r1", fencingToken: lease.fencingToken });
  assert.deepEqual({ ...out }, { disconnected: true, released: true });
  const gone = hb.statusOf("ai_bye");
  assert.equal(gone.status, "offline");
  assert.equal(gone.lastSeenAt, T0, "lastSeenAt stays as observed");
  advance(1000);
  hb.heartbeat({ agentId: "ai_bye", hostId: "h1", mode: "pull-only" });
  assert.equal(hb.statusOf("ai_bye").status, "online");
});

test("disconnectHost: unknown host is a no-op; another host keeps the agent online", t => {
  const { hb } = unit(t);
  assert.deepEqual({ ...hb.disconnectHost({ agentId: "ai_two", hostId: "nope" }) }, { disconnected: false, released: false });
  hb.heartbeat({ agentId: "ai_two", hostId: "a", mode: "pull-only" });
  hb.heartbeat({ agentId: "ai_two", hostId: "b", mode: "pull-only" });
  hb.disconnectHost({ agentId: "ai_two", hostId: "a" });
  assert.equal(hb.statusOf("ai_two").status, "online");
});

test("room-acp: stopping the bridge stops 'listening' right away and the mention shows queued", async t => {
  const room = await startRoom(t);
  const connection = await join({ link: room.invite().link, displayName: "Coder", env: room.env });
  const env = { ...room.env, FAKE_ACP_MODE: "echo" };
  const bridge = new Bridge({ connection, candidate: { id: "fake", label: "Fake", command: process.execPath, args: [FAKE_AGENT] }, env, waitMs: 1000, cadenceSeconds: 30, log: () => {} });
  const done = bridge.run();
  const until = async check => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error("timed out"); };
  await until(() => bridge.fencingToken);
  const row = () => room.f.store.presenceMembers("commons", []).find(m => m.memberId === connection.memberId);
  assert.equal(row().presence.status, "online");
  bridge.stop(); await done;
  assert.equal(row().presence.status, "offline");
  assert.notEqual(row().state, "listening");
  room.say("@Coder are you there?");
  assert.equal(row().queuedWakes, 1);
});
