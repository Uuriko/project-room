// WAVE-500 guild 5 worker D2: push SUSPEND/RESUME counter probes for
// server/agent-heartbeats.mjs deliverPush. Fail-first: each test pins the
// exact invariant — 2 failures must not suspend, the 3rd must, a 4th keeps
// suspension, a success resets the streak, re-arm clears suspension, the
// counter stays exact under concurrent deliveries, and the push path never
// throws synchronously at its caller.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AgentHeartbeats, agentHeartbeatSchema, HEARTBEAT_STALE_AFTER_MS } from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;
const PUSH_URL = "https://push.example.test/hooks/room";
const TOKEN = "opaque-push-token-123";

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at }, { staleAfterMs: HEARTBEAT_STALE_AFTER_MS });
  t.after(() => db.close());
  return { hb, advance: ms => { at += ms; } };
}

// Offline agent with a usable push subscription: heartbeat, then wait out
// the 300s cadence window (450s) so pushTargets() picks it up.
function offlineWithPush(t, transport) {
  const { hb, advance } = unit(t);
  hb.setPushTransport(transport);
  hb.heartbeat({
    agentId: "ai_testagent", hostId: "host-1", mode: "wakeable",
    wakeUrl: "https://host.example.test/wake", cadenceSeconds: 300,
    pushNotification: { url: PUSH_URL, token: TOKEN },
  });
  advance(450_001);
  assert.equal(hb.statusOf("ai_testagent").status, "offline");
  return { hb, advance };
}

// Mock transport with a controllable response status and controllable
// in-flight overlap: resolveGate() releases every in-flight POST at once.
function mockTransport({ status = 200 } = {}) {
  const calls = [];
  let currentStatus = status;
  let release = null;
  const gate = new Promise(resolve => { release = resolve; });
  let holdOpen = false;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: opts.body });
    if (holdOpen) await gate;
    return {
      status: currentStatus,
      headers: { get: () => null },
      text: async () => (currentStatus === 200 ? "" : "receiver-error"),
    };
  };
  const dnsResolvers = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
  return {
    calls, fetchImpl, dnsResolvers,
    setStatus: s => { currentStatus = s; },
    hold: () => { holdOpen = true; },
    release: () => { holdOpen = false; release(); },
  };
}

const countersOf = hb => {
  const row = hb.db.prepare(
    "SELECT push_failures AS failures, push_suspended AS suspended FROM agent_push_configs WHERE agent_id='ai_testagent' AND host_id='host-1'").get();
  return { failures: row?.failures ?? null, suspended: row?.suspended ?? null };
};

const deliverArgs = i => ({
  agentId: "ai_testagent", hostId: "host-1", url: PUSH_URL, token: TOKEN,
  eventType: "message.posted", roomId: "r", id: `probe-${i}`, ts: T0,
});

test("probe 1: exactly 3 consecutive failures suspend — 2 do not, the 4th keeps suspension", async t => {
  const transport = mockTransport({ status: 500 });
  const { hb } = offlineWithPush(t, transport);
  // Two failures: counted, not suspended.
  for (let i = 1; i <= 2; i++) {
    hb.pushNotify({ identityId: "ai_testagent", eventType: "message.posted", roomId: "r", id: `p1-e${i}`, ts: T0 });
    await hb.flushPushes();
  }
  assert.deepEqual(countersOf(hb), { failures: 2, suspended: 0 }, "2 failures must not suspend");
  assert.equal(hb.pushTargets("ai_testagent").length, 1, "still a push target after 2 failures");
  // Third failure: suspended.
  hb.pushNotify({ identityId: "ai_testagent", eventType: "message.posted", roomId: "r", id: "p1-e3", ts: T0 });
  await hb.flushPushes();
  assert.deepEqual(countersOf(hb), { failures: 3, suspended: 1 }, "3rd failure suspends");
  assert.deepEqual(hb.pushTargets("ai_testagent"), [], "suspended subscription is not a target");
  // A 4th failure landing directly on deliverPush (suspended subs never flow
  // through pushNotify) must keep suspension, not clear or corrupt it.
  const r4 = await hb.deliverPush(deliverArgs(4));
  assert.equal(r4.ok, false);
  assert.deepEqual(countersOf(hb), { failures: 4, suspended: 1 }, "4th failure keeps suspended");
});

