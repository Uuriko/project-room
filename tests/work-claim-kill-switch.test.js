// FIX-66 (WAVE-300): STORM kill-switch for the work-claim plane.
// "Who holds the global STOP if the control plane goes silent mid-flood?"
// Answer: the room owner, and only the room owner.
//
// Authoring gate answers: every test guards an observable contract at the
// real boundary (handleWorkClaims with a real RoomStore) — the fail-first
// sequence for the new kill-switch route and the mutation freeze:
//   1. engage (owner) -> claim mutations rejected with 503 kill_switch_engaged
//   2. reads stay live while engaged
//   3. disengage (owner) -> mutations work again
//   4. a non-owner agent cannot engage or disengage
//   5. a restart (fresh store on the same DB) comes back OFF — never stuck ON
//   6. engage/disengage are recorded as room events (who/when/why)
// The credible regressions: a choke-point bypass on a new POST route (sweep),
// an agent flipping the switch, a persisted-ON switch surviving restart, and
// a silent (unaudited) engagement. Existing suites cover the claim lifecycle
// itself, not the freeze.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims, createWorkClaimRegistry } from "../server/work-claim-routes.mjs";

const ROOM = "kill-switch-room";
const OWNER = { member: { id: "owner", kind: "human", permissions: [] } };
const AGENT = { member: { id: "lane-1", kind: "agent", permissions: ["accept_work", "complete_work"] } };

function makeStore(t, filename = ":memory:") {
  const store = new RoomStore(filename);
  store.initialize(initialRoom(ROOM));
  t.after(() => store.close());
  return store;
}

function callWith(store, { auth = OWNER, route, id = null, body = undefined, method = null }) {
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  // Mirror the production middleware: a thrown typed error (ServiceError via
  // reject()) becomes the wire envelope { error: { code, message } }.
  return handleWorkClaims({
    req: { method: method ?? (route === "list" || route === "read" || route === "kill-switch" && body === undefined ? "GET" : "POST"), body },
    res: {},
    url: new URL(`https://room.example/api/rooms/${ROOM}/work-claims${id ? `/${id}` : ""}`),
    store, roomId: ROOM, auth, workClaimRoute: route, workClaimId: id, helpers,
    registry: store.workClaims,
  }).catch(error => {
    if (Number.isInteger(error?.status) && typeof error?.code === "string") {
      return { status: error.status, value: { error: { code: error.code, message: error.message } } };
    }
    throw error;
  });
}

const killSwitch = (store, action, { auth = OWNER, reason } = {}) =>
  callWith(store, { auth, route: "kill-switch", method: "POST", body: { action, ...(reason ? { reason } : {}) } });

const killSwitchStatus = (store, auth = OWNER) =>
  callWith(store, { auth, route: "kill-switch", method: "GET" });

const roomEvents = (store, type) => store.db.prepare(
  "SELECT body FROM events WHERE room_id=? ORDER BY sequence"
).all(ROOM).map(row => JSON.parse(row.body)).filter(event => !type || event.type === type);

// --- engage/disengage ----------------------------------------------------

test("owner engages: response carries the engaged state", async t => {
  const store = makeStore(t);
  const out = await killSwitch(store, "engage", { reason: "storm drill" });
  assert.equal(out.status, 200);
  assert.equal(out.value.engaged, true);
  assert.equal(out.value.roomId, ROOM);
});

test("non-owner agent cannot engage: 403 owner_required, switch stays OFF", async t => {
  const store = makeStore(t);
  const out = await killSwitch(store, "engage", { auth: AGENT });
  assert.equal(out.status, 403);
  assert.equal(out.value.error.code, "owner_required");
  const status = await killSwitchStatus(store);
  assert.equal(status.value.engaged, false, "a refused engage must not flip the switch");
});

test("non-owner agent cannot disengage either", async t => {
  const store = makeStore(t);
  await killSwitch(store, "engage");
  const out = await killSwitch(store, "disengage", { auth: AGENT });
  assert.equal(out.status, 403);
  assert.equal(out.value.error.code, "owner_required");
  const status = await killSwitchStatus(store);
  assert.equal(status.value.engaged, true, "a refused disengage must not drop the freeze");
});

test("engage rejects a garbage action with 422", async t => {
  const store = makeStore(t);
  const out = await callWith(store, { route: "kill-switch", method: "POST", body: { action: "nuke" } });
  assert.equal(out.status, 422);
});

// --- the freeze ------------------------------------------------------------

test("while engaged, claim mutations are rejected with 503 kill_switch_engaged", async t => {
  const store = makeStore(t);
  await killSwitch(store, "engage", { reason: "flood" });
  // create a claim BEFORE engaging on a second room is overkill; engage first,
  // then prove the create itself is refused.
  const created = await callWith(store, { route: "create", body: { id: "ks-1", files: ["server/a.mjs"] } });
  assert.equal(created.status, 503);
  assert.equal(created.value.error.code, "kill_switch_engaged");
});

test("while engaged, claim/release/sweep on an existing claim are frozen too", async t => {
  const store = makeStore(t);
  await callWith(store, { route: "create", body: { id: "ks-2", files: ["server/b.mjs"] } });
  await killSwitch(store, "engage");
  for (const [route, id, body] of [
    ["claim", "ks-2", { leaseHours: 6 }],
    ["update", "ks-2", { title: "storm edit" }],
    ["release", "ks-2", {}],
    ["sweep", null, {}],
  ]) {
    const out = await callWith(store, { auth: AGENT, route, id, body });
    assert.equal(out.status, 503, `${route} must freeze while engaged`);
    assert.equal(out.value.error.code, "kill_switch_engaged", `${route} must carry the documented code`);
  }
  const item = store.workClaims.get(ROOM, "ks-2");
  assert.equal(item.state, "unclaimed", "engagement must not mutate existing claims");
});

