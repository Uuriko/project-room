// B009: agent presence. Pure tracker tests; no realtime wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { createPresence, PresenceError, STATUSES } from "../server/agent-presence.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof PresenceError && error.code === code);

test("heartbeat records status; effective status goes stale to offline", () => {
  const presence = createPresence({ staleAfterMs: 60000 });
  const record = presence.heartbeat("quill", { status: "working", room: "lobby", now: 0 });
  assert.equal(record.status, "working");
  assert.equal(presence.effectiveStatus("quill", { now: 30000 }), "working");
  assert.equal(presence.effectiveStatus("quill", { now: 61000 }), "offline"); // stale
  assert.ok(STATUSES.includes("paused"));
});
test("inRoom lists only fresh, non-offline agents", () => {
  const presence = createPresence({ staleAfterMs: 60000 });
  presence.heartbeat("a", { status: "online", room: "lobby", now: 0 });
  presence.heartbeat("b", { status: "paused", room: "lobby", now: 0 });
  presence.heartbeat("c", { status: "online", room: "other", now: 0 });
  presence.heartbeat("d", { status: "offline", room: "lobby", now: 0 });
  const inLobby = presence.inRoom("lobby", { now: 10000 });
  assert.deepEqual(inLobby.map(r => r.agentId).sort(), ["a", "b"]);
  assert.equal(presence.inRoom("lobby", { now: 70000 }).length, 0); // all stale
  presence.remove("a");
  assert.equal(presence.size(), 3);
});
test("malformed inputs are refused", () => {
  throwsCode(() => createPresence({ staleAfterMs: -1 }), "invalid_presence");
  const presence = createPresence();
  throwsCode(() => presence.heartbeat("", { now: 0 }), "invalid_presence");
  throwsCode(() => presence.heartbeat("x", { status: "sleeping", now: 0 }), "invalid_presence");
  throwsCode(() => presence.effectiveStatus("ghost", { now: 0 }), "invalid_presence");
});

// ---------------------------------------------------------------------------
// B034-2: presence + heartbeat tracking (../src/agent-presence.mjs).
// Pure tracker tests; fake clock, no network, no DOM, no secrets.
// ---------------------------------------------------------------------------
import {
  createAgentPresence as createPresence2,
  PRESENCE_STATES as PRESENCE_STATES2,
} from "../src/agent-presence.mjs";

const throwsAP = (fn, code) =>
  assert.throws(
    fn,
    (error) => error instanceof Error && error.code === code,
    `expected throw with code ${code}`,
  );

/** Fake clock: now starts at t0 and advances only when the test says so. */
function fakeClock(t0 = 0) {
  let now = t0;
  const clock = () => now;
  clock.advance = (ms) => {
    now += ms;
    return now;
  };
  return clock;
}

test("B034-2 heartbeat upserts: create, refresh, explicit state, meta", () => {
  const clock = fakeClock(1000);
  const presence = createPresence2({ clock });
  const created = presence.heartbeat("quill");
  assert.equal(created.agentId, "quill");
  assert.equal(created.state, "online");
  assert.equal(created.lastHeartbeatAt, 1000);
  assert.equal(created.lastSeenAt, 1000);
  assert.equal(created.meta, null);

  clock.advance(5000);
  const refreshed = presence.heartbeat("quill", { meta: { room: "lobby" } });
  assert.equal(refreshed.state, "online"); // no explicit state: keeps current
  assert.equal(refreshed.lastHeartbeatAt, 6000);
  assert.equal(refreshed.lastSeenAt, 6000);
  assert.deepEqual(refreshed.meta, { room: "lobby" });

  const busy = presence.heartbeat("quill", { state: "busy" });
  assert.equal(busy.state, "busy");
  assert.equal(presence.size(), 1);
});

test("B034-2 setState validates state and agent", () => {
  const clock = fakeClock();
  const presence = createPresence2({ clock });
  presence.heartbeat("a");
  assert.equal(presence.setState("a", "away").state, "away");
  throwsAP(() => presence.setState("a", "sleeping"), "AP_INVALID_STATE");
  throwsAP(() => presence.setState("ghost", "online"), "AP_NOT_FOUND");
  throwsAP(() => presence.get("ghost"), "AP_NOT_FOUND");
  throwsAP(() => presence.heartbeat("", {}), "AP_INVALID_ARG");
  throwsAP(() => presence.heartbeat("b", { state: "napping" }), "AP_INVALID_STATE");
  throwsAP(() => presence.sweep(-1), "AP_INVALID_ARG");
  throwsAP(() => presence.subscribe("not-a-function"), "AP_INVALID_ARG");
  throwsAP(() => createPresence2({ awayAfterMs: 0 }), "AP_INVALID_ARG");
});

