// WAVE-500 guild 5 A1: fail-first probes for heartbeat REGISTRATION input
// validation (server/agent-heartbeats.mjs :: heartbeat()).
// Synthetic fixtures only — no network, no real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AgentHeartbeats, HeartbeatError, agentHeartbeatSchema } from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  const setHostCalls = [];
  const workWakes = {
    setHost: (agentId, hostId, enabled, roomId) => setHostCalls.push({ agentId, hostId, enabled, roomId }),
    hostEnabled: () => false,
    pending: () => [],
  };
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at, workWakes });
  t.after(() => db.close());
  return { hb, setHostCalls };
}

const valid = (over = {}) => ({ agentId: "ai_testagent", hostId: "host-1", ...over });

const throws422 = (fn, re) => assert.throws(fn, err =>
  err instanceof HeartbeatError && err.status === 422 && err.code === "invalid_heartbeat" && re.test(err.message));

test("agentId pattern edge cases", t => {
  const { hb } = unit(t);
  throws422(() => hb.heartbeat(valid({ agentId: "" })), /agentId/);
  throws422(() => hb.heartbeat(valid({ agentId: "a".repeat(65) })), /agentId/);
  throws422(() => hb.heartbeat(valid({ agentId: "ai_téstagent" })), /agentId/);
  throws422(() => hb.heartbeat(valid({ agentId: "ai.testagent" })), /agentId/);
  throws422(() => hb.heartbeat(valid({ agentId: "ai test" })), /agentId/);
  throws422(() => hb.heartbeat(valid({ agentId: 123 })), /agentId/);
  throws422(() => hb.heartbeat({ hostId: "host-1" }), /agentId/);
  // controls: boundaries that must stay valid
  const { host } = hb.heartbeat(valid({ agentId: "a".repeat(64), hostId: "h-64" }));
  assert.equal(host.agentId, "a".repeat(64));
});

test("hostId pattern edge cases", t => {
  const { hb } = unit(t);
  throws422(() => hb.heartbeat(valid({ hostId: "" })), /hostId/);
  throws422(() => hb.heartbeat(valid({ hostId: "h".repeat(129) })), /hostId/);
  throws422(() => hb.heartbeat(valid({ hostId: "hôst" })), /hostId/);
  throws422(() => hb.heartbeat(valid({ hostId: "bad id!" })), /hostId/);
  throws422(() => hb.heartbeat({ agentId: "ai_testagent" }), /hostId/);
  // controls: dots/underscores/dashes allowed, exactly 128 ok
  const dotted = "a.b_c-" + "h".repeat(122);
  assert.equal(dotted.length, 128);
  const { host } = hb.heartbeat(valid({ hostId: dotted }));
  assert.equal(host.hostId, dotted);
});

test("mode: null/undefined default to wakeable; invalid strings rejected", t => {
  const { hb } = unit(t);
  assert.equal(hb.heartbeat(valid({ mode: null, hostId: "m1" })).host.mode, "wakeable");
  assert.equal(hb.heartbeat(valid({ mode: undefined, hostId: "m2" })).host.mode, "wakeable");
  assert.equal(hb.heartbeat(valid({ mode: "pull-only", hostId: "m3" })).host.mode, "pull-only");
  throws422(() => hb.heartbeat(valid({ mode: "sleepy", hostId: "m4" })), /mode/);
  throws422(() => hb.heartbeat(valid({ mode: "", hostId: "m5" })), /mode/);
  throws422(() => hb.heartbeat(valid({ mode: "Wakeable", hostId: "m6" })), /mode/);
  throws422(() => hb.heartbeat(valid({ mode: "wakeable ", hostId: "m7" })), /mode/);
  throws422(() => hb.heartbeat(valid({ mode: 123, hostId: "m8" })), /mode/);
  throws422(() => hb.heartbeat(valid({ mode: ["wakeable"], hostId: "m9" })), /mode/);
});

test("wakeUrl contract: wakeable optional/validated, pull-only refuses", t => {
  const { hb } = unit(t);
  throws422(() => hb.heartbeat(valid({ mode: "pull-only", hostId: "p1", wakeUrl: "https://x.example.test/w" })), /pull-only/);
  throws422(() => hb.heartbeat(valid({ hostId: "w1", wakeUrl: "" })), /invalid wakeUrl/);
  throws422(() => hb.heartbeat(valid({ hostId: "w2", wakeUrl: 123 })), /invalid wakeUrl/);
  throws422(() => hb.heartbeat(valid({ hostId: "w3", wakeUrl: "http://insecure.example.test/w" })), /invalid wakeUrl/);
  const { host } = hb.heartbeat(valid({ hostId: "w4", wakeUrl: null }));
  assert.equal(host.wakeUrl, null);
});

test("cadenceSeconds bounds", t => {
  const { hb } = unit(t);
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "300", true]) {
    throws422(() => hb.heartbeat(valid({ hostId: `c-${String(bad)}`, cadenceSeconds: bad })), /cadenceSeconds/, String(bad));
  }
  const { host } = hb.heartbeat(valid({ hostId: "c-ok", cadenceSeconds: 604800 }));
  assert.equal(host.cadenceSeconds, 604800);
  throws422(() => hb.heartbeat(valid({ hostId: "c-big", cadenceSeconds: 604801 })), /cadenceSeconds/);
});

test("workWakes must be a boolean; null reads as absent like every other optional", t => {
  const { hb, setHostCalls } = unit(t);
  throws422(() => hb.heartbeat(valid({ hostId: "ww1", workWakes: "yes" })), /workWakes/);
  throws422(() => hb.heartbeat(valid({ hostId: "ww2", workWakes: 1 })), /workWakes/);
  const before = setHostCalls.length;
  const { host } = hb.heartbeat(valid({ hostId: "ww3", workWakes: null }));
  assert.equal(host.workWakes, false);
  assert.equal(setHostCalls.length, before, "workWakes:null must not touch the opt-in store");
});

// pull-only + pushNotification stays accepted: the delivery-time
// wakeable-only gate (covered by tests/wake-path.test.js) is the chosen
// enforcement point, not registration. Intentionally no probe here.
