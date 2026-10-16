// plan-wake-live: wake follows the agent.
// - lastPolledAt recorded durably per agent on poll AND heartbeat activity.
// - wakeable = polled/heartbeated within the agent's wakeability window:
//   24h (WAKEABLE_WINDOW_MS), widened past a slower declared poll cadence
//   (issue #3592) — a deliberately wider window than the 180s host-presence
//   window.
// - GET /api/wake-status answers "who is actually listening", scoped to the
//   caller and their rooms: no params returns your own wakeability;
//   ?roomId= returns that room's wakeable / not-wakeable member lists
//   (membership required — Instinct-3 review: no global agent list). The
//   exact server-side methods remain the data side for the COMMS-02
//   mention-target-warning surface.
//
// Authoring gate (repo test-audit):
// 1. lastPolledAt recording — contract: notePoll()/heartbeat() durably
//    stamp the agent's poll time. Regression: a refactor of notePoll that
//    drops the write silently reopens the audit gap (every idle agent
//    looks wakeable). Existing coverage: agent-heartbeats.test.js and
//    agent-wake-poll.test.js cover presence and signals; nothing asserts
//    a poll timestamp exists at all.
// 2. 24h wakeable boundary — contract: wakeable flips at exactly
//    WAKEABLE_WINDOW_MS, not at the 180s presence window. Regression: an
//    edit that reuses HEARTBEAT_STALE_AFTER_MS for wakeability marks
//    actively-polling hosts not-wakeable after 3 minutes.
// 3. legacy rows — contract: host rows from before agent_wake_polls
//    existed read as not wakeable (null), never crash. Regression: a
//    NOT NULL assumption or inner join hiding pre-migration agents.
// 4. list partition — contract: wakeStatusList splits every registered
//    agent into wakeable / notWakeable. Regression: the endpoint
//    returning only one side, or dropping agents.
// 5. HTTP surface — contract: GET /api/wake-status returns the caller's
//    own { agentId, wakeable, windowMs }; ?roomId= returns that room's
//    { roomId, windowMs, asOf, wakeable, notWakeable } (member-only; a
//    non-member gets 403); unauthenticated is 401; exact poll timestamps
//    are never served. Regression: route miswiring, scope drift on the
//    new path, or a global agent list leaking presence to any
//    heartbeats:read credential.
// 6. cadence-aware window (issue #3592) — contract: an agent whose hosts
//    declare a poll cadence slower than 16h is judged against cadence x
//    1.5, not the flat 24h; cadences up to 16h and undeclared agents keep
//    exactly the 24h window. All three read surfaces (wakeStatusOf,
//    wakeStatusList, wakeStatusListForRoom) share the one computation.
//    Regression: restoring the flat WAKEABLE_WINDOW_MS comparison in any
//    surface marks a healthy 48h-cadence agent not wakeable for half of
//    every cycle — the mention warning cries wolf and push targeting
//    built on these lists skips a listener that is checking in exactly
//    as configured.
//
// Synthetic fixtures only — loopback HTTP, no external calls or real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import {
  AgentHeartbeats,
  agentHeartbeatSchema,
  WAKEABLE_WINDOW_MS,
  HEARTBEAT_STALE_AFTER_MS,
} from "../server/agent-heartbeats.mjs";
import { WAKE_STATUS_ROUTES } from "../server/routes/wake-status.mjs";
import { assertRouteRow } from "../server/routes/table.mjs";
import { PURGE_TABLES } from "../server/purge-registry.mjs";

const T0 = 1_750_000_000_000;

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at });
  t.after(() => db.close());
  return { db, hb, advance: ms => { at += ms; }, at: () => at };
}

// The wakeable window is its own constant: 24h, not the 180s presence window.
assert.equal(WAKEABLE_WINDOW_MS, 24 * 60 * 60 * 1000);
assert.ok(WAKEABLE_WINDOW_MS > HEARTBEAT_STALE_AFTER_MS);

