// FIX-19 (WAVE-300 ranked-fixes): correlated-death HOLD —
// "≥30% squad or ≥15 room-wide silent → 30-min park."
//
// Trigger path observed: 3+ daemon restarts killed ~46 lane-instances. When a
// squad (or the room) goes mass-silent at once, new claim intake is parked
// for 30 minutes: existing claims keep working, only NEW claims are refused
// with 503 correlated_death_hold. This is the automatic, detector-driven
// cousin of the FIX-66 kill-switch (owner-driven total mutation freeze).
//
// Fail-first: this file was written before server/correlated-death.mjs
// existed. Silence reuses the FIX-67 activity signal definition
// (server-journaled authenticated commands + executing-session heartbeats,
// decaying at HEARTBEAT_STALE_AFTER_MS = 180s); enrollment is not activity.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import {
  CORRELATED_DEATH_HOLD_CODE,
  CORRELATED_DEATH_PARK_MS,
  CORRELATED_DEATH_SQUAD_SILENCE_FRACTION,
  CORRELATED_DEATH_ROOM_SILENCE_COUNT,
  evaluateCorrelatedDeathHold,
  assertNoCorrelatedDeathHold,
  correlatedDeathStatus,
} from "../server/correlated-death.mjs";

const TTL_MS = 180_000; // HEARTBEAT_STALE_AFTER_MS, the presence TTL FIX-67 pins

