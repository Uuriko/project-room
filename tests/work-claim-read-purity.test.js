// Contract guarded: every work-claims read surface is pure — no read path
// sweeps lapsed leases, mutates the registry, emits room events, or wakes.
// Extends tests/work-claim-sweep.test.js (list/read/status) to the remaining
// read routes: receipts, duplicates, provenance, config GET, queue=ready,
// GET /work-claims-read, the retention dashboard, and the shared page builder
// (used by MCP room_read_board). Expiry is owned by the server-side reaper;
// POST /sweep stays the explicit manual trigger.
import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkClaimPage, createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { getWorkClaimsRead, getRetentionDashboard } from "../server/routes/work-claims.mjs";

const reject = (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; };
const helpers = {
  json: (res, status, value) => ({ status, value }),
  reject,
  body: async req => req.body,
};
const members = { agent1: { id: "agent1", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] } };
const storeOf = registry => ({
  roomAuthority: () => ({ members }),
  room: () => ({ sequence: 1, state: { messages: [] } }),
  workClaims: registry,
  now: () => Date.now(),
});

const call = (registry, route, id, body, { method, search = "" } = {}) => handleWorkClaims({
  req: { method: method ?? "GET", body }, res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${search}`),
  store: storeOf(registry), roomId: "room1",
  auth: { member: { id: "agent1", kind: "agent", permissions: [] } },
  workClaimRoute: route, workClaimId: id, helpers, registry,
});

// Seed a room: one lapsed-lease claim, one done claim (for receipts), one
// unclaimed claim with a title matching the duplicates query.
async function seed() {
  const registry = createWorkClaimRegistry();
  let sets = 0;
  const origSet = registry.set.bind(registry);
  registry.set = (roomId, item) => { sets++; return origSet(roomId, item); };
  const setsOf = () => sets;

  await call(registry, "create", null, { id: "live", title: "deploy the widget", files: ["src/live.mjs"] }, { method: "POST" });
  await call(registry, "claim", "live", { leaseHours: 1 }, { method: "POST" });
  await call(registry, "create", null, { id: "done1", title: "deploy the widget again", files: ["src/done.mjs"] }, { method: "POST" });
  await call(registry, "claim", "done1", { leaseHours: 1 }, { method: "POST" });
  await call(registry, "release", "done1", {}, { method: "POST" });
  await call(registry, "claim", "done1", { leaseHours: 1 }, { method: "POST" });
  await call(registry, "update", "done1", { state: "in_progress" }, { method: "POST" });
  await call(registry, "update", "done1", { state: "done", note: "shipped" }, { method: "POST" });
  // Lapse the lease behind the registry's back — the read must not notice.
  origSet("room1", { ...registry.get("room1", "live"), leaseExpiresAt: "2020-01-01T00:00:00.000Z" });
  sets = 0; // only count writes from the read path under test
  return { registry, setsOf };
}

test("GET receipts does not sweep a lapsed lease", async () => {
  const { registry, setsOf } = await seed();
  const res = await call(registry, "receipts", null, null, { search: "" });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.value.receipts));
  assert.equal(setsOf(), 0, "receipts GET must perform zero registry writes");
  assert.equal(registry.get("room1", "live").state, "claimed");
  assert.equal(registry.get("room1", "live").owner, "agent1");
});

test("GET duplicates does not sweep a lapsed lease", async () => {
  const { registry, setsOf } = await seed();
  const res = await call(registry, "duplicates", null, null, { search: "?q=deploy+the+widget" });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.value.duplicates));
  assert.equal(setsOf(), 0, "duplicates GET must perform zero registry writes");
  assert.equal(registry.get("room1", "live").state, "claimed");
});

test("GET provenance does not sweep a lapsed lease", async () => {
  const { registry, setsOf } = await seed();
  const res = await call(registry, "provenance", "live");
  assert.equal(res.status, 200);
  assert.equal(res.value.claimId, "live");
  assert.equal(setsOf(), 0, "provenance GET must perform zero registry writes");
  assert.equal(registry.get("room1", "live").state, "claimed");
});

test("GET config does not sweep a lapsed lease", async () => {
  const { registry, setsOf } = await seed();
  const res = await call(registry, "config");
  assert.equal(res.status, 200);
  assert.equal(res.value.roomId, "room1");
  assert.equal(setsOf(), 0, "config GET must perform zero registry writes");
  assert.equal(registry.get("room1", "live").state, "claimed");
});

test("GET list ?queue=ready does not sweep a lapsed lease", async () => {
  const { registry, setsOf } = await seed();
  const res = await call(registry, "list", null, null, { search: "?queue=ready" });
  assert.equal(res.status, 200);
  assert.equal(res.value.queue, "ready");
  assert.deepEqual(res.value.swept ?? [], []);
  assert.equal(setsOf(), 0, "queue=ready GET must perform zero registry writes");
  assert.equal(registry.get("room1", "live").state, "claimed");
});

test("GET /work-claims-read (retention route) does not sweep a lapsed lease", async () => {
  const { registry, setsOf } = await seed();
  const store = storeOf(registry);
  const ctx = {
    params: { roomId: "room1" },
    req: { method: "GET" }, res: {},
    url: new URL("https://room.example/api/rooms/room1/work-claims-read"),
    store,
    roomCredentials: () => ({ mode: "test", bearer: null }),
    expectedBinding: () => ({}),
    roomAuth: () => ({ kind: "session", member: { id: "agent1" }, credentialHash: "h" }),
    rate: () => {},
    json: (res, status, value) => ({ status, value }),
    reject,
  };
  const res = await getWorkClaimsRead(ctx);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.value.claims));
  assert.equal(setsOf(), 0, "work-claims-read GET must perform zero registry writes");
  assert.equal(registry.get("room1", "live").state, "claimed");
});

test("GET retention dashboard does not sweep a lapsed lease", async () => {
  const { registry, setsOf } = await seed();
  const store = storeOf(registry);
  const ctx = {
    params: { roomId: "room1" },
    req: { method: "GET" }, res: {},
    url: new URL("https://room.example/api/rooms/room1/work-claims/retention"),
    store,
    roomCredentials: () => ({ mode: "test", bearer: null }),
    expectedBinding: () => ({}),
    roomAuth: () => ({ kind: "session", member: { id: "agent1" }, credentialHash: "h" }),
    rate: () => {},
    json: (res, status, value) => ({ status, value }),
    reject,
  };
  const res = await getRetentionDashboard(ctx);
  assert.equal(res.status, 200);
  assert.equal(setsOf(), 0, "retention GET must perform zero registry writes");
  assert.equal(registry.get("room1", "live").state, "claimed");
});

test("buildWorkClaimPage (MCP room_read_board projection) does not mutate its input", async () => {
  const { registry } = await seed();
  const before = JSON.stringify(registry.list("room1"));
  const page = buildWorkClaimPage(registry.list("room1"), "room1", "agent1", new URLSearchParams(), Date.now());
  assert.ok(Array.isArray(page.claims));
  assert.equal(JSON.stringify(registry.list("room1")), before, "page builder must not mutate stored items");
  assert.equal(registry.get("room1", "live").state, "claimed");
});