test("notePoll records lastPolledAt; agent is wakeable inside 24h", t => {
  const { hb, advance, at } = unit(t);
  hb.heartbeat({ agentId: "ai_live", hostId: "h" });
  advance(60_000);
  hb.notePoll({ agentId: "ai_live" });
  const s = hb.wakeStatusOf("ai_live");
  assert.equal(s.agentId, "ai_live");
  assert.equal(s.lastPolledAt, at());
  assert.equal(s.wakeable, true);
  assert.equal(s.windowMs, WAKEABLE_WINDOW_MS);
});

test("heartbeat activity records lastPolledAt even without a poll", t => {
  const { hb, at } = unit(t);
  hb.heartbeat({ agentId: "ai_beater", hostId: "h" });
  const s = hb.wakeStatusOf("ai_beater");
  assert.equal(s.lastPolledAt, at());
  assert.equal(s.wakeable, true);
});

test("wakeable flips at the 24h boundary, not the 180s presence window", t => {
  const { hb, advance } = unit(t);
  hb.heartbeat({ agentId: "ai_edge", hostId: "h" });
  hb.notePoll({ agentId: "ai_edge" });
  advance(WAKEABLE_WINDOW_MS - 1);
  assert.equal(hb.wakeStatusOf("ai_edge").wakeable, true, "still wakeable just inside 24h");
  advance(2);
  const s = hb.wakeStatusOf("ai_edge");
  assert.equal(s.wakeable, false, "not wakeable just past 24h");
  assert.equal(s.lastPolledAt, T0, "the stale stamp is preserved");
});

test("pre-migration host rows with no poll record read as not wakeable", t => {
  const { db, hb } = unit(t);
  db.prepare(`INSERT INTO agent_hosts
    (agent_id, host_id, mode, wake_url, last_seen_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`).run("ai_legacy", "h", "wakeable", null, T0, T0, T0);
  const s = hb.wakeStatusOf("ai_legacy");
  assert.equal(s.lastPolledAt, null);
  assert.equal(s.wakeable, false);
  const list = hb.wakeStatusList();
  assert.deepEqual(list.wakeable, []);
  assert.equal(list.notWakeable.length, 1);
  assert.equal(list.notWakeable[0].agentId, "ai_legacy");
});

test("wakeStatusList partitions registered agents into wakeable and notWakeable", t => {
  const { hb, advance } = unit(t);
  hb.heartbeat({ agentId: "ai_idle", hostId: "h" });
  advance(WAKEABLE_WINDOW_MS + 1);
  hb.heartbeat({ agentId: "ai_live", hostId: "h" });
  hb.notePoll({ agentId: "ai_live" });
  const list = hb.wakeStatusList();
  assert.equal(list.windowMs, WAKEABLE_WINDOW_MS);
  assert.deepEqual(list.wakeable.map(e => e.agentId), ["ai_live"]);
  assert.deepEqual(list.notWakeable.map(e => e.agentId), ["ai_idle"]);
  assert.equal(typeof list.wakeable[0].lastPolledAt, "number");
  assert.equal(typeof list.notWakeable[0].lastPolledAt, "number");
});

const HOUR_MS = 3600 * 1000;

test("a 48h-cadence agent stays wakeable across its whole cycle (issue #3592)", t => {
  const { hb, advance } = unit(t);
  hb.heartbeat({ agentId: "ai_slow", hostId: "h", cadenceSeconds: 48 * 3600 });
  const s0 = hb.wakeStatusOf("ai_slow");
  assert.equal(s0.windowMs, 72 * HOUR_MS, "window is the declared cadence plus half a cadence of grace");
  advance(36 * HOUR_MS); // mid-cycle — past the flat 24h the old rule used
  assert.equal(hb.wakeStatusOf("ai_slow").wakeable, true, "still wakeable mid-cycle");
  advance(36 * HOUR_MS - 1); // 72h - 1ms after the stamp
  assert.equal(hb.wakeStatusOf("ai_slow").wakeable, true, "wakeable just inside the widened window");
  advance(2);
  assert.equal(hb.wakeStatusOf("ai_slow").wakeable, false, "not wakeable past cadence + grace");
});