function fixture(t, startMs = Date.now()) {
  // NB: the fake clock starts at the REAL wall clock. store.command() journals
  // events with the server wall clock (not store.now()), and the FIX-67
  // activity signal excludes future-dated activity — so a fixed past startMs
  // would make every act() look future-dated and every member silent.
  const dir = mkdtempSync(join(tmpdir(), "correlated-death-"));
  let clock = startMs;
  const store = new RoomStore(join(dir, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const addAgent = id => {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId: id, displayName: id, kind: "agent",
        permissions: ["accept_work", "complete_work"] } });
    return store.issueAccessKey("commons", id);
  };
  const act = key => store.command(key, "commons", { id: randomUUID(),
    type: "message.posted", data: { messageId: randomUUID(), body: "still here" } });
  const makeSquad = (squadId, memberIds) => {
    store.db.prepare(`INSERT INTO squads
      (room_id, squad_id, name, goal, members_json, channel_message_id, owner_id, state, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run("commons", squadId, squadId, "",
      JSON.stringify(memberIds), null, "owner", "active", clock, clock);
  };
  return { store, ownerKey, addAgent, act, makeSquad,
    tick(ms) { clock += ms; }, now: () => clock };
}

const holdError = fn => assert.throws(fn, error =>
  error?.code === CORRELATED_DEATH_HOLD_CODE && error?.status === 503);

// --- pure detector ---------------------------------------------------------

test("pure: squad with >=30% silent members trips the hold", () => {
  const nowMs = 1_000_000_000;
  const verdict = evaluateCorrelatedDeathHold({
    memberIds: ["a", "b", "c", "d", "owner"],
    squads: [{ id: "sq1", name: "lane-squad", members: ["a", "b", "c", "d"] }],
    activityAt: new Map([["a", nowMs - 10_000], ["b", nowMs - 10_000], ["owner", nowMs - 10_000]]),
    nowMs,
  });
  assert.equal(verdict.hold, true);
  assert.equal(verdict.reason, "squad");
  assert.equal(verdict.squadId, "sq1");
});

test("pure: a single silent member (below 30%) does not trip the hold", () => {
  const nowMs = 1_000_000_000;
  const verdict = evaluateCorrelatedDeathHold({
    memberIds: ["a", "b", "c", "d", "owner"],
    squads: [{ id: "sq1", name: "lane-squad", members: ["a", "b", "c", "d"] }],
    activityAt: new Map([["a", nowMs - 10_000], ["b", nowMs - 10_000], ["c", nowMs - 10_000], ["owner", nowMs - 10_000]]),
    nowMs,
  });
  assert.equal(verdict.hold, false);
});

test("pure: >=15 silent room-wide trips the hold with no squads involved", () => {
  const nowMs = 1_000_000_000;
  const memberIds = ["owner", ...Array.from({ length: 15 }, (_, i) => `m${i}`)];
  const verdict = evaluateCorrelatedDeathHold({
    memberIds, squads: [],
    activityAt: new Map([["owner", nowMs - 10_000]]),
    nowMs,
  });
  assert.equal(verdict.hold, true);
  assert.equal(verdict.reason, "room");
  assert.equal(verdict.silentCount, 15);
});

test("pure: 14 silent room-wide stays below the room trigger", () => {
  const nowMs = 1_000_000_000;
  const memberIds = ["owner", ...Array.from({ length: 14 }, (_, i) => `m${i}`)];
  const verdict = evaluateCorrelatedDeathHold({
    memberIds, squads: [],
    activityAt: new Map([["owner", nowMs - 10_000]]),
    nowMs,
  });
  assert.equal(verdict.hold, false);
});

test("pure: thresholds are the documented tunables", () => {
  assert.equal(CORRELATED_DEATH_SQUAD_SILENCE_FRACTION, 0.30);
  assert.equal(CORRELATED_DEATH_ROOM_SILENCE_COUNT, 15);
  assert.equal(CORRELATED_DEATH_PARK_MS, 30 * 60 * 1000);
});

// --- store-level guard -----------------------------------------------------

test("guard: squad with 2/4 silent (>=30%) parks new claims with correlated_death_hold", t => {
  const f = fixture(t);
  const keys = ["a", "b", "c", "d"].map(id => f.addAgent(id));
  f.makeSquad("sq_death", ["a", "b", "c", "d"]);
  f.act(keys[0]); f.act(keys[1]); // a, b alive; c, d silent (enrollment is not activity)
  holdError(() => assertNoCorrelatedDeathHold(f.store, "commons"));
  const status = correlatedDeathStatus(f.store, "commons");
  assert.equal(status.engaged, true);
  assert.ok(status.remainingMs > 0 && status.remainingMs <= CORRELATED_DEATH_PARK_MS);
});

test("guard: a single silent squad member (1/4 = 25%) lets claims proceed", t => {
  const f = fixture(t);
  const keys = ["a", "b", "c", "d"].map(id => f.addAgent(id));
  f.makeSquad("sq_ok", ["a", "b", "c", "d"]);
  f.act(keys[0]); f.act(keys[1]); f.act(keys[2]); // only d silent
  assert.doesNotThrow(() => assertNoCorrelatedDeathHold(f.store, "commons"));
  assert.equal(correlatedDeathStatus(f.store, "commons").engaged, false);
});

test("guard: >=15 silent room-wide parks new claims", t => {
  const f = fixture(t);
  for (let i = 0; i < 15; i++) f.addAgent(`m${i}`); // enrolled, never act
  f.tick(TTL_MS + 1); // everyone's enrollment-era activity decays…
  f.act(f.ownerKey); // …except the owner, who is alive
  holdError(() => assertNoCorrelatedDeathHold(f.store, "commons"));
});

test("guard: 14 silent room-wide lets claims proceed", t => {
  const f = fixture(t);
  for (let i = 0; i < 14; i++) f.addAgent(`m${i}`);
  f.tick(TTL_MS + 1);
  f.act(f.ownerKey);
  assert.doesNotThrow(() => assertNoCorrelatedDeathHold(f.store, "commons"));
});

test("guard: the 30-min park auto-releases and re-evaluates", t => {
  const f = fixture(t);
  const keys = ["a", "b", "c", "d"].map(id => f.addAgent(id));
  f.makeSquad("sq_park", ["a", "b", "c", "d"]);
  f.act(keys[0]); f.act(keys[1]);
  holdError(() => assertNoCorrelatedDeathHold(f.store, "commons")); // engaged
  f.tick(29 * 60 * 1000);
  holdError(() => assertNoCorrelatedDeathHold(f.store, "commons")); // still parked
  f.tick(2 * 60 * 1000); // 31 min total: park lapses, detector re-evaluates
  f.act(keys[0]); f.act(keys[1]); f.act(keys[2]); // 3/4 alive again → below threshold
  assert.doesNotThrow(() => assertNoCorrelatedDeathHold(f.store, "commons"));
  assert.equal(correlatedDeathStatus(f.store, "commons").engaged, false);
});

test("guard: a restart comes back un-parked (in-memory, fail-safe)", t => {
  const f = fixture(t);
  const keys = ["a", "b", "c", "d"].map(id => f.addAgent(id));
  f.makeSquad("sq_restart", ["a", "b", "c", "d"]);
  f.act(keys[0]); f.act(keys[1]);
  holdError(() => assertNoCorrelatedDeathHold(f.store, "commons"));
  assert.equal(correlatedDeathStatus(f.store, "commons").engaged, true);
  delete f.store.correlatedDeath; // simulate a process restart: state is not persisted
  assert.equal(correlatedDeathStatus(f.store, "commons").engaged, false);
});

test("guard: a broken signal fails open — intake is never blocked by detector errors", () => {
  const broken = { now: () => Date.now() }; // no db, no roomAuthority
  assert.doesNotThrow(() => assertNoCorrelatedDeathHold(broken, "commons"));
  assert.doesNotThrow(() => assertNoCorrelatedDeathHold(null, "commons"));
});

// --- HTTP-shaped refusal ---------------------------------------------------

test("handleWorkClaims: create is refused 503-shaped with correlated_death_hold while parked", async t => {
  const f = fixture(t);
  const keys = ["a", "b", "c", "d"].map(id => f.addAgent(id));
  f.makeSquad("sq_http", ["a", "b", "c", "d"]);
  f.act(keys[0]); f.act(keys[1]);
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; },
    body: async () => ({ id: "cd-hold-claim" }),
  };
  const res = await handleWorkClaims({ req: { method: "POST" }, res: {},
    url: new URL("http://localhost/"), store: f.store, roomId: "commons",
    auth: { member: { id: "a" } }, workClaimRoute: "create", helpers });
  assert.equal(res.status, 503);
  assert.equal(res.value?.error?.code, CORRELATED_DEATH_HOLD_CODE);
});
