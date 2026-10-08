// Work-claim fast path (?fast=1) — the pure-state data plane.
//
// Design law: the database is the truth, events are just notifications.
// Spec: docs/WORK-CLAIMS-FAST-PATH.md. When ?fast=1:
//   - GET list/read/status skip the lease sweep AND skip closeLiveClaims.
//   - Mutations persist via registry.set with zero work_claim.updated
//     room events and no wakes.
//   - The event-budget gate is skipped.
//   - list responses carry swept: [].
// Default behavior (no fast param) is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore, PILOT_LIMITS } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims, closeWorkClaim } from "../server/work-claim-routes.mjs";

const OWNER = { member: { id: "owner", kind: "human", permissions: ["manage_claims"] } };

async function roomStore(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  };
  const call = (route, id, body, extra = {}) => handleWorkClaims({
    req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
    res: {},
    url: new URL("https://room.example/api/rooms/commons/work-claims" + (extra.fast ? "?fast=1" : "")),
    store, roomId: "commons",
    auth: extra.auth ?? OWNER,
    workClaimRoute: route, workClaimId: id, helpers,
    registry: store.workClaims,
  });
  return { store, call };
}

const claimEvents = store => store.db.prepare(
  "SELECT body FROM events WHERE room_id=? ORDER BY sequence"
).all("commons").map(row => JSON.parse(row.body)).filter(event => event.type === "work_claim.updated");

const roomEventCount = store =>
  store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE room_id=?").get("commons").n;

// Push a lease into the past at the storage layer (the route layer
// validates leaseHours > 0, so backdate the row directly).
function backdateLease(store, id) {
  const row = store.workClaims.get("commons", id);
  store.workClaims.set("commons", { ...row,
    leaseExpiresAt: new Date(Date.parse(row.leaseExpiresAt) - 3 * 3600 * 1000).toISOString() });
  return row;
}

test("fast list with lapsed leases: no sweep, no new events rows, swept is []", async t => {
  const { store, call } = await roomStore(t);
  await call("create", null, { id: "fast-list-lease", files: ["src/x.js"] });
  await call("claim", "fast-list-lease", { leaseHours: 1 });
  const before = roomEventCount(store);
  const owner = backdateLease(store, "fast-list-lease").owner;

  const listed = await call("list", null, undefined, { fast: true });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.value.swept, [], "fast list reports swept: []");
  assert.equal(roomEventCount(store), before, "no new rows in the events table");

  const after = store.workClaims.get("commons", "fast-list-lease");
  assert.equal(after.state, "claimed", "lapsed lease is NOT swept in fast mode");
  assert.equal(after.owner, owner, "owner intact");
  const shown = listed.value.claims.find(claim => claim.id === "fast-list-lease");
  assert.equal(shown.state, "claimed", "stored (lapsed) lease state returned as-is");
});

test("fast read with lapsed lease: no sweep, stored lease state returned", async t => {
  const { store, call } = await roomStore(t);
  await call("create", null, { id: "fast-read-lease", files: ["src/x.js"] });
  await call("claim", "fast-read-lease", { leaseHours: 1 });
  const before = roomEventCount(store);
  const owner = backdateLease(store, "fast-read-lease").owner;

  const read = await call("read", "fast-read-lease", undefined, { fast: true });
  assert.equal(read.status, 200);
  assert.equal(read.value.state, "claimed", "fast read does not sweep the lapsed lease");
  assert.equal(read.value.owner, owner, "stored owner returned as-is");
  assert.equal(roomEventCount(store), before, "no new rows in the events table");
});

