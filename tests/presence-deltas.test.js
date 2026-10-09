// WAVE-500 W6: server-side presence deltas + TTL reaper + idle liveness,
// extending server/agent-heartbeats.mjs (no parallel system).
//
// Acceptance criteria from W7's presence-scale suite:
//  1. TTL expiry cleanup — expired agent_hosts rows are pruned (reaper).
//  2. Server-side join/leave delta subscription (no per-agent statusOf polling).
//  3. Authenticated non-heartbeat traffic (notePoll) refreshes presence liveness.
//
// Pure unit tests over :memory: SQLite with a controllable clock.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats, agentHeartbeatSchema, PRESENCE_REAP_INTERVAL_MS,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;

function unit(t, { staleAfterMs = 2000 } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at }, { staleAfterMs });
  t.after(() => db.close());
  return { db, hb, advance: ms => { at += ms; }, at: () => at };
}

const beat = (agentId, hostId = "h1", extra = {}) =>
  ({ agentId, hostId, mode: "pull-only", ...extra });

const ghosts = (db, at, windowMs) =>
  db.prepare("SELECT COUNT(*) AS n FROM agent_hosts WHERE last_seen_at <= ?")
    .get(at - windowMs).n;

// ---- 1. delta subscription exists ------------------------------------------

test("subscribeDeltas is exposed on AgentHeartbeats", t => {
  const { hb } = unit(t);
  assert.equal(typeof hb.subscribeDeltas, "function");
});

// ---- 2. delta semantics: join/leave, no flap, alternation ------------------

test("delta semantics: join once, no flap on reconnect/new host, leave on reap, rejoin", t => {
  const { hb, advance } = unit(t);
  const events = [];
  const unsub = hb.subscribeDeltas({ onDelta: e => events.push(e) });

  hb.heartbeat(beat("ai_1"));                       // join
  hb.heartbeat(beat("ai_1"));                       // same host again: silent
  advance(500);
  hb.heartbeat(beat("ai_1", "h2"));                 // new host while online: no flap
  assert.deepEqual(events.map(e => e.type), ["join"]);
  assert.equal(events[0].agentId, "ai_1");
  assert.equal(events[0].hostId, "h1");

  advance(2500);                                     // both hosts now stale (>2000ms)
  const pruned = hb.reapStaleHosts();
  assert.equal(pruned, 2);
  assert.deepEqual(events.map(e => e.type), ["join", "leave"]);
  assert.equal(events[1].agentId, "ai_1");

  hb.heartbeat(beat("ai_1"));                       // rejoin
  assert.deepEqual(events.map(e => e.type), ["join", "leave", "join"]);

  unsub();
  hb.heartbeat(beat("ai_1", "h9"));
  assert.equal(events.length, 3, "unsubscribed listener gets nothing more");
});

test("leave is announced once even when the reaper runs twice", t => {
  const { hb, advance } = unit(t);
  const events = [];
  hb.subscribeDeltas({ onDelta: e => events.push(e) });
  hb.heartbeat(beat("ai_2"));
  advance(5000);
  assert.equal(hb.reapStaleHosts(), 1);
  assert.equal(hb.reapStaleHosts(), 0, "second sweep prunes nothing");
  assert.deepEqual(events.map(e => e.type), ["join", "leave"],
    "no duplicate leave on the second sweep");
});

test("agentIds filter scopes delivery; other agents stay silent", t => {
  const { hb, advance } = unit(t);
  const events = [];
  hb.subscribeDeltas({ agentIds: ["ai_watched"], onDelta: e => events.push(e) });
  hb.heartbeat(beat("ai_watched"));
  hb.heartbeat(beat("ai_other"));
  advance(5000);
  hb.reapStaleHosts();
  assert.deepEqual(events.map(e => `${e.type}:${e.agentId}`),
    ["join:ai_watched", "leave:ai_watched"]);
});

test("a throwing subscriber never breaks heartbeats or other subscribers", t => {
  const { hb } = unit(t);
  const good = [];
  hb.subscribeDeltas({ onDelta: () => { throw new Error("boom"); } });
  hb.subscribeDeltas({ onDelta: e => good.push(e) });
  assert.doesNotThrow(() => hb.heartbeat(beat("ai_3")));
  assert.deepEqual(good.map(e => e.type), ["join"]);
});

test("late subscriber: first event is always a join (per-subscriber alternation)", t => {
  const { hb, advance } = unit(t);
  hb.heartbeat(beat("ai_4")); // join happens before anyone listens
  const events = [];
  hb.subscribeDeltas({ onDelta: e => events.push(e) });
  hb.heartbeat(beat("ai_4")); // already online: no global transition, no event
  assert.equal(events.length, 0);
  advance(5000);
  hb.reapStaleHosts(); // agent was never announced to this subscriber: no phantom leave
  assert.equal(events.length, 0);
  hb.heartbeat(beat("ai_4")); // rejoin: first event is a join
  assert.deepEqual(events.map(e => e.type), ["join"]);
});

