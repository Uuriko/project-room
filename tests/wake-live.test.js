// plan-wake-live: wake follows the agent.
// - lastPolledAt recorded durably per agent on poll AND heartbeat activity.
// - wakeable = polled/heartbeated within 24h (WAKEABLE_WINDOW_MS), a
//   deliberately wider window than the 180s host-presence window.
// - GET /api/wake-status exposes the wakeable list and the not-wakeable
//   list; ?agentId= checks one agent (data side for the COMMS-02
//   mention-target-warning surface).
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
// 5. HTTP surface — contract: GET /api/wake-status returns the lists
//    with windowMs; ?agentId= returns one status; unauthenticated is 401.
//    Regression: route miswiring or scope drift on the new path.
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

test("GET /api/wake-status exposes the wakeable and not-wakeable lists", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const live = await keyedAgent(f, origin, "wake-live-agent");
  const idle = await keyedAgent(f, origin, "wake-idle-agent");

  await post(origin, "/api/agent-heartbeats", { hostId: "h" }, idle.credential);
  await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", idle.credential);
  at += WAKEABLE_WINDOW_MS + 1000; // the idle agent's poll goes stale

  await post(origin, "/api/agent-heartbeats", { hostId: "h" }, live.credential);
  await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", live.credential);

  const doc = await (await get(origin, "/api/wake-status", live.credential)).json();
  assert.equal(doc.windowMs, WAKEABLE_WINDOW_MS);
  assert.ok(doc.wakeable.some(e => e.agentId === live.identity.identityId), "live agent is wakeable");
  assert.ok(doc.notWakeable.some(e => e.agentId === idle.identity.identityId), "idle agent is not wakeable");

  // Single-agent lookup: the consumption point for the COMMS-02 warning.
  const one = await (await get(origin, `/api/wake-status?agentId=${idle.identity.identityId}`, live.credential)).json();
  assert.equal(one.agentId, idle.identity.identityId);
  assert.equal(one.wakeable, false);

  assert.equal((await get(origin, "/api/wake-status")).status, 401, "unauthenticated is refused");
});
