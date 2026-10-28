// BUILD-HEARTBEAT-CADENCE (D2 Charter B): heartbeat cadence is
// server-dictated. The host's cadenceSeconds is a hint; the server assigns
// the governing value (default 120s, honoured hints capped at 3600s), the
// heartbeat and poll responses carry the assignment, the stored value is
// the assignment, and statusOf's window derives from the assigned value —
// including for rows stored under the old declaration-governed contract.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentHeartbeats, HeartbeatError, agentHeartbeatSchema, HEARTBEAT_STALE_AFTER_MS,
} from "../server/agent-heartbeats.mjs";

const T0 = 1_750_000_000_000;
const DEFAULT_ASSIGNED = 120; // window max(180s, 120 * 1.5) = 180s = the old undeclared window
const MAX_ASSIGNED = 3600;    // window cap: 3600 * 1.5 = 5400s

function unit(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(agentHeartbeatSchema);
  let at = T0;
  const hb = new AgentHeartbeats({ db, now: () => at, transaction: fn => { db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } } });
  t.after(() => db.close());
  return { hb, db, advance: ms => { at += ms; }, at: () => at };
}

const wakeable = (hostId = "host-1") => ({
  agentId: "ai_testagent", hostId, mode: "wakeable", wakeUrl: "https://host.example.test/wake",
});
const storedCadence = (db, hostId = "host-1") => db.prepare(
  "SELECT cadence_seconds AS cadenceSeconds FROM agent_push_configs WHERE agent_id=? AND host_id=?")
  .get("ai_testagent", hostId)?.cadenceSeconds ?? null;

test("inversion: a 7-day declaration is assigned the server ceiling, and the window follows the assignment", t => {
  const { hb, db, advance } = unit(t);
  const { host, reachability } = hb.heartbeat({ ...wakeable(), cadenceSeconds: 604800 });
  assert.equal(host.cadenceSeconds, MAX_ASSIGNED, "the response carries the server-assigned cadence, not the declaration");
  assert.equal(storedCadence(db), MAX_ASSIGNED, "the stored governing value is the assignment");
  assert.equal(reachability.reachableUntil, host.lastSeenAt + MAX_ASSIGNED * 1500,
    "reachability derives from the assigned value");
  advance(MAX_ASSIGNED * 1500);
  assert.equal(hb.statusOf("ai_testagent").status, "online", "inside the assigned window");
  advance(1);
  assert.equal(hb.statusOf("ai_testagent").status, "offline",
    "offline after assigned x 1.5 of silence — not after the declared 7 days x 1.5");
});

test("a hint inside the server bounds is honoured as the assignment", t => {
  const { hb, db, advance } = unit(t);
  const { host } = hb.heartbeat({ ...wakeable(), cadenceSeconds: 300 });
  assert.equal(host.cadenceSeconds, 300);
  assert.equal(storedCadence(db), 300);
  advance(300 * 1500);
  assert.equal(hb.statusOf("ai_testagent").hosts[0].state, "online");
  advance(1);
  assert.equal(hb.statusOf("ai_testagent").hosts[0].state, "stale");
});

test("back-compat: an undeclared host is assigned the default and keeps the exact old window", t => {
  const { hb, advance, at } = unit(t);
  const { host, reachability } = hb.heartbeat(wakeable());
  assert.equal(host.cadenceSeconds, DEFAULT_ASSIGNED, "the server assigns its default");
  assert.equal(reachability.reachableUntil, at() + HEARTBEAT_STALE_AFTER_MS,
    "the default assignment's window equals the old undeclared window (180s)");
  const status = hb.statusOf("ai_testagent");
  assert.equal(status.hosts[0].cadenceSeconds, DEFAULT_ASSIGNED);
  advance(HEARTBEAT_STALE_AFTER_MS + 1);
  assert.equal(hb.statusOf("ai_testagent").status, "offline", "same stale boundary as before the change");
});

test("stickiness survives as a standing hint: declare once, bare heartbeats keep the assignment", t => {
  const { hb, db } = unit(t);
  hb.heartbeat({ ...wakeable(), cadenceSeconds: 900 });
  const bare = hb.heartbeat(wakeable());
  assert.equal(bare.host.cadenceSeconds, 900, "omission re-presents the stored hint, it does not reset to the default");
  assert.equal(storedCadence(db), 900);
});

test("an explicit null clears the hint and the server assigns its default", t => {
  const { hb, db } = unit(t);
  hb.heartbeat({ ...wakeable(), cadenceSeconds: 900 });
  const cleared = hb.heartbeat({ ...wakeable(), cadenceSeconds: null });
  assert.equal(cleared.host.cadenceSeconds, DEFAULT_ASSIGNED);
  assert.equal(storedCadence(db), DEFAULT_ASSIGNED);
});

test("read-side enforcement: a pre-existing stored 7-day declaration is governed by the assignment", t => {
  const { hb, db, advance } = unit(t);
  hb.heartbeat(wakeable());
  // Simulate a row written under the old declaration-governed contract.
  db.prepare("UPDATE agent_push_configs SET cadence_seconds=604800 WHERE agent_id=? AND host_id=?")
    .run("ai_testagent", "host-1");
  const status = hb.statusOf("ai_testagent");
  assert.equal(status.hosts[0].cadenceSeconds, MAX_ASSIGNED,
    "presence reads report the governing (assigned) value, never the raw declaration");
  advance(MAX_ASSIGNED * 1500 + 1);
  assert.equal(hb.statusOf("ai_testagent").status, "offline",
    "a dead host that never heartbeats again cannot squat online on its old declaration");
});

test("the poll response carries the assigned cadence for the polling host", t => {
  const { hb } = unit(t);
  hb.heartbeat({ ...wakeable(), cadenceSeconds: 604800 });
  const poll = hb.notePoll({ agentId: "ai_testagent", hostId: "host-1" });
  assert.equal(poll.registered, true);
  assert.equal(poll.cadenceSeconds, MAX_ASSIGNED, "a pull-only seat meets the contract on the poll door");
  const hostless = hb.notePoll({ agentId: "ai_testagent" });
  assert.equal(hostless.cadenceSeconds, DEFAULT_ASSIGNED, "a hostless poll carries the server default assignment");
});

test("declaration validation is unchanged: above the 7-day protocol bound still 422s", t => {
  const { hb } = unit(t);
  for (const cadenceSeconds of [1e300, 604801, 0, -5]) {
    assert.throws(() => hb.heartbeat({ ...wakeable(), cadenceSeconds }), err =>
      err instanceof HeartbeatError && err.status === 422 && err.code === "invalid_heartbeat", String(cadenceSeconds));
  }
});
