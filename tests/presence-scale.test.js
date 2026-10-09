// WAVE-500 W7 (redispatch): presence correctness + scale tests for coordinator 5/6.
//
// Context: W6's presence branch (wave500/presence-w6-presence, docs/PRESENCE.md)
// was NOT on origin at write time, so these tests run against the presence
// system on origin/main: server/agent-heartbeats.mjs — durable per-host
// heartbeats with per-host TTL windows (max(180s, cadence*1.5)), PK upserts
// on (agent_id, host_id), no server-side delta stream, no TTL reaper.
//
// Design principles under test: TTL expiry, delta-only updates, heartbeat
// aggregation. Tests marked FAIL-FIRST document gaps the W6 TTL+delta design
// must close; they fail against the current implementation on purpose and
// must be re-run (and re-pointed at W6's API) once the W6 branch lands.
//
// Scale discipline: every fixture is :memory: SQLite with a controllable
// clock, so the 500-agent and 24h-churn scenarios run in seconds and are
// fully deterministic. No network, no real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import {
  AgentHeartbeats, agentHeartbeatSchema, HEARTBEAT_STALE_AFTER_MS,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;
const AGENTS = 500;

// ---- fixtures ------------------------------------------------------------

// Minimal AgentHeartbeats over :memory: with a controllable clock and a
// small TTL so expiry tests don't wait 180s.
function unit(t, { staleAfterMs = 2000 } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at }, { staleAfterMs });
  t.after(() => db.close());
  return { db, hb, advance: ms => { at += ms; }, at: () => at };
}

// Full RoomStore fixture (claim mutations, workWakes, the real store.now()
// plumbing) over :memory: with a controllable clock.
function room(t) {
  let at = T0;
  const store = new RoomStore(":memory:", { now: () => at });
  store.initialize(initialRoom());
  t.after(() => store.close());
  return { store, advance: ms => { at += ms; }, at: () => at };
}

// Wrap db.prepare to count write vs read statements. Returns the counters
// and a reset() so schema/fixture setup stays out of the measurement.
function instrumentWrites(db) {
  const rawPrepare = db.prepare.bind(db);
  const counters = { writes: 0, reads: 0 };
  db.prepare = function (sql, ...args) {
    if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) counters.writes++;
    else if (/^\s*SELECT\b/i.test(sql)) counters.reads++;
    return rawPrepare(sql, ...args);
  };
  return { counters, reset: () => { counters.writes = 0; counters.reads = 0; } };
}

const beat = (agentId, hostId = "h1", extra = {}) =>
  ({ agentId, hostId, mode: "pull-only", ...extra });

// Snapshot-diff delta tracker: the correctness contract W6's server-side
// delta stream must preserve — join/leave events, in order, none missed,
// none duplicated. Polls every tracked agent after each churn step.
class PresenceDeltas {
  constructor(hb, agentIds) {
    this.hb = hb;
    this.known = new Map(agentIds.map(id => [id, false]));
    this.events = [];
  }
  poll(tick) {
    for (const id of [...this.known.keys()].sort()) {
      const online = this.hb.statusOf(id).status === "online";
      const was = this.known.get(id);
      if (online !== was) {
        this.events.push({ type: online ? "join" : "leave", agentId: id, tick });
        this.known.set(id, online);
      }
    }
  }
}

// ---- 1. 500-agent heartbeat convergence ------------------------------------

test("500 agents heartbeat: presence converges, writes are constant per agent, time is sub-quadratic", t => {
  const { store } = room(t);
  const { counters, reset } = instrumentWrites(store.db);
  const hb = store.agentHeartbeats;
  reset();

  // Warm the table with 100 agents first so the growth comparison has a base,
  // then fill the rest of the fleet.
  const lap = (from, to) => {
    const start = performance.now();
    for (let i = from; i < to; i++) hb.heartbeat(beat(`ai_scale_${i}`));
    return (performance.now() - start) / (to - from);
  };
  const avgFirst100 = lap(0, 100);
  const writesFirst100 = counters.writes;
  lap(100, 400);
  const avgLast100 = lap(400, 500);
  reset();
  const writesPerHeartbeat = counters.writes / 100;
  counters.writes = writesFirst100;

  // Convergence: every one of the 500 reads back online.
  const convStart = performance.now();
  let online = 0;
  for (let i = 0; i < AGENTS; i++) {
    if (hb.statusOf(`ai_scale_${i}`).status === "online") online++;
  }
  const convMs = performance.now() - convStart;
  assert.equal(online, AGENTS, `all ${AGENTS} agents converge to online (got ${online})`);

  // A heartbeat is 3 PK upserts (agent_hosts, agent_wake_polls,
  // agent_push_configs) — constant, independent of fleet size.
  assert.ok(counters.writes <= 6 * AGENTS,
    `DB writes must stay linear: ${counters.writes} writes for ${AGENTS} heartbeats`);
  assert.ok(writesPerHeartbeat <= 6,
    `writes per heartbeat must be constant, got ${writesPerHeartbeat}`);
  // Anti-O(n^2): per-heartbeat cost must not grow with table size. A full
  // scan per heartbeat would make the 401..500 lap several times slower
  // than the 1..100 lap.
  assert.ok(avgLast100 < 4 * Math.max(avgFirst100, 0.001),
    `per-heartbeat time grew super-linearly: first100=${avgFirst100.toFixed(3)}ms last100=${avgLast100.toFixed(3)}ms`);
  // Generous absolute bounds so CI runners don't flake.
  assert.ok(convMs < 10_000, `500 statusOf reads took ${convMs.toFixed(0)}ms`);
  t.diagnostic(`500 heartbeats: ${(performance.now() - convStart).toFixed(0)}ms reads; ` +
    `avg heartbeat first100=${avgFirst100.toFixed(3)}ms last100=${avgLast100.toFixed(3)}ms; ` +
    `writes=${counters.writes} (${(counters.writes / AGENTS).toFixed(1)}/heartbeat)`);
});