test("fast create -> claim -> update -> release: state persists, zero work_claim.updated events, zero wakes", async t => {
  const { store, call } = await roomStore(t);
  const beforeEvents = claimEvents(store).length;
  const wakeCount = () => store.agentHeartbeats
    ? store.db.prepare("SELECT COUNT(*) AS n FROM wake_queue WHERE room_id=?").get("commons").n
    : null;
  const beforeWakes = wakeCount();

  const created = await call("create", null, { id: "fast-life", files: ["src/a.js"] }, { fast: true });
  assert.equal(created.status, 201);
  let item = store.workClaims.get("commons", "fast-life");
  assert.equal(item.state, "unclaimed", "created state persisted");

  const claimed = await call("claim", "fast-life", { leaseHours: 2 }, { fast: true });
  assert.equal(claimed.status, 200);
  item = store.workClaims.get("commons", "fast-life");
  assert.equal(item.state, "claimed", "claim transition persisted");
  assert.equal(item.owner, "owner");

  const updated = await call("update", "fast-life", { note: "step one" }, { fast: true });
  assert.equal(updated.status, 200);
  item = store.workClaims.get("commons", "fast-life");
  assert.equal(item.state, "claimed", "state persists across the update");
  assert.ok(item.history.some(entry => entry.note === "step one"), "note persisted");

  const released = await call("release", "fast-life", { reason: "winding down" }, { fast: true });
  assert.equal(released.status, 200);
  item = store.workClaims.get("commons", "fast-life");
  assert.equal(item.state, "unclaimed", "release transition persisted");
  assert.equal(item.owner, null, "release clears the owner");

  assert.equal(claimEvents(store).length, beforeEvents,
    "zero work_claim.updated events across the whole fast lifecycle");
  if (beforeWakes !== null) {
    assert.equal(wakeCount(), beforeWakes, "zero wakes enqueued across the fast lifecycle");
  }
});

test("fast create succeeds with the event budget exhausted", async t => {
  const { store, call } = await roomStore(t);
  // Non-privileged writer, mirroring tests/work-claim-integrity.test.js.
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-contrib", type: "member.added",
    data: { memberId: "contrib", displayName: "contrib", kind: "agent",
      permissions: ["accept_work", "complete_work"] } });
  const nearlyFull = Math.ceil(PILOT_LIMITS.eventsPerRoom * 0.9) + 1;
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id='commons'").run(nearlyFull);
  const contrib = { member: { id: "contrib", kind: "agent", permissions: [] } };

  // A plain (non-fast) write by the same member is refused here.
  const refused = await call("create", null, { id: "budgeted", files: ["src/a.js"] }, { auth: contrib });
  assert.equal(refused.status, 409);
  assert.equal(refused.value?.error?.code, "room_event_budget_low");

  // Fast skips the budget gate.
  const created = await call("create", null, { id: "fast-budget", files: ["src/y.js"] },
    { fast: true, auth: contrib });
  assert.equal(created.status, 201,
    `fast create must succeed under exhausted budget, got ${JSON.stringify(created.value?.error ?? created.value)}`);
  const item = store.workClaims.get("commons", "fast-budget");
  assert.equal(item.state, "unclaimed", "state persisted despite the exhausted budget");
});

test("default path unchanged: list sweeps a lapsed lease, create emits work_claim.updated", async t => {
  const { store, call } = await roomStore(t);
  await call("create", null, { id: "default-sweep", files: ["src/x.js"] });
  await call("claim", "default-sweep", { leaseHours: 1 });
  backdateLease(store, "default-sweep");

  const listed = await call("list");
  const after = store.workClaims.get("commons", "default-sweep");
  assert.equal(after.state, "unclaimed", "default list sweeps the lapsed lease");
  assert.equal(after.owner, null, "sweep clears the owner");
  assert.ok((listed.value.swept ?? []).includes("default-sweep"),
    "default list reports the swept claim");

  const beforeEvents = claimEvents(store).length;
  const created = await call("create", null, { id: "default-emits", files: ["src/y.js"] });
  assert.equal(created.status, 201);
  assert.equal(claimEvents(store).length, beforeEvents + 1,
    "default create emits one work_claim.updated event");
});

test("MCP closeWorkClaim with fast:true closes with no work_claim.updated event", async t => {
  const { store, call } = await roomStore(t);
  await call("create", null, { id: "fast-close", files: ["src/z.js"] });
  await call("claim", "fast-close", { leaseHours: 2 });
  const before = claimEvents(store).length;

  const closed = closeWorkClaim({ store, roomId: "commons", auth: OWNER,
    claimId: "fast-close", fast: true, registry: store.workClaims });
  assert.equal(closed.state, "closed", "the claim closes");
  assert.equal(store.workClaims.get("commons", "fast-close").state, "closed",
    "closed state persisted");
  assert.equal(claimEvents(store).length, before,
    "fast close emits no work_claim.updated event");
});
