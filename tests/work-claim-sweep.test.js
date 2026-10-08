// Contract guarded: reads are pure — no read path sweeps lapsed leases.
// The server-side reaper (30s tick) owns expiry; GET list/read/status never
// release, never emit room events, never wake. POST /sweep remains the
// explicit manual sweep.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const helpers = {
  json: (res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};
const call = (registry, route, id, body, method) => handleWorkClaims({
  req: { method: method ?? (route === "list" || route === "read" || route === "status" ? "GET" : "POST"), body }, res: {},
  url: new URL("https://room.example/api/rooms/room1/work-claims"),
  store: { roomAuthority: () => ({ members: {
    agent1: { id: "agent1", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
  } }), room: () => ({ sequence: 1, state: { messages: [] } }) }, roomId: "room1", auth: { member: { id: "agent1", kind: "agent", permissions: [] } },
  workClaimRoute: route, workClaimId: id, helpers, registry,
});

test("GET list does not sweep a lapsed lease; the claim stays held until the reaper or POST /sweep", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "create", null, { id: "live", files: ["src/live.mjs"] });
  await call(registry, "claim", "live", { leaseHours: 1 });
  const first = await call(registry, "list");
  assert.deepEqual(first.value.swept, []);
  assert.equal(first.value.claims[0].state, "claimed");

  // Lapse the lease behind the registry's back.
  const lapsed = { ...registry.get("room1", "live"), leaseExpiresAt: "2020-01-01T00:00:00.000Z" };
  registry.set("room1", lapsed);

  // Read purity: the list read must NOT release it.
  const second = await call(registry, "list");
  assert.deepEqual(second.value.swept, []);
  assert.equal(second.value.claims.find(c => c.id === "live").state, "claimed");

  // The explicit POST /sweep still releases lapsed leases.
  const swept = await call(registry, "sweep", null, {}, "POST");
  assert.deepEqual(swept.value.released, ["live"]);
  assert.equal(registry.get("room1", "live").state, "unclaimed");
});

test("GET read and GET status do not sweep either", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "create", null, { id: "r1", files: ["src/r1.mjs"] });
  await call(registry, "claim", "r1", { leaseHours: 1 });
  const lapsed = { ...registry.get("room1", "r1"), leaseExpiresAt: "2020-01-01T00:00:00.000Z" };
  registry.set("room1", lapsed);
  const read = await call(registry, "read", "r1");
  assert.equal(read.value.state, "claimed");
  const status = await call(registry, "status", null);
  assert.equal(status.status, 200);
  assert.equal(registry.get("room1", "r1").state, "claimed");
});