// ---- 3. subscription agrees with snapshot-diff under churn ------------------

test("subscription matches polled snapshot-diff under a churn storm", t => {
  const { hb, advance } = unit(t, { staleAfterMs: 2000 });
  const N = 60, TICKS = 30;
  const ids = Array.from({ length: N }, (_, i) => `ai_c_${i}`);
  const subEvents = [];
  let tick = 0;
  hb.subscribeDeltas({ onDelta: e => subEvents.push({ type: e.type, agentId: e.agentId, tick }) });
  // Snapshot-diff oracle (W7's contract): poll every agent after each tick.
  const known = new Map(ids.map(id => [id, false]));
  const polled = [];
  const joinTick = i => i % TICKS;
  const leaveTick = i => joinTick(i) + 2 + (i % 5);
  for (; tick < TICKS + 10; tick++) {
    for (let i = 0; i < N; i++) {
      if (tick >= joinTick(i) && tick < leaveTick(i)) hb.heartbeat(beat(ids[i]));
    }
    advance(1000);
    hb.reapStaleHosts(); // reap every tick: leaves surface promptly
    for (const id of ids) {
      const online = hb.statusOf(id).status === "online";
      if (online !== known.get(id)) {
        known.set(id, online);
        polled.push({ type: online ? "join" : "leave", agentId: id, tick });
      }
    }
  }
  // W7's contract, applied to the subscription stream: per-agent the two
  // streams must be identical sequences (same-tick cross-agent interleaving
  // is intentionally unspecified), ticks non-decreasing, final state agrees.
  const perAgent = events => {
    const map = new Map();
    for (const e of events) {
      if (!map.has(e.agentId)) map.set(e.agentId, []);
      map.get(e.agentId).push(`${e.type}@${e.tick}`);
    }
    return map;
  };
  const subByAgent = perAgent(subEvents), oracleByAgent = perAgent(polled);
  assert.deepEqual([...subByAgent.keys()].sort(), [...oracleByAgent.keys()].sort(),
    "subscription and oracle observe the same agents");
  for (const [id, types] of subByAgent) {
    assert.deepEqual(types, oracleByAgent.get(id),
      `${id}: subscription diverges from snapshot-diff`);
    assert.equal(types[0].split("@")[0], "join", `${id}: first event must be join`);
    for (let k = 1; k < types.length; k++) {
      assert.notEqual(types[k].split("@")[0], types[k - 1].split("@")[0],
        `${id}: duplicate transition`);
    }
    const finalOnline = hb.statusOf(id).status === "online";
    assert.equal(types[types.length - 1].startsWith("join"), finalOnline,
      `${id}: stream disagrees with final presence`);
  }
  for (let k = 1; k < subEvents.length; k++) {
    assert.ok(subEvents[k].tick >= subEvents[k - 1].tick, "subscription events stay tick-ordered");
  }
  t.diagnostic(`churn storm: ${subEvents.length} subscription deltas, contract-exact vs snapshot-diff`);
});

// ---- 4. TTL reaper: ghost-row cleanup ---------------------------------------

test("reapStaleHosts prunes expired hosts, keeps fresh ones, honors cadence windows", t => {
  const { hb, advance } = unit(t, { staleAfterMs: 2000 });
  hb.heartbeat(beat("ai_gone"));                       // expires
  hb.heartbeat(beat("ai_slow", "h1", { cadenceSeconds: 3600 })); // 90min window: stays
  advance(1500);
  hb.heartbeat(beat("ai_fresh"));                      // fresh
  advance(1000);                                        // ai_gone is 2500ms stale; ai_fresh 1000ms
  const pruned = hb.reapStaleHosts();
  assert.equal(pruned, 1);
  assert.equal(hb.statusOf("ai_gone").status, "unregistered", "pruned host reads unregistered");
  assert.equal(hb.statusOf("ai_fresh").status, "online");
  assert.equal(hb.statusOf("ai_slow").status, "online", "cadence window honored");
});

test("24h churn: piggybacked reaper bounds ghosts; explicit reap drains them", t => {
  const STALE_MS = 2000;
  const { db, hb, advance, at } = unit(t, { staleAfterMs: STALE_MS });
  const TICK = 10 * 60 * 1000, PER_TICK = 10, TICKS = 144; // 24h
  for (let tick = 0; tick < TICKS; tick++) {
    for (let m = 0; m < 10; m++) {
      for (let i = 0; i < PER_TICK; i++) hb.heartbeat(beat(`ai_churn_${tick}_${i}`));
      advance(60_000);
    }
    advance(TICK - 10 * 60_000);
  }
  // The piggybacked reaper (60s throttle) prunes every earlier batch; only
  // the final batch — written 60s before the assertion, with nothing
  // scheduled after the last clock advance — can remain.
  const afterLoop = ghosts(db, at(), STALE_MS);
  assert.ok(afterLoop <= PER_TICK,
    `piggybacked reaper must bound ghosts to the final batch: got ${afterLoop}`);
  // The explicit reaper is the drain: one sweep, zero ghosts.
  hb.reapStaleHosts();
  assert.equal(ghosts(db, at(), STALE_MS), 0, "explicit reap drains all expired rows");
});

