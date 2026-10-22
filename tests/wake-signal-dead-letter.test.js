// MIG-WAKE spec S5 — mention-signal TTL + dead-letter.
//
// Contract: a wake signal left unacknowledged past WAKE_SIGNAL_TTL_MS
// (7 days, matching the bridge client's seen-state prune) leaves the
// pending queue for a terminal dead state: no door may serve or claim it
// again, and the owner can enumerate the dead stock — kind, room, age —
// on the wake-status surface instead of it pending forever, invisible.
// A signal acked inside the TTL is untouched; a late ack of a dead
// signal still records delivery and clears it from the dead list (the
// ack is the handling record; the dead list shows dead AND unhandled).
//
// Regression classes pinned here: expiry implemented as a delete (the
// dead stock must stay enumerable), expiry on the poll door only (the
// listener claim door must refuse dead stock too), acked stock swept
// into the dead list by an over-broad UPDATE, and deployed databases
// without the dead_at column failing verifySchema instead of
// converging row-preserving like the #2913 rebuild.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import * as heartbeatsModule from "../server/agent-heartbeats.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const { AgentHeartbeats, agentHeartbeatSchema, convergeWakeSignalRoomScope } = heartbeatsModule;
const WAKE_SIGNAL_TTL_MS = heartbeatsModule.WAKE_SIGNAL_TTL_MS;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const T0 = 1_750_000_000_000;
const AGENT = "ai_testagent";

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at, transaction: fn => { db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } } });
  t.after(() => db.close());
  return { hb, db, advance: ms => { at += ms; }, at: () => at };
}

const register = hb => hb.heartbeat({ agentId: AGENT, hostId: "host-1", mode: "pull-only" });

test("the TTL constant is seven days", () => {
  assert.equal(WAKE_SIGNAL_TTL_MS, SEVEN_DAYS_MS);
});

test("an unacked signal past the TTL dead-letters: unwakeable on the poll door, enumerable by the owner", t => {
  const { hb, db, advance } = unit(t);
  register(hb);
  const { signal } = hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: "room-a", messageId: "m-old" });
  advance(SEVEN_DAYS_MS + 1);
  // The pending read itself performs the expiry: the signal is never served again.
  assert.deepEqual(hb.pendingWakes(AGENT), [], "expired signal is not wakeable");
  const dead = hb.deadLettersOf(AGENT);
  assert.equal(dead.total, 1);
  assert.equal(dead.signals.length, 1);
  const entry = dead.signals[0];
  assert.equal(entry.signalId, signal.signalId);
  assert.equal(entry.kind, "mention");
  assert.equal(entry.roomId, "room-a");
  assert.equal(entry.messageId, "m-old");
  assert.equal(entry.createdAt, T0);
  assert.equal(entry.deadAt, T0 + SEVEN_DAYS_MS + 1);
  assert.ok(entry.ageMs >= SEVEN_DAYS_MS, "the dead-letter entry carries the signal's age");
  const row = db.prepare("SELECT delivered_at, dead_at FROM agent_wake_signals WHERE signal_id=?").get(signal.signalId);
  assert.equal(row.delivered_at, null, "dead-lettering is not an ack");
  assert.equal(row.dead_at, T0 + SEVEN_DAYS_MS + 1, "the row carries the terminal stamp, not a delete");
});

test("a signal acked inside the TTL is unaffected by expiry", t => {
  const { hb, advance } = unit(t);
  register(hb);
  const { signal } = hb.enqueueWake({ agentId: AGENT, kind: "dm", roomId: "room-a", messageId: "m-acked" });
  advance(SEVEN_DAYS_MS - 1000);
  const ack = hb.ackWakes({ agentId: AGENT, signalIds: [signal.signalId] });
  assert.deepEqual(ack.acknowledged, [signal.signalId]);
  advance(2000); // now past the TTL since creation
  assert.deepEqual(hb.pendingWakes(AGENT), []);
  assert.equal(hb.deadLettersOf(AGENT).total, 0, "acked stock never dead-letters");
  assert.equal(hb.wakeStatusOf(AGENT).deadLetterCount, 0);
});

