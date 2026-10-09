// E5/D4 follow-up: POST work-claims/:id/reassign binds the claim round the
// client read, like release.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const helpers = () => ({
  json: (res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
});

const roundOfItem = item => ({ expectedClaimedAt: item?.claimedAt ?? null, expectedHistoryLength: (item?.history?.length ?? 0) + (Number(item?.historyOmitted) || 0) });
const call = (registry, member, route, id, body) => handleWorkClaims({
  req: { method: route === "read" ? "GET" : "POST", body },
  res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${id ? `/${id}/${route}` : ""}`),
  store: { roomAuthority: () => ({ members: {
    jill: { id: "jill", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
    claude: { id: "claude", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
    grokbot: { id: "grokbot", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
    ada: { id: "ada", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
  } }) },
  roomId: "room1",
  auth: { member: { id: member, kind: "agent", permissions: [] } },
  workClaimRoute: route,
  workClaimId: id,
  helpers: helpers(),
  registry,
});

const attempt = async thunk => { try { return { out: await thunk(), error: null }; } catch (error) { return { out: null, error }; } };

test("reassign binds the claim round: a stale or replayed reassign is a 409 and moves nothing", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a" });
  await call(registry, "jill", "claim", "a", {});
  const round1 = roundOfItem(registry.get("room1", "a"));
  const first = await call(registry, "jill", "reassign", "a", { newOwner: "ada", ...round1 });
  assert.equal(first.status, 200);
  // ada releases, jill re-claims: a newer claim round now exists
  const afterAda = roundOfItem(registry.get("room1", "a"));
  await call(registry, "ada", "release", "a", { ...afterAda });
  await call(registry, "jill", "claim", "a", {});
  const before = registry.get("room1", "a");
  // a delayed duplicate of the first reassign (same stale round) must not land
  const { error } = await attempt(() => call(registry, "jill", "reassign", "a", { newOwner: "ada", ...round1 }));
  assert.equal(error.status, 409);
  assert.equal(error.code, "work_claim_conflict");
  const after = registry.get("room1", "a");
  assert.equal(after.owner, "jill");
  assert.equal(after.history.length, before.history.length);
});

test("reassign without the claim round is refused as invalid input", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a" });
  await call(registry, "jill", "claim", "a", {});
  const { error } = await attempt(() => call(registry, "jill", "reassign", "a", { newOwner: "ada" }));
  assert.equal(error.status, 422);
  assert.equal(registry.get("room1", "a").owner, "jill");
});

test("an unclaimed item reassigns with expectedClaimedAt null", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "u" });
  const round = roundOfItem(registry.get("room1", "u"));
  assert.equal(round.expectedClaimedAt, null);
  const out = await call(registry, "jill", "reassign", "u", { newOwner: "ada", ...round });
  assert.equal(out.status, 200);
  assert.equal(out.value.owner, "ada");
});
