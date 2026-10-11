// Cleanup advisories (Dot review of #2536): the two lazy wake-listener
// tables must be covered by the registry-driven room/identity purge, claim
// rows must cascade with their signals, and the purge must not blow up on
// legacy databases where the lazy tables were never created.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createOperatorPurge } from "../server/operator-purge.mjs";
import { PURGE_TABLES } from "../server/purge-registry.mjs";
import { event, EVENT_TYPES as T, PERMISSIONS } from "../src/events.js";

const LEASES = "agent_wake_listener_leases";
const CLAIMS = "agent_wake_signal_claims";
const SIGNALS = "agent_wake_signals";

function createdRoom(roomId, title) {
  return [
    event({ type: T.ROOM_CREATED, actorId: "owner", roomId, data: { roomId, ownerId: "owner", title, purpose: "wake listener purge fixture" } }),
    event({ type: T.MEMBER_ADDED, actorId: "owner", roomId, data: { memberId: "owner", displayName: "Room owner", kind: "human", permissions: [...PERMISSIONS] } }),
  ];
}

function openStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-wake-purge-"));
  const store = new RoomStore(join(directory, "room.sqlite"), {});
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

const tableExists = (db, name) =>
  !!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(name);
const count = (db, table, where = "", ...params) =>
  db.prepare(`SELECT count(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ""}`).get(...params).n;

// Heartbeat + enqueue + lease + claim: populates the signals, leases, and
// claims tables for one (agent, room). roomId null exercises the
// room-agnostic (room_key='') lease.
function populateListener(store, { roomId, agentId, listenerId, messages }) {
  const hb = store.agentHeartbeats;
  hb.heartbeat({ agentId, hostId: `host-${agentId}`, mode: "pull-only" });
  for (const messageId of messages) hb.enqueueWake({ agentId, kind: "mention", roomId, messageId });
  const lease = hb.acquireListenerLease({ agentId, roomId, listenerId, ttlMs: 60000 });
  assert.equal(lease.acquired, true, "fixture lease acquired");
  const batch = hb.claimWakeBatch({ agentId, roomId, fencingToken: lease.fencingToken, limit: 50 });
  assert.equal(batch.signals.length, messages.length, "fixture batch claimed");
  return { lease, batch };
}

function planAndExecute(store, targets) {
  const purge = createOperatorPurge(store);
  const plan = purge.plan({ targets, reason: "Remove QA leftover" }, "wake-purge-test");
  const executed = purge.execute({ planId: plan.planId, confirmToken: plan.confirmToken }, "wake-purge-test");
  assert.equal(executed.result, "executed");
  return { plan, executed };
}

test("the lease tables are registered for room and identity purge", () => {
  const leases = PURGE_TABLES.find(e => e.table === LEASES);
  const claims = PURGE_TABLES.find(e => e.table === CLAIMS);
  assert.ok(leases, "agent_wake_listener_leases is in the purge registry");
  assert.ok(claims, "agent_wake_signal_claims is in the purge registry");
  assert.equal(leases.action, "delete");
  assert.equal(claims.action, "delete");
  assert.equal(leases.optional, true, "lazy table: absent on legacy databases");
  assert.equal(claims.optional, true, "lazy table: absent on legacy databases");
  assert.deepEqual(leases.match.room, ["room_key"]);
  assert.deepEqual(leases.match.identity, ["agent_id"]);
  assert.deepEqual(claims.match.identity, ["agent_id"]);
  assert.deepEqual(claims.via.room, {
    parent: SIGNALS, parentKey: "signal_id", childKey: "signal_id", scope: "room_id",
  });
});

