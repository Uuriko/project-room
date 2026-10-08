// Contract guarded: the work-claims list reports a claim in `swept` only when
// its lease actually lapsed. Before this fix every claim was reported as
// swept on every request (releaseExpired returns a fresh copy of each item,
// and the route compared object identity), telling agents their live claims
// had been auto-released.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const helpers = {
  json: (res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};
const call = (registry, route, id, body) => handleWorkClaims({
  req: { method: route === "list" ? "GET" : "POST", body }, res: {},
  url: new URL("https://room.example/api/rooms/room1/work-claims"),
  store: { roomAuthority: () => ({ members: {
    agent1: { id: "agent1", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  } }) }, roomId: "room1", auth: { member: { id: "agent1", kind: "agent", permissions: [] } },
  workClaimRoute: route, workClaimId: id, helpers, registry,
});

test("a live claim is not reported as swept; a lapsed one is", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "create", null, { id: "live", files: ["src/live.mjs"] });
  await call(registry, "claim", "live", { leaseHours: 1 });
  const first = await call(registry, "list");
  assert.deepEqual(first.value.swept, []);
  assert.equal(first.value.claims[0].state, "claimed");

  const lapsed = { ...registry.get("room1", "live"), id: "old", leaseExpiresAt: "2020-01-01T00:00:00.000Z" };
  registry.set("room1", lapsed);
  const second = await call(registry, "list");
  assert.deepEqual(second.value.swept, ["old"]);
  assert.equal(second.value.claims.find(c => c.id === "old").state, "unclaimed");
  assert.equal(second.value.claims.find(c => c.id === "live").state, "claimed");
});