test("the maximum 7d cadence widens the window to 10.5 days (issue #3592)", t => {
  const { hb, advance } = unit(t);
  hb.heartbeat({ agentId: "ai_weekly", hostId: "h", cadenceSeconds: 7 * 24 * 3600 });
  assert.equal(hb.wakeStatusOf("ai_weekly").windowMs, 10.5 * 24 * HOUR_MS);
  advance(7 * 24 * HOUR_MS); // one full declared cycle after the stamp
  assert.equal(hb.wakeStatusOf("ai_weekly").wakeable, true, "wakeable a full cycle later");
  advance(3.5 * 24 * HOUR_MS + 1); // past cadence + grace
  assert.equal(hb.wakeStatusOf("ai_weekly").wakeable, false, "not wakeable past 10.5 days");
});

test("declared everyday cadences keep exactly the 24h window (issue #3592)", t => {
  const { hb, advance } = unit(t);
  hb.heartbeat({ agentId: "ai_five_min", hostId: "h", cadenceSeconds: 300 });
  assert.equal(hb.wakeStatusOf("ai_five_min").windowMs, WAKEABLE_WINDOW_MS,
    "a 300s declaration does not move the window");
  hb.heartbeat({ agentId: "ai_16h", hostId: "h", cadenceSeconds: 16 * 3600 });
  assert.equal(hb.wakeStatusOf("ai_16h").windowMs, WAKEABLE_WINDOW_MS,
    "16h x 1.5 is exactly the 24h base — the widest cadence that changes nothing");
  advance(WAKEABLE_WINDOW_MS - 1);
  assert.equal(hb.wakeStatusOf("ai_five_min").wakeable, true, "still wakeable just inside 24h");
  advance(2);
  assert.equal(hb.wakeStatusOf("ai_five_min").wakeable, false, "flips at exactly 24h, as before");
});

test("the slowest declared cadence across an agent's hosts governs (issue #3592)", t => {
  const { hb, advance } = unit(t);
  hb.heartbeat({ agentId: "ai_two", hostId: "fast", cadenceSeconds: 300 });
  hb.heartbeat({ agentId: "ai_two", hostId: "slow", cadenceSeconds: 48 * 3600 });
  assert.equal(hb.wakeStatusOf("ai_two").windowMs, 72 * HOUR_MS,
    "poll stamps are per agent, so the slowest host declaration sets the window");
  advance(36 * HOUR_MS);
  assert.equal(hb.wakeStatusOf("ai_two").wakeable, true);
});

test("wakeStatusList judges each agent by its own cadence-aware window (issue #3592)", t => {
  const { hb, advance } = unit(t);
  hb.heartbeat({ agentId: "ai_slow", hostId: "h", cadenceSeconds: 48 * 3600 });
  hb.heartbeat({ agentId: "ai_plain", hostId: "h" });
  advance(36 * HOUR_MS); // both stamps are 36h old
  const list = hb.wakeStatusList();
  assert.equal(list.windowMs, WAKEABLE_WINDOW_MS, "list-level windowMs stays the base window");
  assert.deepEqual(list.wakeable.map(e => e.agentId), ["ai_slow"],
    "the 48h-cadence agent is wakeable at 36h");
  assert.deepEqual(list.notWakeable.map(e => e.agentId), ["ai_plain"],
    "the undeclared agent is judged by the flat 24h, unchanged");
});

