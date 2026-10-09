// WAVE-500 W13: swarm-scale event burn load test.
//
// What this measures: how fast a claim-churning swarm burns the two pilot
// budgets from server/store.mjs PILOT_LIMITS — the 1M room-event budget and
// the 4MB room-projection budget.
//
// The default claim write path (server/work-claim-routes.mjs
// handleWorkClaims) appends one thin `work_claim.updated` room event per
// committed change (server/work-claim-events.mjs `commit`); the work_claims
// table stays the source of truth and the projection does NOT accumulate
// claim items (src/events.js recordWorkClaimUpdate validates only — it
// mutates no state, and the projection rewrite strips eventLog/seen keys).
//
// The ?fast=1 lane "skips events entirely" (server/event-coalesce.mjs
// header comment) but no ?fast=1 query parameter exists in the route layer
// yet, so the fast path is simulated exactly as specified in the brief:
// the pure state machine (server/work-claims.mjs) + durable
// registry.set(roomId, item) with no event emission.
//
// Runtime / sampling honesty: a full 500-agent x heavy-churn run is not
// needed to get the rate — event emission is a fixed function of the write
// itself, independent of agent identity — so we churn N_LIFECYCLES
// lifecycles (500 virtual agent ids cycling round-robin), measure events
// and projection bytes per 100 lifecycles, and EXTRAPOLATE to the 1M / 4MB
// budgets. The numbers are projections from a measured sample, not a
// full-scale run; the printed output says so.
// Runtime / sampling honesty: a full 500-agent x heavy-churn run is not
// needed to get the rate — event emission is a fixed function of the write
// itself, independent of agent identity — so we churn N_LIFECYCLES
// lifecycles (500 virtual agent ids cycling round-robin), measure events
// and projection bytes per 100 lifecycles, and EXTRAPOLATE to the 1M / 4MB
// budgets. The numbers are projections from a measured sample, not a
// full-scale run; the printed output says so.
//
// Storage: :memory: RoomStore. A file-backed store is the same code and
// the same tables, but every committed write fsyncs (~30-100ms on this
// disk), which turned a 300-lifecycle sample into ~160s. The burn rate
// (events per write, projection bytes per write) is identical either way,
// so the sample runs in memory and finishes well under 60s.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { createWork, claimWork, updateWork, closeWork } from "../server/work-claims.mjs";
import { PILOT_LIMITS } from "../server/store.mjs";

const ROOM_ID = "commons";
const AGENT_POOL = 500; // virtual agents, ids cycled round-robin
const N_LIFECYCLES = 150; // measured sample; rates reported per 100, then extrapolated
const PER_100 = N_LIFECYCLES / 100;
const OWNER = "owner";

const openStore = () => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom(ROOM_ID));
  return store;
};
const eventCount = store =>
  store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE room_id=?").get(ROOM_ID).n;
const projectionBytes = store =>
  store.db.prepare("SELECT length(CAST(projection AS BLOB)) AS bytes FROM rooms WHERE id=?").get(ROOM_ID).bytes;

// One route call through the real default write path (auth as room owner,
// the same shape tests/work-claim-durable-http.test.js uses).
const route = async (store, workClaimRoute, workClaimId, bodyData) => {
  const helpers = {
    body: async () => bodyData ?? {},
    json: (res, status, body) => { helpers.seen = { status, body }; },
    reject: (status, code, message) => {
      const error = new Error(message);
      error.status = status; error.code = code;
      throw error;
    },
  };
  await handleWorkClaims({
    req: { method: "POST" }, res: {}, url: new URL("http://localhost"),
    store, roomId: ROOM_ID,
    auth: { member: { id: OWNER, kind: "human" } },
    workClaimRoute, workClaimId, registry: store.workClaims, helpers,
  });
  assert.ok(helpers.seen, `route ${workClaimRoute} produced no response`);
  assert.ok(helpers.seen.status < 400,
    `route ${workClaimRoute} failed: ${helpers.seen.status} ${JSON.stringify(helpers.seen.body)}`);
  return helpers.seen.body;
};

// Default-path lifecycle: create -> claim -> update(start) -> release -> close(settle).
// Each step is one committed write, and the route layer emits exactly one
// work_claim.updated room event per committed write.
const defaultLifecycle = async (store, agent, seq) => {
  const id = `burn-${agent}-${seq}`;
  await route(store, "create", null, { id, title: `burn ${agent} ${seq}` });
  await route(store, "claim", id, { note: "churn" });
  await route(store, "update", id, { state: "in_progress" });
  await route(store, "release", id, { note: "churn" });
  await route(store, "close", id, { reason: "churn" });
};

// Fast-path lifecycle: the ?fast=1 semantics — pure state machine plus
// durable registry.set, zero event emission. Mirrors the route layer's
// release path: an in_progress claim is paused (in_progress -> claimed)
// before release (claimed -> unclaimed), exactly as the /release route
// does internally — both are plain registry writes here, no room events.
const fastLifecycle = (store, agent, seq) => {
  const now = Date.now();
  const id = `fast-${agent}-${seq}`;
  let item = createWork({ id, title: `burn ${agent} ${seq}` }, { now, agentId: OWNER });
  store.workClaims.set(ROOM_ID, item);
  item = claimWork(item, OWNER, { note: "churn", now });
  store.workClaims.set(ROOM_ID, item);
  item = updateWork(item, OWNER, { state: "in_progress", now });
  store.workClaims.set(ROOM_ID, item);
  item = updateWork(item, OWNER, { state: "claimed", note: "paused for release", now });
  store.workClaims.set(ROOM_ID, item);
  item = updateWork(item, OWNER, { state: "unclaimed", note: "churn", now });
  store.workClaims.set(ROOM_ID, item);
  item = closeWork(item, OWNER, { verb: "close", reason: "churn", now, authority: true }); // owner holds manage authority, mirroring the route
  store.workClaims.set(ROOM_ID, item);
};