test("a signal younger than the TTL stays pending and wakeable", t => {
  const { hb, advance } = unit(t);
  register(hb);
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: "room-a", messageId: "m-young" });
  advance(SEVEN_DAYS_MS - 1);
  assert.equal(hb.pendingWakes(AGENT).length, 1);
  assert.equal(hb.deadLettersOf(AGENT).total, 0);
});

test("dead stock cannot be claimed on the listener door", t => {
  const { hb, advance } = unit(t);
  register(hb);
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: "room-a", messageId: "m-claimed-late" });
  advance(SEVEN_DAYS_MS + 1);
  // The lease is acquired after the ageing: a listener lease lives 60s,
  // so a lease taken before the advance would be stale for its own sake.
  const lease = hb.acquireListenerLease({ agentId: AGENT, listenerId: "listener-1" });
  assert.equal(lease.acquired, true);
  const batch = hb.claimWakeBatch({ agentId: AGENT, fencingToken: lease.fencingToken });
  assert.deepEqual(batch.signals, [], "a dead signal is never claimed for delivery");
  assert.equal(hb.deadLettersOf(AGENT).total, 1);
});

test("a late ack of a dead-lettered signal records delivery and clears the dead list", t => {
  const { hb, db, advance } = unit(t);
  register(hb);
  const { signal } = hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: "room-a", messageId: "m-late-ack" });
  advance(SEVEN_DAYS_MS + 1);
  assert.deepEqual(hb.pendingWakes(AGENT), []); // triggers expiry
  assert.equal(hb.deadLettersOf(AGENT).total, 1);
  const ack = hb.ackWakes({ agentId: AGENT, signalIds: [signal.signalId] });
  assert.deepEqual(ack.acknowledged, [signal.signalId], "the handling record still lands");
  assert.equal(hb.deadLettersOf(AGENT).total, 0, "dead AND unhandled is the list's membership");
  const row = db.prepare("SELECT delivered_at, dead_at FROM agent_wake_signals WHERE signal_id=?").get(signal.signalId);
  assert.ok(row.delivered_at !== null && row.dead_at !== null, "both stamps survive: it died, then was handled");
});

test("a re-emission against a dead signal's coalescing key does not resurrect it", t => {
  const { hb, advance } = unit(t);
  register(hb);
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: "room-a", messageId: "m-same" });
  advance(SEVEN_DAYS_MS + 1);
  assert.deepEqual(hb.pendingWakes(AGENT), []);
  const again = hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: "room-a", messageId: "m-same" });
  assert.equal(again.enqueued, false, "the same message event still coalesces");
  assert.deepEqual(hb.pendingWakes(AGENT), [], "dead is terminal for the coalescing key");
  assert.equal(hb.deadLettersOf(AGENT).total, 1);
});

test("wake status carries the owner's dead-letter list, count and TTL", t => {
  const { hb, advance } = unit(t);
  register(hb);
  hb.enqueueWake({ agentId: AGENT, kind: "bond", roomId: "room-b", messageId: "m-bond" });
  advance(SEVEN_DAYS_MS + 5);
  const status = hb.wakeStatusOf(AGENT);
  assert.equal(status.signalTtlMs, SEVEN_DAYS_MS);
  assert.equal(status.deadLetterCount, 1);
  assert.equal(status.deadLetters.length, 1);
  assert.equal(status.deadLetters[0].kind, "bond");
  assert.equal(status.deadLetters[0].roomId, "room-b");
});

test("accounting counts dead-lettered stock separately from pending", t => {
  const { hb, advance } = unit(t);
  register(hb);
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: "room-a", messageId: "m-counted" });
  // Age only the first signal: expiry keys on each row's own created_at.
  advance(SEVEN_DAYS_MS + 1);
  hb.enqueueWake({ agentId: AGENT, kind: "mention", roomId: "room-a", messageId: "m-fresh" });
  assert.equal(hb.pendingWakes(AGENT).length, 1, "the fresh signal stays pending");
  const view = hb.accounting();
  assert.equal(view.stock.signalsDeadLettered, 1);
  assert.equal(view.stock.signalsPending, 1, "dead stock is not pending stock");
  assert.equal(view.byStore.signals.dead_lettered, 1, "the transition itself is counted");
});