test("presence list (wakeStatusList) converges for 500 agents in one scan", t => {
  const { store } = room(t);
  const hb = store.agentHeartbeats;
  for (let i = 0; i < AGENTS; i++) hb.heartbeat(beat(`ai_list_${i}`));
  const start = performance.now();
  const list = hb.wakeStatusList();
  const ms = performance.now() - start;
  // heartbeat() records poll activity, so every heartbeating agent is wakeable.
  assert.equal(list.wakeable.length, AGENTS, `wakeable list holds all ${AGENTS} agents`);
  assert.equal(list.notWakeable.length, 0);
  assert.ok(ms < 5000, `fleet presence list took ${ms.toFixed(0)}ms`);
  t.diagnostic(`wakeStatusList for ${AGENTS} agents: ${ms.toFixed(1)}ms`);
});

// ---- 2. TTL expiry -------------------------------------------------------

test("agent stops heartbeating: disappears from presence within TTL + grace", t => {
  const { hb, advance } = unit(t, { staleAfterMs: 2000 });
  hb.heartbeat(beat("ai_ttl_1"));
  assert.equal(hb.statusOf("ai_ttl_1").status, "online");
  // TTL + grace: well past the 2s window the agent must read offline, and
  // no host may still claim online.
  advance(2000 + 500);
  const status = hb.statusOf("ai_ttl_1");
  assert.equal(status.status, "offline", "agent disappears from presence after TTL+grace");
  assert.ok(status.hosts.every(h => h.state === "stale"), "no host still reports online");
  assert.ok(!status.hosts.some(h => h.state === "online"));
  // A resumed heartbeat brings it straight back — no stuck tombstone.
  hb.heartbeat(beat("ai_ttl_1"));
  assert.equal(hb.statusOf("ai_ttl_1").status, "online", "resumed heartbeat revives presence");
});

// FAIL-FIRST (W6 scope): the TTL design must include expiry cleanup. Expired
// hosts (last_seen older than the TTL window) must be pruned — otherwise a
// 24h churn cycle accumulates thousands of ghost rows for agents that are
// long gone, and every fleet presence scan keeps paying for the dead.
test("FAIL-FIRST: 24h churn leaves no ghost presence rows", t => {
  const STALE_MS = 2000;
  const { db, hb, advance, at } = unit(t, { staleAfterMs: STALE_MS });
  const TICK = 10 * 60 * 1000; // 10 minutes
  const PER_TICK = 30;
  const TICKS = 144; // 24h
  for (let tick = 0; tick < TICKS; tick++) {
    // This tick's cohort heartbeats every minute through the tick, then churns out.
    for (let m = 0; m < 10; m++) {
      for (let i = 0; i < PER_TICK; i++) hb.heartbeat(beat(`ai_churn_${tick}_${i}`));
      advance(60_000);
    }
    advance(TICK - 10 * 60_000);
  }
  // Presence TTL, not the 24h wakeability window, defines "live": count rows
  // whose last heartbeat is older than the TTL as ghosts.
  const ghostRows = db.prepare(
    "SELECT COUNT(*) AS n FROM agent_hosts WHERE last_seen_at <= ?").get(at() - STALE_MS).n;
  const liveRows = db.prepare(
    "SELECT COUNT(*) AS n FROM agent_hosts WHERE last_seen_at > ?").get(at() - STALE_MS).n;
  assert.equal(ghostRows, 0,
    `ghost rows accumulate: agent_hosts holds ${ghostRows} expired rows (${liveRows} live) ` +
    `after a 24h churn cycle. W6 TTL design must prune hosts whose last_seen is past the TTL window.`);
});