test("wakeStatusListForRoom applies the cadence-aware window to room-scoped activity (issue #3592)", t => {
  const { hb, advance, at } = unit(t);
  hb.heartbeat({ agentId: "ai_slow", hostId: "h", cadenceSeconds: 48 * 3600 });
  advance(60 * HOUR_MS);
  hb.recordPollActivity("ai_slow", at(), "room-a"); // scoped listening, 60h in
  advance(36 * HOUR_MS);
  // The identity stamp is now 96h old — past even the widened 72h window;
  // the room-a stamp is 36h old — inside it. Only the room path can
  // qualify the agent, and only for room-a.
  const roomA = hb.wakeStatusListForRoom("room-a");
  assert.ok(roomA.wakeable.some(e => e.agentId === "ai_slow"),
    "room-scoped listening on a 48h cadence counts for its room at 36h");
  const roomB = hb.wakeStatusListForRoom("room-b");
  assert.ok(!roomB.wakeable.some(e => e.agentId === "ai_slow"),
    "the same activity never leaks into another room");
});

test("wake-statusOf an unknown agent is not wakeable with null lastPolledAt", t => {
  const { hb } = unit(t);
  const s = hb.wakeStatusOf("ai_nobody");
  assert.equal(s.wakeable, false);
  assert.equal(s.lastPolledAt, null);
});

test("wake-status route-table row is well-formed", () => {
  // Contract: the row carries every field the table validator requires.
  // Regression: a bad rebase dropping a required field (caught here at
  // the owning boundary, and by assertRouteTable at boot).
  assert.equal(WAKE_STATUS_ROUTES.length, 1);
  const [row] = WAKE_STATUS_ROUTES;
  assert.deepEqual(assertRouteRow(row), []);
  assert.equal(row.id, "wake-status");
  assert.equal(row.method, "GET");
  assert.equal(row.path, "/api/wake-status");
  assert.equal(typeof row.handler, "function");
});

test("agent_wake_polls is registered for identity purge", () => {
  // Contract: purging an identity deletes its poll-activity row — no
  // orphaned per-identity rows. Regression: the table shipped without a
  // purge entry (Instinct-3 review on PR #1565). The operator-purge suite
  // only scans room_id/identity_id/account_id columns, and this table is
  // keyed by agent_id, so the registration needs its own pin.
  const entry = PURGE_TABLES.find(e => e.table === "agent_wake_polls");
  assert.ok(entry, "purge registry covers agent_wake_polls");
  assert.equal(entry.action, "delete");
  assert.deepEqual(entry.match.identity, ["agent_id"]);
});

// ---- HTTP integration ----

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

async function keyedAgent(f, origin, name) {
  const identity = f.store.identities.create(name);
  const scoped = await (await post(origin, "/api/agent-keys",
    { scopes: ["heartbeats:report", "heartbeats:read"] }, identity.secret)).json();
  return { identity, credential: scoped.credential };
}

test("GET /api/wake-status returns the caller's own wakeability", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const live = await keyedAgent(f, origin, "wake-live-agent");

  await post(origin, "/api/agent-heartbeats", { hostId: "h" }, live.credential);
  await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", live.credential);

  const doc = await (await get(origin, "/api/wake-status", live.credential)).json();
  assert.equal(doc.agentId, live.identity.identityId);
  assert.equal(doc.wakeable, true);
  assert.equal(doc.windowMs, WAKEABLE_WINDOW_MS);
  assert.ok(!("lastPolledAt" in doc), "no exact poll timestamp is served");

  // The poll goes stale: caller-only mode reads not-wakeable with no timestamp.
  at += WAKEABLE_WINDOW_MS + 1000;
  const stale = await (await get(origin, "/api/wake-status", live.credential)).json();
  assert.equal(stale.wakeable, false);
  assert.ok(!("lastPolledAt" in stale));

  assert.equal((await get(origin, "/api/wake-status")).status, 401, "unauthenticated is refused");
});