test("room purge removes the room's lease, claim and signal rows and keeps the other room", t => {
  const store = openStore(t);
  store.initialize(createdRoom("wake-room-a", "Wake room A"));
  store.initialize(createdRoom("wake-room-b", "Wake room B"));
  populateListener(store, { roomId: "wake-room-a", agentId: "ai_wake_a", listenerId: "listener-a", messages: ["ma-1", "ma-2"] });
  populateListener(store, { roomId: "wake-room-b", agentId: "ai_wake_b", listenerId: "listener-b", messages: ["mb-1", "mb-2"] });
  populateListener(store, { roomId: null, agentId: "ai_wake_c", listenerId: "listener-c", messages: ["mc-1"] });
  const db = store.db;
  assert.ok(tableExists(db, LEASES) && tableExists(db, CLAIMS), "fixture populated the lazy tables");
  assert.equal(count(db, LEASES), 3);
  assert.equal(count(db, CLAIMS), 5);
  assert.equal(count(db, SIGNALS), 5);

  planAndExecute(store, [{ kind: "room", id: "wake-room-a" }]);

  assert.equal(count(db, LEASES, "room_key=?", "wake-room-a"), 0, "purged room's leases are gone");
  assert.equal(count(db, LEASES), 2, "other room's lease and the room-agnostic lease survive");
  assert.equal(count(db, LEASES, "room_key=?", ""), 1, "room_key='' leases are not room data");
  assert.equal(count(db, `${CLAIMS} c JOIN ${SIGNALS} s ON s.signal_id=c.signal_id`, "s.room_id=?", "wake-room-a"), 0,
    "claims cascade with their purged signals");
  assert.equal(count(db, CLAIMS), 3, "other room's and room-agnostic claims survive");
  assert.equal(count(db, SIGNALS, "room_id=?", "wake-room-a"), 0, "purged room's signals are gone");
  assert.equal(count(db, SIGNALS, "room_id=?", "wake-room-b"), 2, "other room's signals intact");
  assert.equal(count(db, SIGNALS, "room_id IS NULL"), 1, "room-agnostic signal intact");
  assert.equal(count(db, LEASES, "room_key=?", "wake-room-b"), 1, "other room's lease intact");
});

test("identity purge removes the identity's lease and claim rows", t => {
  const store = openStore(t);
  store.initialize(createdRoom("wake-room-id", "Wake room identity"));
  const identity = store.identities.create("wake-purge-agent");
  populateListener(store, { roomId: null, agentId: identity.identityId, listenerId: "listener-id", messages: ["mid-1"] });
  populateListener(store, { roomId: null, agentId: "ai_wake_other", listenerId: "listener-other", messages: ["mid-2"] });
  const db = store.db;
  assert.equal(count(db, LEASES, "agent_id=?", identity.identityId), 1);
  assert.equal(count(db, CLAIMS, "agent_id=?", identity.identityId), 1);

  planAndExecute(store, [{ kind: "identity", id: identity.identityId }]);

  assert.equal(count(db, LEASES, "agent_id=?", identity.identityId), 0, "purged identity's leases are gone");
  assert.equal(count(db, CLAIMS, "agent_id=?", identity.identityId), 0, "purged identity's claims are gone");
  assert.equal(count(db, LEASES, "agent_id=?", "ai_wake_other"), 1, "other agent's lease intact");
  assert.equal(count(db, CLAIMS, "agent_id=?", "ai_wake_other"), 1, "other agent's claims intact");
});

test("purge on a legacy database without the lazy tables does not blow up", t => {
  const store = openStore(t);
  store.initialize(createdRoom("legacy-room", "Legacy room"));
  const db = store.db;
  assert.equal(tableExists(db, LEASES), false, "legacy database never created the lease tables");
  assert.equal(tableExists(db, CLAIMS), false, "legacy database never created the claim tables");

  const { plan } = planAndExecute(store, [{ kind: "room", id: "legacy-room" }]);

  const leases = plan.counts.find(row => row.table === LEASES);
  const claims = plan.counts.find(row => row.table === CLAIMS);
  assert.equal(leases.rows, 0, "absent lazy tables count zero rows");
  assert.equal(claims.rows, 0, "absent lazy tables count zero rows");
  assert.equal(db.prepare("SELECT 1 FROM rooms WHERE id=?").get("legacy-room"), undefined, "room still purged");
});