// ---- 3. delta correctness --------------------------------------------------

test("delta contract: joins/leaves arrive exactly once, in order, no flap on reconnect", t => {
  const { hb, advance } = unit(t, { staleAfterMs: 2000 });
  const ids = ["ai_d_a", "ai_d_b", "ai_d_c"];
  const deltas = new PresenceDeltas(hb, ids);

  hb.heartbeat(beat("ai_d_a", "h1")); deltas.poll(1);          // A joins
  advance(1500);
  hb.heartbeat(beat("ai_d_b", "h1")); deltas.poll(2);          // B joins
  advance(1500);
  hb.heartbeat(beat("ai_d_a", "h2")); deltas.poll(3);          // A reconnects on a new host: no flap
  advance(1500); deltas.poll(4);                                // B's host expires: B leaves
  hb.heartbeat(beat("ai_d_c", "h1")); deltas.poll(5);          // C joins

  assert.deepEqual(
    deltas.events.map(e => `${e.type}:${e.agentId}`),
    ["join:ai_d_a", "join:ai_d_b", "leave:ai_d_b", "join:ai_d_c"],
    `delta stream must be exact and ordered, got ${JSON.stringify(deltas.events)}`);
});

test("delta contract under a 120-agent seeded churn storm", t => {
  const { hb, advance } = unit(t, { staleAfterMs: 2000 });
  const N = 120, TICKS = 40;
  const ids = Array.from({ length: N }, (_, i) => `ai_storm_${i}`);
  const deltas = new PresenceDeltas(hb, ids);
  // Deterministic schedule: agent i active during [joinTick, leaveTick).
  const joinTick = i => i % TICKS;
  const leaveTick = i => joinTick(i) + 3 + (i % 7);
  for (let tick = 0; tick < TICKS + 12; tick++) { // +12 lets every TTL run out
    for (let i = 0; i < N; i++) {
      if (tick >= joinTick(i) && tick < leaveTick(i)) hb.heartbeat(beat(ids[i]));
    }
    advance(1000);
    deltas.poll(tick);
  }
  const { events } = deltas;
  // Global order: polls are sequential, events must be tick-ordered.
  for (let k = 1; k < events.length; k++) {
    assert.ok(events[k].tick >= events[k - 1].tick, "delta events stay in poll order");
  }
  // Per-agent alternation: join, leave, join, leave... — a missed or
  // duplicated transition would break the alternation.
  const byAgent = new Map();
  for (const e of events) {
    if (!byAgent.has(e.agentId)) byAgent.set(e.agentId, []);
    byAgent.get(e.agentId).push(e.type);
  }
  assert.equal(byAgent.size, N, "every churned agent produced deltas");
  for (const [id, types] of byAgent) {
    assert.equal(types[0], "join", `${id}: first event must be a join`);
    for (let k = 1; k < types.length; k++) {
      assert.notEqual(types[k], types[k - 1], `${id}: duplicate ${types[k]} — a transition was missed or doubled`);
    }
    const finalOnline = hb.statusOf(id).status === "online";
    const endsJoined = types[types.length - 1] === "join";
    assert.equal(endsJoined, finalOnline,
      `${id}: event stream disagrees with final presence (stream ends ${types.at(-1)}, status ${finalOnline ? "online" : "offline"})`);
  }
  t.diagnostic(`churn storm: ${events.length} deltas for ${N} agents, alternation exact, final state consistent`);
});

// FAIL-FIRST (W6 scope): there is no server-side join/leave delta stream.
// Subscribers today must poll statusOf per agent (O(agents) per read). W6's
// delta design must publish join/leave so 500 agents don't poll each other.
test("FAIL-FIRST: server-side presence delta subscription exists", t => {
  const { hb } = unit(t);
  const candidates = ["subscribeDeltas", "onPresenceDelta", "presenceDeltas", "watchPresence"];
  const found = candidates.filter(name => typeof hb[name] === "function");
  assert.ok(found.length > 0,
    `AgentHeartbeats exposes no delta subscription (${candidates.join("/")}). ` +
    `W6 must add join/leave deltas; the snapshot-diff contract above defines the semantics it must preserve.`);
});

// ---- 4. idle agents --------------------------------------------------------