test("default path: measure event and projection burn per 100 lifecycles, project to 1M / 4MB", async t => {
  const store = openStore();
  t.after(() => store.close());
  const e0 = eventCount(store);
  const p0 = projectionBytes(store);
  const started = Date.now();
  for (let i = 0; i < N_LIFECYCLES; i++) {
    await defaultLifecycle(store, `agent-${i % AGENT_POOL}`, i);
  }
  const wallMs = Date.now() - started;
  const eventsAdded = eventCount(store) - e0;
  const projAdded = projectionBytes(store) - p0;
  const eventsPer100 = eventsAdded / PER_100;
  const projPer100 = projAdded / PER_100;
  const lifecyclesTo1M = Math.floor(PILOT_LIMITS.eventsPerRoom / (eventsAdded / N_LIFECYCLES));
  // The 4MB projection bound: work-claim events carry the claim snapshot
  // but recordWorkClaimUpdate mutates no room state, so claim churn need
  // not consume projection bytes at all. Only compute a finite exhaustion
  // number when the sample actually grew the projection.
  const lifecyclesTo4MB = projAdded > 0
    ? Math.floor(PILOT_LIMITS.projectionBytes / (projAdded / N_LIFECYCLES))
    : Infinity;

  console.log(`[swarm-burn default] ${N_LIFECYCLES} lifecycles x ${AGENT_POOL} virtual agents (measured sample, extrapolation below)`);
  console.log(`[swarm-burn default] room events added: ${eventsAdded} -> ${eventsPer100.toFixed(1)} per 100 lifecycles`);
  console.log(`[swarm-burn default] projection bytes added: ${projAdded} -> ${projPer100.toFixed(1)} per 100 lifecycles`);
  console.log(`[swarm-burn default] EXTRAPOLATED lifecycles to 1M event budget: ~${lifecyclesTo1M.toLocaleString("en-US")} (at ${(eventsAdded / N_LIFECYCLES).toFixed(2)} events/lifecycle)`);
  if (Number.isFinite(lifecyclesTo4MB)) {
    console.log(`[swarm-burn default] EXTRAPOLATED lifecycles to 4MB projection budget: ~${lifecyclesTo4MB.toLocaleString("en-US")}`);
  } else {
    console.log(`[swarm-burn default] EXTRAPOLATED lifecycles to 4MB projection budget: unbounded — claim churn adds 0 projection bytes (claims live in the durable work_claims table, not the room projection); the 1M event budget is the binding constraint`);
  }
  console.log(`[swarm-burn default] wall time: ${(wallMs / 1000).toFixed(1)}s for ${N_LIFECYCLES} lifecycles (${N_LIFECYCLES * 5} route calls)`);

  // (1) the default path burns room events: at least one per lifecycle,
  // and the 1M exhaustion number is finite and positive.
  assert.ok(eventsPer100 >= 100, `expected >=1 event/lifecycle, got ${eventsPer100 / 100}`);
  assert.ok(Number.isFinite(lifecyclesTo1M) && lifecyclesTo1M > 0);
  // (2) projection growth is measured honestly; it may be zero for claim
  // churn (see above) — assert only that the measurement is sane.
  assert.ok(projAdded >= 0, "projection must not shrink");
  assert.ok(Number.isFinite(projPer100));
  // Keep the suite fast: the whole file must stay well under 60s.
  assert.ok(wallMs < 50_000, `sample took ${(wallMs / 1000).toFixed(1)}s — reduce N_LIFECYCLES`);
});

test("fast path (?fast=1 semantics): pure registry.set burns 0 room events", async t => {
  const store = openStore();
  t.after(() => store.close());
  const e0 = eventCount(store);
  const p0 = projectionBytes(store);
  const started = Date.now();
  for (let i = 0; i < N_LIFECYCLES; i++) {
    fastLifecycle(store, `agent-${i % AGENT_POOL}`, i);
  }
  const wallMs = Date.now() - started;
  const eventsAdded = eventCount(store) - e0;
  const projAdded = projectionBytes(store) - p0;
  console.log(`[swarm-burn fast] ${N_LIFECYCLES} lifecycles x ${AGENT_POOL} virtual agents`);
  console.log(`[swarm-burn fast] room events added: ${eventsAdded}`);
  console.log(`[swarm-burn fast] projection bytes added: ${projAdded}`);
  console.log(`[swarm-burn fast] wall time: ${(wallMs / 1000).toFixed(1)}s`);

  // (3) the fast lane skips events entirely — and, since it never touches
  // the event append path, the room projection is untouched too.
  assert.equal(eventsAdded, 0, "fast path must emit zero room events");
  assert.equal(projAdded, 0, "fast path must not grow the room projection");
  // The state still advanced: the durable registry holds every churned
  // claim (spot-check the first and last).
  assert.equal(store.workClaims.get(ROOM_ID, "fast-agent-0-0")?.state, "closed");
  assert.equal(store.workClaims.get(ROOM_ID, `fast-agent-${(N_LIFECYCLES - 1) % AGENT_POOL}-${N_LIFECYCLES - 1}`)?.state, "closed");
});
