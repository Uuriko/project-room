// Push target selection (WAVE-500 guild 5, worker D1): fail-first probes for
// the pushTargets/pushNotify selection contract not covered elsewhere —
// multi-host fan-out and the PUSH_EVENT_TYPES gate. Synthetic fixtures only;
// fetch and DNS are injected mocks, no real network calls.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats, HeartbeatError, agentHeartbeatSchema,
  HEARTBEAT_STALE_AFTER_MS,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;
const PUSH_URL = "https://push.example.test/hooks/room";

function unit(t, { staleAfterMs = HEARTBEAT_STALE_AFTER_MS } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at }, { staleAfterMs });
  t.after(() => db.close());
  return { hb, advance: ms => { at += ms; }, at: () => at };
}

function mockTransport({ status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: opts.body });
    return { status, headers: { get: () => null }, text: async () => "" };
  };
  const dnsResolvers = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
  return { calls, fetchImpl, dnsResolvers };
}

const sub = (hostId, url = PUSH_URL) => ({
  agentId: "ai_multihost", hostId, mode: "wakeable",
  pushNotification: { url, token: `tok-${hostId}` },
});

const throwsHeartbeat422 = (fn, pattern, note) => {
  try { fn(); } catch (error) {
    assert.ok(error instanceof HeartbeatError, `${note}: expected HeartbeatError, got ${error}`);
    assert.equal(error.status, 422, `${note}: expected status 422, got ${error.status}`);
    assert.equal(error.code, "invalid_heartbeat", `${note}: expected code invalid_heartbeat, got ${error.code}`);
    assert.match(error.message, pattern, `${note}: message mismatch`);
    return;
  }
  assert.fail(`${note}: expected a 422 invalid_heartbeat throw`);
};

test("multiple wakeable offline hosts each get their own push target", async t => {
  const { hb, advance } = unit(t);
  const transport = mockTransport();
  hb.setPushTransport(transport);
  hb.heartbeat(sub("host-1"));
  hb.heartbeat(sub("host-2", "https://push.example.test/hooks/other"));
  advance(HEARTBEAT_STALE_AFTER_MS + 1);
  assert.equal(hb.statusOf("ai_multihost").status, "offline");
  const targets = hb.pushTargets("ai_multihost");
  assert.equal(targets.length, 2, "one target per wakeable offline host");
  assert.deepEqual(targets.map(tg => tg.hostId).sort(), ["host-1", "host-2"]);
  assert.deepEqual(targets.map(tg => tg.url).sort(),
    [PUSH_URL, "https://push.example.test/hooks/other"].sort());
  // Each target carries its own host's token — never the other host's.
  const byHost = new Map(targets.map(tg => [tg.hostId, tg]));
  assert.equal(byHost.get("host-1").token, "tok-host-1");
  assert.equal(byHost.get("host-2").token, "tok-host-2");
  // Fan-out delivers one POST per target.
  hb.pushNotify({ identityId: "ai_multihost", eventType: "message.posted", roomId: "r", id: "e1", ts: T0 });
  await hb.flushPushes();
  assert.equal(transport.calls.length, 2, "one doorbell POST per target");
  assert.deepEqual(transport.calls.map(c => c.headers["X-Room-Notification-Token"]).sort(),
    ["tok-host-1", "tok-host-2"]);
});

test("pushNotify rejects an unknown event type loudly instead of swallowing it", t => {
  const { hb, advance } = unit(t);
  hb.heartbeat(sub("host-1"));
  advance(HEARTBEAT_STALE_AFTER_MS + 1);
  throwsHeartbeat422(
    () => hb.pushNotify({ identityId: "ai_multihost", eventType: "bogus.event", roomId: "r", id: "e1", ts: T0 }),
    /eventType/,
    "unknown event type");
});

test("pushNotify rejects a missing identityId loudly", t => {
  const { hb } = unit(t);
  throwsHeartbeat422(
    () => hb.pushNotify({ identityId: "", eventType: "message.posted", roomId: "r", id: "e1", ts: T0 }),
    /identityId/,
    "empty identityId");
  throwsHeartbeat422(
    () => hb.pushNotify({ eventType: "message.posted", roomId: "r", id: "e1", ts: T0 }),
    /identityId/,
    "absent identityId");
});

test("selection and delivery failures still never fail the caller", async t => {
  const { hb } = unit(t);
  hb.setPushTransport(mockTransport());
  // Unknown identity: no targets, no throw (documented fire-and-forget contract).
  hb.pushNotify({ identityId: "ai_ghost", eventType: "dm.posted", roomId: "r", id: "g1", ts: T0 });
  await hb.flushPushes();
  assert.ok(true, "unknown identities stay silent");
});