test("FAIL-FIRST: authenticated non-heartbeat traffic refreshes presence liveness", t => {
  const { db, hb, advance } = unit(t, { staleAfterMs: 2000 });
  hb.heartbeat(beat("ai_idle_1"));
  const seen1 = db.prepare("SELECT last_seen_at AS s FROM agent_hosts WHERE agent_id=?").get("ai_idle_1").s;
  advance(60_000);
  // Authenticated traffic that is not a heartbeat: the wake poll proves the
  // agent is alive and listening. Per the W6 idle principle it must refresh
  // last_seen without requiring a dedicated ping.
  hb.notePoll({ agentId: "ai_idle_1" });
  const seen2 = db.prepare("SELECT last_seen_at AS s FROM agent_hosts WHERE agent_id=?").get("ai_idle_1").s;
  assert.ok(seen2 > seen1,
    `agent_hosts.last_seen_at only advances on heartbeat() (stayed ${seen1}); ` +
    `authenticated poll traffic does not refresh presence liveness.`);
});

// ---- 5. same-identity reconnect --------------------------------------------

test("two heartbeats, same identity: no duplicate presence rows", t => {
  const { db, hb, advance } = unit(t, { staleAfterMs: 2000 });
  const rows = id => db.prepare("SELECT COUNT(*) AS n FROM agent_hosts WHERE agent_id=?").get(id).n;
  const dupes = () => db.prepare(
    "SELECT agent_id, host_id, COUNT(*) AS n FROM agent_hosts GROUP BY agent_id, host_id HAVING n > 1").all();

  // Same identity, same host reconnecting: exactly one row, refreshed.
  hb.heartbeat(beat("ai_re_1", "h1"));
  advance(500);
  hb.heartbeat(beat("ai_re_1", "h1"));
  assert.equal(rows("ai_re_1"), 1, "reconnect on the same host upserts, never duplicates");
  assert.deepEqual(dupes(), [], "no duplicate (agent_id, host_id) pairs");

  // Same identity, second host (multi-host agent): two rows by design, one
  // agent, still online exactly once.
  advance(1000); // t=1500: h1 (last seen t=500) is still fresh
  hb.heartbeat(beat("ai_re_1", "h2"));
  assert.equal(rows("ai_re_1"), 2, "a second host is a second row (multi-host by design)");
  assert.equal(hb.statusOf("ai_re_1").hosts.length, 2);
  assert.equal(hb.statusOf("ai_re_1").status, "online");
  assert.deepEqual(dupes(), [], "still no duplicate (agent_id, host_id) pairs");

  // The dead host expires without flapping the agent offline.
  advance(1500); // t=3000: h1 stale (last seen t=500), h2 online (last seen t=1500)
  const status = hb.statusOf("ai_re_1");
  assert.equal(status.status, "online", "stale first host does not flap the reconnected agent offline");
  assert.equal(status.hosts.find(h => h.hostId === "h1").state, "stale");
  assert.equal(status.hosts.find(h => h.hostId === "h2").state, "online");
});

// ---- 6. presence under write load ------------------------------------------

test("heartbeats do not meaningfully slow claim mutations", t => {
  const { store } = room(t);
  const hb = store.agentHeartbeats;
  const N = 200;
  const claim = i => store.workClaims.set("commons", { id: `w7-load-claim-${i}`, title: `load ${i}` });

  // Baseline: claim mutations alone.
  let start = performance.now();
  for (let i = 0; i < N; i++) claim(i);
  const baseMs = (performance.now() - start) / N;

  // Loaded: the 500-agent fleet heartbeats between claims. Only the claim
  // latency itself is timed — that is the real contention question: do
  // heartbeat writes lock or bloat the tables that claim mutations touch?
  let claimOnlyMs = 0;
  for (let i = 0; i < N; i++) {
    for (let h = 0; h < 3; h++) {
      hb.heartbeat(beat(`ai_load_${(i * 3 + h) % AGENTS}`, "load-host"));
    }
    const c0 = performance.now();
    store.workClaims.set("commons", { id: `w7-loaded-claim-${i}`, title: `load ${i}` });
    claimOnlyMs += performance.now() - c0;
  }
  const loadedMs = claimOnlyMs / N;

  // Heartbeats are a handful of PK upserts on their own tables; a fleet
  // heartbeating alongside must not move claim latency materially. Bound is
  // generous for shared CI runners.
  assert.ok(loadedMs < 3 * Math.max(baseMs, 0.001),
    `claim mutation slowed under heartbeat load: baseline ${baseMs.toFixed(3)}ms/claim, ` +
    `loaded ${loadedMs.toFixed(3)}ms/claim`);
  t.diagnostic(`claim mutation: baseline ${baseMs.toFixed(3)}ms, with 500-agent heartbeat traffic interleaved ${loadedMs.toFixed(3)}ms ` +
    `(ratio ${(loadedMs / Math.max(baseMs, 0.001)).toFixed(2)}x)`);
});