test("GET /api/wake-status?roomId= lists the room's wakeable and not-wakeable members", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const live = await keyedAgent(f, origin, "wake-live-agent");
  const idle = await keyedAgent(f, origin, "wake-idle-agent");
  const never = await keyedAgent(f, origin, "wake-never-agent");
  const outsider = await keyedAgent(f, origin, "wake-outsider-agent");
  for (const [i, a] of [live, idle, never].entries()) {
    f.store.identities.link(f.keys.owner, "commons", {
      identityId: a.identity.identityId, memberId: a.identity.identityId,
      displayName: `wake test ${i}`, permissions: ["write_external"],
    });
  }

  await post(origin, "/api/agent-heartbeats", { hostId: "h" }, idle.credential);
  await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", idle.credential);
  at += WAKEABLE_WINDOW_MS + 1000; // the idle agent's poll goes stale

  await post(origin, "/api/agent-heartbeats", { hostId: "h" }, live.credential);
  await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", live.credential);

  const doc = await (await get(origin, "/api/wake-status?roomId=commons", live.credential)).json();
  assert.equal(doc.roomId, "commons");
  assert.equal(doc.windowMs, WAKEABLE_WINDOW_MS);
  assert.ok(doc.wakeable.some(e => e.agentId === live.identity.identityId), "live agent is wakeable");
  assert.ok(doc.notWakeable.some(e => e.agentId === idle.identity.identityId), "idle agent is not wakeable");
  assert.ok(doc.notWakeable.some(e => e.agentId === never.identity.identityId),
    "a member who never registered a host is not wakeable either");
  assert.ok(![...doc.wakeable, ...doc.notWakeable].some(e => e.agentId === outsider.identity.identityId),
    "non-members never appear");
  // Instinct-3 review (PR #1565): the HTTP surface coarsens — exact poll
  // timestamps never leave the server (activity fingerprinting).
  for (const e of [...doc.wakeable, ...doc.notWakeable]) {
    assert.ok(!("lastPolledAt" in e), "no exact poll timestamps are served");
    assert.equal(typeof e.wakeable, "boolean");
  }

  // Room-scoped, membership-required: an outsider cannot read the list.
  assert.equal(
    (await get(origin, "/api/wake-status?roomId=commons", outsider.credential)).status, 403,
    "non-member is refused");
});

test("wakeStatusOf on a DB without agent_wake_polls reads as not wakeable, never crashes", t => {
  // Regression: wakeStatusList fail-closes to not-wakeable when the table is
  // missing (pre-migration read-only file), but wakeStatusOf threw
  // "no such table: agent_wake_polls" — the caller-mode GET /api/wake-status
  // would 500 where the contract promises "not wakeable, never an error".
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  db.exec("DROP TABLE agent_wake_polls");
  t.after(() => db.close());
  const hb = new AgentHeartbeats({ db, now: () => T0 });
  const s = hb.wakeStatusOf("ai_legacy");
  assert.equal(s.lastPolledAt, null);
  assert.equal(s.wakeable, false);
});

test("wakeStatusList on a DB without agent_wake_polls lists everyone as not wakeable, never crashes", t => {
  // Regression pin: wakeStatusOf's pre-migration fail-close mirrors this
  // list path — the DROP-TABLE fallback here must never be refactored away
  // silently (a thrown "no such table" would 500 ?roomId= the same way the
  // unfixed wakeStatusOf 500'd the caller-mode GET /api/wake-status).
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  db.prepare(`INSERT INTO agent_hosts
    (agent_id, host_id, mode, wake_url, last_seen_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`).run("ai_legacy", "h", "wakeable", null, T0, T0, T0);
  db.exec("DROP TABLE agent_wake_polls");
  t.after(() => db.close());
  const hb = new AgentHeartbeats({ db, now: () => T0 });
  const list = hb.wakeStatusList();
  assert.deepEqual(list.wakeable, []);
  assert.equal(list.notWakeable.length, 1);
  assert.equal(list.notWakeable[0].agentId, "ai_legacy");
  assert.equal(list.notWakeable[0].lastPolledAt, null);
});