test("probe 2: a success resets the consecutive-failure streak to 0", async t => {
  const transport = mockTransport({ status: 500 });
  const { hb } = offlineWithPush(t, transport);
  for (let i = 1; i <= 2; i++) {
    hb.pushNotify({ identityId: "ai_testagent", eventType: "message.posted", roomId: "r", id: `p2-e${i}`, ts: T0 });
    await hb.flushPushes();
  }
  assert.deepEqual(countersOf(hb), { failures: 2, suspended: 0 });
  transport.setStatus(200);
  hb.pushNotify({ identityId: "ai_testagent", eventType: "message.posted", roomId: "r", id: "p2-ok", ts: T0 });
  await hb.flushPushes();
  assert.deepEqual(countersOf(hb), { failures: 0, suspended: 0 }, "success resets failures to 0");
  // The streak restarts: two more failures after the reset must not suspend.
  transport.setStatus(500);
  for (let i = 1; i <= 2; i++) {
    hb.pushNotify({ identityId: "ai_testagent", eventType: "message.posted", roomId: "r", id: `p2-f${i}`, ts: T0 });
    await hb.flushPushes();
  }
  assert.deepEqual(countersOf(hb), { failures: 2, suspended: 0 }, "streak restarts after reset");
});

test("probe 3: a fresh pushNotification re-arms a suspended subscription", async t => {
  const transport = mockTransport({ status: 500 });
  const { hb, advance } = offlineWithPush(t, transport);
  for (let i = 1; i <= 3; i++) {
    hb.pushNotify({ identityId: "ai_testagent", eventType: "message.posted", roomId: "r", id: `p3-e${i}`, ts: T0 });
    await hb.flushPushes();
  }
  assert.deepEqual(countersOf(hb), { failures: 3, suspended: 1 });
  transport.setStatus(200);
  const res = hb.heartbeat({
    agentId: "ai_testagent", hostId: "host-1", mode: "wakeable",
    wakeUrl: "https://host.example.test/wake", cadenceSeconds: 300,
    pushNotification: { url: PUSH_URL, token: TOKEN },
  });
  assert.deepEqual(countersOf(hb), { failures: 0, suspended: 0 }, "re-arm resets both counters");
  assert.equal(res.pushSuspended, false);
  // The re-arm heartbeat refreshed presence (agent reads online, so no
  // push): advance past the window again and pushes flow once more.
  advance(450_001);
  assert.equal(hb.statusOf("ai_testagent").status, "offline");
  assert.equal(hb.pushTargets("ai_testagent").length, 1, "re-armed subscription is a target again");
  hb.pushNotify({ identityId: "ai_testagent", eventType: "message.posted", roomId: "r", id: "p3-after", ts: T0 });
  await hb.flushPushes();
  assert.equal(transport.calls.length, 4, "push resumes after re-arm");
  assert.deepEqual(countersOf(hb), { failures: 0, suspended: 0 });
});

test("probe 4: the counter stays exact under concurrent deliveries", async t => {
  const transport = mockTransport({ status: 500 });
  const { hb } = offlineWithPush(t, transport);
  // Hold every POST in flight at once, then release: 5 deliveries overlap
  // across the async delivery boundary and all fail.
  transport.hold();
  const inFlight = [];
  for (let i = 1; i <= 5; i++) inFlight.push(hb.deliverPush(deliverArgs(i)));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(transport.calls.length >= 2, `deliveries overlap in flight (saw ${transport.calls.length})`);
  transport.release();
  const results = await Promise.all(inFlight);
  assert.ok(results.every(r => r.ok === false), "all deliveries failed");
  assert.deepEqual(countersOf(hb), { failures: 5, suspended: 1 },
    "no lost increments: 5 concurrent failures count as 5 and suspend");
});

test("probe 5: deliverPush never throws synchronously; the push path never fails its caller", async t => {
  const transport = mockTransport({ status: 500 });
  const { hb } = offlineWithPush(t, transport);
  // A transport whose fetch throws synchronously must surface as a counted
  // failure, not a throw.
  hb.setPushTransport({
    fetchImpl: () => { throw new Error("boom-sync"); },
    dnsResolvers: transport.dnsResolvers,
  });
  let threw = false;
  try {
    hb.pushNotify({ identityId: "ai_testagent", eventType: "message.posted", roomId: "r", id: "p5-e1", ts: T0 });
  } catch { threw = true; }
  assert.equal(threw, false, "pushNotify must not throw on a sync-throwing transport");
  await hb.flushPushes();
  assert.deepEqual(countersOf(hb), { failures: 1, suspended: 0 }, "sync throw counts as one failure");
  // deliverPush itself returns a promise for every input shape the push path uses.
  const p = hb.deliverPush(deliverArgs(99));
  assert.ok(p instanceof Promise, "deliverPush returns a promise (never throws sync)");
  await p;
  // Invalid pushNotify input is absorbed too — the caller never fails.
  threw = false;
  try {
    hb.pushNotify({ identityId: "ai_testagent", eventType: "bogus.event", roomId: "r", id: "p5-bad", ts: T0 });
    hb.pushNotify({});
  } catch { threw = true; }
  assert.equal(threw, false, "invalid pushNotify input is absorbed");
});