test("reaper also drops push configs orphaned by pruned hosts", t => {
  const { db, hb, advance } = unit(t, { staleAfterMs: 2000 });
  hb.heartbeat(beat("ai_push", "h1", {
    pushNotification: { url: "https://push.example.test/x", token: "tok" },
  }));
  advance(5000);
  hb.reapStaleHosts();
  const orphans = db.prepare("SELECT COUNT(*) AS n FROM agent_push_configs").get().n;
  assert.equal(orphans, 0, "push config for a pruned host must not linger");
});

// ---- 5. idle liveness: notePoll refreshes last_seen -------------------------

test("authenticated poll traffic refreshes presence liveness (no heartbeat needed)", t => {
  const { db, hb, advance } = unit(t, { staleAfterMs: 2000 });
  hb.heartbeat(beat("ai_idle_1"));
  const seen1 = db.prepare("SELECT last_seen_at AS s FROM agent_hosts WHERE agent_id=?")
    .get("ai_idle_1").s;
  advance(60_000);
  hb.notePoll({ agentId: "ai_idle_1" });
  const seen2 = db.prepare("SELECT last_seen_at AS s FROM agent_hosts WHERE agent_id=?")
    .get("ai_idle_1").s;
  assert.ok(seen2 > seen1, `last_seen_at must advance on poll (stayed ${seen1})`);
  assert.equal(hb.statusOf("ai_idle_1").status, "online");
});

test("notePoll revives only the freshest host; long-dead hosts stay dead", t => {
  const { db, hb, advance } = unit(t, { staleAfterMs: 2000 });
  // h_old declares a long cadence so the reaper spares it; without that it
  // would be pruned as stale before the poll — which is also correct.
  hb.heartbeat(beat("ai_multi", "h_old", { cadenceSeconds: 3600 }));
  advance(60_000);
  hb.heartbeat(beat("ai_multi", "h_new"));
  advance(60_000);
  hb.notePoll({ agentId: "ai_multi" });
  const rows = db.prepare(
    "SELECT host_id AS hostId, last_seen_at AS s FROM agent_hosts WHERE agent_id=? ORDER BY hostId")
    .all("ai_multi");
  const old = rows.find(r => r.hostId === "h_old");
  const fresh = rows.find(r => r.hostId === "h_new");
  assert.ok(old, "cadence-protected old host survives the reap");
  assert.ok(fresh.s > old.s, "the freshest host is the one revived by the poll");
});

test("notePoll revive: no duplicate join while believed online; rejoin after announced leave", t => {
  const { hb, advance } = unit(t, { staleAfterMs: 2000 });
  const events = [];
  hb.subscribeDeltas({ onDelta: e => events.push(e.type) });
  hb.heartbeat(beat("ai_revive"));
  advance(5000); // presence expired, but rows not yet reaped
  assert.equal(hb.statusOf("ai_revive").status, "offline");
  // No leave has been announced yet, so the subscriber still believes the
  // agent online: a poll-driven revive is not a duplicate join.
  hb.notePoll({ agentId: "ai_revive" });
  assert.deepEqual(events, ["join"]);
  assert.equal(hb.statusOf("ai_revive").status, "online");
  // After the reaper announces the leave, a fresh heartbeat re-announces.
  advance(5000);
  hb.reapStaleHosts();
  assert.deepEqual(events, ["join", "leave"]);
  hb.heartbeat(beat("ai_revive"));
  assert.deepEqual(events, ["join", "leave", "join"]);
  assert.equal(hb.statusOf("ai_revive").status, "online");
});

// ---- 6. write budget: heartbeat stays constant -------------------------------

test("heartbeat write budget stays constant with subscribers and reaper armed", t => {
  const { db, hb } = unit(t, { staleAfterMs: 2000 });
  hb.subscribeDeltas({ onDelta: () => {} });
  const rawPrepare = db.prepare.bind(db);
  let writes = 0;
  db.prepare = function (sql, ...args) {
    if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) writes++;
    return rawPrepare(sql, ...args);
  };
  const N = 500;
  for (let i = 0; i < N; i++) hb.heartbeat(beat(`ai_b_${i}`));
  db.prepare = rawPrepare;
  assert.ok(writes <= 6 * N, `writes must stay linear: ${writes} for ${N} heartbeats`);
  assert.ok(writes / N <= 6, `writes/heartbeat must stay constant: ${(writes / N).toFixed(2)}`);
});