test("notePoll on a DB without agent_wake_polls still serves pending wakes, never crashes", t => {
  // Challenger ch-2089: PR #2089 fail-closed wakeStatusOf for the
  // pre-migration read-only DB, but notePoll — the GET /api/agent-wakes/poll
  // read path — still threw "no such table: agent_wake_polls" from the
  // unguarded recordPollActivity INSERT, 500ing the agent's wake long-poll.
  // Contract: the poll read serves; only the listener-evidence stamp is
  // best-effort when its table is absent.
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  db.exec("DROP TABLE agent_wake_polls");
  t.after(() => db.close());
  db.prepare(`INSERT INTO agent_hosts
    (agent_id, host_id, mode, wake_url, last_seen_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`).run("ai_legacy", "h", "wakeable", null, T0, T0, T0);
  const hb = new AgentHeartbeats({ db, now: () => T0 });
  // A queued signal must still be delivered even though the stamp is skipped.
  hb.enqueueWake({ agentId: "ai_legacy", kind: "mention", messageId: "m1" });
  const poll = hb.notePoll({ agentId: "ai_legacy" });
  assert.equal(poll.registered, true);
  assert.equal(poll.pendingWakes.length, 1);
  assert.equal(poll.pendingWakes[0].messageId, "m1");
});

test("notePoll on a DB without any heartbeat tables reads as unregistered, never crashes", t => {
  // Pre-heartbeat database (read-only never migrates): no host ever
  // reported, so the poll refuses the agent the same way it refuses an
  // unknown agent — 404 agent_not_registered at the route, never a 500.
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const hb = new AgentHeartbeats({ db, now: () => T0 });
  const poll = hb.notePoll({ agentId: "ai_legacy" });
  assert.equal(poll.registered, false);
  assert.deepEqual(poll.pendingWakes, []);
});

test("statusOf on a DB without any heartbeat tables reads as unregistered, never crashes", t => {
  // presenceForCard documents "returns null when the heartbeat tables are
  // absent (read-only on an older database)" — statusOf threw
  // "no such table: agent_hosts" instead of reading unregistered.
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const hb = new AgentHeartbeats({ db, now: () => T0 });
  const s = hb.statusOf("ai_legacy");
  assert.equal(s.status, "unregistered");
  assert.equal(s.lastSeenAt, null);
  assert.deepEqual(s.hosts, []);
});

test("wakeability on a DB without agent_push_configs reads the base window, never crashes", t => {
  // Issue #3592: the cadence readers behind the wakeability window are
  // missing-table tolerant like every other read path — a database from
  // before agent_push_configs existed (read-only opens never migrate)
  // reads as no declarations: the flat 24h window, exactly as before.
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  db.exec("DROP TABLE agent_push_configs");
  t.after(() => db.close());
  db.prepare(`INSERT INTO agent_hosts
    (agent_id, host_id, mode, wake_url, last_seen_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?)`).run("ai_legacy", "h", "wakeable", null, T0, T0, T0);
  db.prepare("INSERT INTO agent_wake_polls (agent_id, last_polled_at) VALUES (?,?)")
    .run("ai_legacy", T0);
  const hb = new AgentHeartbeats({ db, now: () => T0 });
  const s = hb.wakeStatusOf("ai_legacy");
  assert.equal(s.windowMs, WAKEABLE_WINDOW_MS);
  assert.equal(s.wakeable, true);
  const list = hb.wakeStatusList();
  assert.deepEqual(list.wakeable.map(e => e.agentId), ["ai_legacy"]);
});

test("wakeStatusList on a DB without any heartbeat tables lists nobody, never crashes", t => {
  // The DROP-TABLE fallback assumed agent_hosts exists; on a pre-heartbeat
  // database it threw "no such table: agent_hosts", 500ing room-mode
  // GET /api/wake-status the same way the unfixed wakeStatusOf 500'd
  // caller-mode.
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const hb = new AgentHeartbeats({ db, now: () => T0 });
  const list = hb.wakeStatusList();
  assert.deepEqual(list.wakeable, []);
  assert.deepEqual(list.notWakeable, []);
});