test("a deployed table without dead_at converges row-preserving and passes verifySchema", t => {
  // The pre-S5 table is today's shape minus the dead_at column. Boot
  // convergence (convergeWakeSignalRoomScope, store.mjs) must rebuild it
  // row-preserving like the #2913 convergence, not fail verifySchema.
  const legacySignals = `CREATE TABLE IF NOT EXISTS agent_wake_signals (
    signal_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('mention','dm','bond','assignment','land')),
    room_id TEXT, message_id TEXT,
    created_at INTEGER NOT NULL, delivered_at INTEGER
  );`;
  const legacySchema = agentHeartbeatSchema.split(/;\s*(?=CREATE|$)/).filter(Boolean)
    .map(chunk => chunk.includes("CREATE TABLE IF NOT EXISTS agent_wake_signals") ? legacySignals : chunk)
    .join(";\n");
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(legacySchema);
  db.prepare(`INSERT INTO agent_wake_signals (signal_id, agent_id, kind, room_id, message_id, created_at, delivered_at)
    VALUES ('ws_pre_s5', ?, 'mention', 'room-a', 'm-legacy', ?, NULL)`).run(AGENT, T0);
  convergeWakeSignalRoomScope(db);
  db.exec(agentHeartbeatSchema);
  convergeWakeSignalRoomScope(db); // idempotent
  const columns = db.prepare("SELECT name FROM pragma_table_info('agent_wake_signals')").all().map(row => row.name);
  assert.ok(columns.includes("dead_at"), "convergence adds the dead_at column");
  const hb = new AgentHeartbeats({ db, now: () => T0 });
  assert.equal(hb.verifySchema(), true);
  const row = db.prepare("SELECT signal_id, dead_at FROM agent_wake_signals").get();
  assert.equal(row.signal_id, "ws_pre_s5", "the legacy row survives convergence");
  assert.equal(row.dead_at, null, "a converged row is pending, not retroactively dead");
});

// ---- HTTP surface: the owner's dead-letter list on GET /api/wake-status ----

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

test("GET /api/wake-status serves the caller's dead letters and the poll stops waking them", async t => {
  const f = createAcceptanceFixture();
  let at = Date.now();
  f.store.now = () => at;
  const origin = await startServer(t, f);
  const identity = f.store.identities.create("dead-letter-agent");
  const scoped = await (await post(origin, "/api/agent-keys",
    { scopes: ["heartbeats:report", "heartbeats:read"] }, identity.secret)).json();
  const credential = scoped.credential;
  await post(origin, "/api/agent-heartbeats", { hostId: "h" }, credential);
  f.store.agentHeartbeats.enqueueWake({ agentId: identity.identityId, kind: "mention", roomId: "commons", messageId: "m-http-dead" });

  at += SEVEN_DAYS_MS + 1000; // the signal ages past the TTL unacknowledged

  const poll = await (await get(origin, "/api/agent-wakes/poll?hostId=h&waitMs=0", credential)).json();
  assert.deepEqual(poll.pendingWakes, [], "the poll door never serves a dead signal");

  const doc = await (await get(origin, "/api/wake-status", credential)).json();
  assert.equal(doc.signalTtlMs, SEVEN_DAYS_MS);
  assert.equal(doc.deadLetterCount, 1);
  assert.equal(doc.deadLetters.length, 1);
  assert.equal(doc.deadLetters[0].kind, "mention");
  assert.equal(doc.deadLetters[0].roomId, "commons");
  assert.ok(doc.deadLetters[0].ageMs >= SEVEN_DAYS_MS);
  assert.ok(!("lastPolledAt" in doc), "the coarsening contract still holds: no exact poll timestamps");
});