test("B034-2 list filters by state; get returns frozen snapshots", () => {
  const presence = createPresence2({ clock: fakeClock() });
  presence.heartbeat("a", { state: "online" });
  presence.heartbeat("b", { state: "busy" });
  presence.heartbeat("c", { state: "offline" });
  assert.deepEqual(
    presence.list({ state: "busy" }).map((r) => r.agentId),
    ["b"],
  );
  assert.equal(presence.list().length, 3);
  throwsAP(() => presence.list({ state: "napping" }), "AP_INVALID_STATE");
  const snap = presence.get("a");
  assert.ok(Object.isFrozen(snap));
  assert.equal(snap.state, "online");
  assert.ok(PRESENCE_STATES2.includes("offline"));
});

test("B034-2 sweep marks stale agents offline with audit entries", () => {
  const clock = fakeClock(0);
  const presence = createPresence2({ clock, awayAfterMs: 10_000 });
  presence.heartbeat("fresh", { state: "online" });
  presence.heartbeat("stale", { state: "busy" });
  clock.advance(61_000);
  presence.heartbeat("fresh"); // refresh only one

  const before = presence.audit.length;
  const result = presence.sweep(60_000);
  assert.deepEqual(result.offline, ["stale"]);
  assert.deepEqual(result.away, []);
  assert.equal(presence.get("stale").state, "offline");
  assert.equal(presence.get("fresh").state, "online");
  const entries = presence.audit.slice(before);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].agentId, "stale");
  assert.equal(entries[0].from, "busy");
  assert.equal(entries[0].to, "offline");
  assert.equal(entries[0].reason, "heartbeat stale");
});

test("B034-2 away auto-transition after awayAfterMs without heartbeat", () => {
  const clock = fakeClock(0);
  const presence = createPresence2({ clock, awayAfterMs: 30_000 });
  presence.heartbeat("idle", { state: "online" });
  presence.heartbeat("working", { state: "busy" });

  // Before the away window: still online everywhere.
  assert.deepEqual(presence.sweep(120_000, 29_999), { offline: [], away: [] });
  assert.equal(presence.stats({ now: 29_999 }).online, 1);

  // Past the away window: online -> away (audit + subscriber), busy untouched.
  clock.advance(45_000);
  const events = [];
  const unsub = presence.subscribe((e) => events.push(e));
  const result = presence.sweep(120_000);
  assert.deepEqual(result.away, ["idle"]);
  assert.equal(presence.get("idle").state, "away");
  assert.equal(presence.get("working").state, "busy");
  assert.equal(events.length, 1);
  assert.deepEqual(
    { agentId: events[0].agentId, from: events[0].from, to: events[0].to },
    { agentId: "idle", from: "online", to: "away" },
  );
  unsub();
});

test("B034-2 stats projects away; isOnline honors staleness", () => {
  const clock = fakeClock(0);
  const presence = createPresence2({ clock, awayAfterMs: 10_000 });
  presence.heartbeat("a", { state: "online" });
  presence.heartbeat("b", { state: "busy" });
  presence.heartbeat("c", { state: "offline" });

  assert.deepEqual(presence.stats(), { online: 1, away: 0, busy: 1, offline: 1 });
  // Away is projected in stats without mutating stored state.
  assert.deepEqual(presence.stats({ now: 20_000 }), { online: 0, away: 1, busy: 1, offline: 1 });
  assert.equal(presence.get("a").state, "online");

  assert.equal(presence.isOnline("a", { staleAfterMs: 60_000, now: 20_000 }), true);
  assert.equal(presence.isOnline("a", { staleAfterMs: 60_000, now: 70_000 }), false);
  assert.equal(presence.isOnline("c", { staleAfterMs: 60_000, now: 0 }), false);
  throwsAP(() => presence.isOnline("ghost", { staleAfterMs: 60_000 }), "AP_NOT_FOUND");
  throwsAP(() => presence.isOnline("a", { staleAfterMs: 0 }), "AP_INVALID_ARG");
});

test("B034-2 subscribers see every state change; unsubscribe stops them", () => {
  const clock = fakeClock(0);
  const presence = createPresence2({ clock, awayAfterMs: 10_000 });
  const seen = [];
  const unsub = presence.subscribe((e) => seen.push(`${e.agentId}:${e.from}->${e.to}`));

  presence.heartbeat("x"); // create: null -> online
  presence.heartbeat("x", { state: "busy" }); // online -> busy
  presence.setState("x", "away"); // busy -> away
  presence.heartbeat("x"); // refresh only: no transition
  assert.deepEqual(seen, ["x:null->online", "x:online->busy", "x:busy->away"]);

  unsub();
  presence.setState("x", "online");
  assert.equal(seen.length, 3); // no more notifications
  assert.equal(presence.get("x").state, "online");
});

test("B034-2 coded-error contract: every failure carries an AP_ code", () => {
  const presence = createPresence2({ clock: fakeClock() });
  const failures = [
    () => presence.get("nobody"),
    () => presence.setState("nobody", "online"),
    () => presence.heartbeat("nobody", { state: "bogus" }),
    () => presence.heartbeat(42),
    () => presence.sweep("soon"),
    () => presence.list({ state: "bogus" }),
  ];
  for (const fn of failures) {
    try {
      fn();
      assert.fail("expected a coded error");
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.code, /^AP_/);
    }
  }
});