test("while engaged, reads stay live", async t => {
  const store = makeStore(t);
  await callWith(store, { route: "create", body: { id: "ks-3", files: ["server/c.mjs"] } });
  await killSwitch(store, "engage");
  const list = await callWith(store, { auth: AGENT, route: "list" });
  assert.equal(list.status, 200);
  const read = await callWith(store, { auth: AGENT, route: "read", id: "ks-3" });
  assert.equal(read.status, 200);
  const status = await killSwitchStatus(store, AGENT);
  assert.equal(status.status, 200);
  assert.equal(status.value.engaged, true);
});

test("disengage restores mutations", async t => {
  const store = makeStore(t);
  await killSwitch(store, "engage");
  const out = await killSwitch(store, "disengage", { reason: "storm passed" });
  assert.equal(out.status, 200);
  assert.equal(out.value.engaged, false);
  const created = await callWith(store, { route: "create", body: { id: "ks-4", files: ["server/d.mjs"] } });
  assert.equal(created.status, 201, "mutations must work again after disengage");
});

// --- fail-safe -------------------------------------------------------------

test("restart comes back OFF: a fresh store on the same DB does not freeze", async t => {
  const dir = mkdtempSync(join(tmpdir(), "ks-restart-"));
  const file = join(dir, "room.db");
  const first = new RoomStore(file);
  first.initialize(initialRoom(ROOM));
  await killSwitch(first, "engage", { reason: "before crash" });
  const statusBefore = await killSwitchStatus(first);
  assert.equal(statusBefore.value.engaged, true);
  first.close();

  // Simulate the crash/restart: brand-new store instance, same database file.
  const second = new RoomStore(file);
  try {
    const created = await callWith(second, { route: "create", body: { id: "ks-5", files: ["server/e.mjs"] } });
    assert.equal(created.status, 201, "a restarted server must not be stuck ON");
    const status = await killSwitchStatus(second);
    assert.equal(status.value.engaged, false);
  } finally {
    second.close();
  }
});

test("a fresh in-memory store defaults OFF", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(ROOM));
  try {
    const status = await killSwitchStatus(store);
    assert.equal(status.value.engaged, false);
  } finally {
    store.close();
  }
});

test("while engaged, expired leases are not reaped — not even by reads", async t => {
  let now = Date.now();
  const store = new RoomStore(":memory:", { now: () => now });
  store.initialize(initialRoom(ROOM));
  t.after(() => store.close());
  await callWith(store, { route: "create", body: { id: "ks-exp", files: ["server/exp.mjs"] } });
  await callWith(store, { route: "claim", id: "ks-exp", body: { leaseHours: 1 } });
  await killSwitch(store, "engage", { reason: "freeze the board" });
  now += 2 * 60 * 60 * 1000; // lease lapses while the switch is engaged
  const list = await callWith(store, { auth: AGENT, route: "list" });
  assert.equal(list.status, 200);
  assert.deepEqual(list.value.swept, [], "no housekeeping while engaged");
  const item = store.workClaims.get(ROOM, "ks-exp");
  assert.equal(item.state, "claimed", "the lapsed lease is left alone while engaged");
  assert.equal(item.owner, "owner");
  // After disengage the next sweep reaps it normally.
  await killSwitch(store, "disengage");
  const sweep = await callWith(store, { route: "sweep", body: {} });
  assert.equal(sweep.status, 200);
  assert.deepEqual(sweep.value.released, ["ks-exp"]);
  assert.equal(store.workClaims.get(ROOM, "ks-exp").state, "unclaimed");
});

// --- audit trail -----------------------------------------------------------

test("engage and disengage are recorded as room events with who/when/why", async t => {
  const store = makeStore(t);
  const before = roomEvents(store, "work_claim.kill_switch_set").length;
  await killSwitch(store, "engage", { reason: "storm drill" });
  await killSwitch(store, "disengage", { reason: "all clear" });
  const events = roomEvents(store, "work_claim.kill_switch_set");
  assert.equal(events.length, before + 2);
  const [engaged, disengaged] = events.slice(-2);
  assert.equal(engaged.actorId, "owner");
  assert.equal(engaged.data.engaged, true);
  assert.equal(engaged.data.reason, "storm drill");
  assert.ok(engaged.at, "engage carries a timestamp");
  assert.equal(disengaged.actorId, "owner");
  assert.equal(disengaged.data.engaged, false);
  assert.equal(disengaged.data.reason, "all clear");
});

// --- pure module -----------------------------------------------------------

test("kill-switch state module: defaults OFF, per-room, in-memory", async t => {
  const { createKillSwitchState } = await import("../server/kill-switch.mjs");
  const ks = createKillSwitchState();
  assert.equal(ks.isEngaged("room-a"), false, "default is OFF");
  ks.engage("room-a");
  assert.equal(ks.isEngaged("room-a"), true);
  assert.equal(ks.isEngaged("room-b"), false, "per-room: room-b unaffected");
  ks.disengage("room-a");
  assert.equal(ks.isEngaged("room-a"), false);
  // Toggling twice is idempotent — no throw, no stuck state.
  ks.disengage("room-a");
  ks.engage("room-a");
  ks.engage("room-a");
  assert.equal(ks.isEngaged("room-a"), true);
});

test("the in-memory registry fixture stays usable for pure-state tests", t => {
  const registry = createWorkClaimRegistry();
  assert.equal(typeof registry.get, "function");
});
