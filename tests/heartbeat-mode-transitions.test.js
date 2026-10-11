// WAVE-500 guild 5 worker A2/50 — wakeable/pull-only MODE TRANSITION probes.
//
// Re-registration matrix for server/agent-heartbeats.mjs: a host that flips
// between wakeable and pull-only must not leave a stale wake_url behind,
// must keep reachability (poller vs push) consistent with its effective
// mode, and must treat an omitted mode as wakeable (RC-2026-09-28-3602).
// Synthetic fixtures only — no network calls, no real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats, agentHeartbeatSchema, HEARTBEAT_STALE_AFTER_MS,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;
const WAKE_URL = "https://host.example.test/wake";
const PUSH_URL = "https://push.example.test/hooks/room";
const pushSub = () => ({ url: PUSH_URL, token: "opaque-push-token-123" });

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at });
  t.after(() => db.close());
  return { hb, advance: ms => { at += ms; } };
}

test("wakeable with wakeUrl then pull-only leaves no stale wake_url", t => {
  const { hb } = unit(t);
  const first = hb.heartbeat({ agentId: "ai_probe", hostId: "h", mode: "wakeable", wakeUrl: WAKE_URL });
  assert.equal(first.host.mode, "wakeable");
  assert.equal(first.host.wakeUrl, WAKE_URL);
  // Re-register pull-only with no wake URL: the transition must clear it.
  const second = hb.heartbeat({ agentId: "ai_probe", hostId: "h", mode: "pull-only" });
  assert.equal(second.host.mode, "pull-only");
  assert.equal(second.host.wakeUrl, null, "pull-only re-registration must clear the wake URL");
  assert.equal(second.reachability.mode, "poller");
  const status = hb.statusOf("ai_probe");
  assert.equal(status.hosts[0].mode, "pull-only");
  assert.equal(status.hosts[0].wakeUrl, null, "status reads must agree: no stale wake_url");
});

test("pull-only then wakeable without a URL registers a poll-reached host", t => {
  const { hb } = unit(t);
  hb.heartbeat({ agentId: "ai_probe", hostId: "h", mode: "pull-only" });
  const res = hb.heartbeat({ agentId: "ai_probe", hostId: "h", mode: "wakeable" });
  assert.equal(res.host.mode, "wakeable");
  assert.equal(res.host.wakeUrl, null, "no URL declared: reached through the room-hosted wake poll");
  assert.equal(res.reachability.mode, "poller", "no push subscription means poller, not push");
});

test("omitted mode on re-registration defaults to wakeable", t => {
  const { hb } = unit(t);
  hb.heartbeat({ agentId: "ai_probe", hostId: "h", mode: "pull-only" });
  // RC-2026-09-28-3602: mode defaults to wakeable whenever the caller
  // omits it — first registration and re-registration alike. Pull-only
  // hosts must keep declaring their mode on every heartbeat.
  const res = hb.heartbeat({ agentId: "ai_probe", hostId: "h" });
  assert.equal(res.host.mode, "wakeable");
  assert.equal(hb.statusOf("ai_probe").hosts[0].mode, "wakeable");
});

test("reachability tracks the transition: push goes dormant on pull-only", t => {
  const { hb, advance } = unit(t);
  const p1 = hb.heartbeat({ agentId: "ai_probe", hostId: "h", mode: "wakeable", pushNotification: pushSub() });
  assert.equal(p1.pushConfigured, true);
  assert.equal(p1.reachability.mode, "push", "wakeable with a usable push subscription");
  // Transition to pull-only: the subscription row is sticky, but the host
  // is never push-reachable while pull-only.
  const p2 = hb.heartbeat({ agentId: "ai_probe", hostId: "h", mode: "pull-only" });
  assert.equal(p2.reachability.mode, "poller", "pull-only is never push-reachable");
  assert.equal(p2.pushConfigured, true, "the subscription row itself stays stored");
  // Offline while pull-only: no push doorbell may target the host.
  advance(HEARTBEAT_STALE_AFTER_MS + 1);
  assert.equal(hb.statusOf("ai_probe").status, "offline");
  assert.deepEqual(hb.pushTargets("ai_probe"), [], "dormant subscription must not receive doorbells");
  // Back to wakeable without re-subscribing: the sticky subscription
  // re-arms push reachability once the host goes offline again.
  hb.heartbeat({ agentId: "ai_probe", hostId: "h", mode: "wakeable" });
  advance(HEARTBEAT_STALE_AFTER_MS + 1);
  assert.equal(hb.statusOf("ai_probe").status, "offline");
  assert.equal(hb.pushTargets("ai_probe").length, 1, "sticky subscription resumes on wakeable");
  assert.equal(hb.pushTargets("ai_probe")[0].hostId, "h");
});
