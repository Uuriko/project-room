// stale-done-retry.mjs — executable example of the GUILD-01 finding.
//
// Shows, against the REAL route handler (in-memory registry, offline), that a
// `done` prepared against claim round N, retried after release + re-claim
// (round N+1, same owner), lands differently depending on whether the client
// sent round preconditions:
//
//   case A — done WITHOUT expectedClaimedAt/expectedHistoryLength
//            (opt-in omitted, the deployed legacy default):
//            -> 200, round N+1 marked DONE. Fresh work falsely completed.
//   case B — done WITH stale preconditions:
//            -> 409 work_claim_conflict, round N+1 untouched.
//
// Run: node coord300/guild-01/examples/stale-done-retry.mjs
import * as routes from "../../../server/work-claim-routes.mjs";
import * as claims from "../../../server/work-claims.mjs";
import { ServiceError } from "../../../server/service-error.mjs";

const ROOM = "room1", ITEM = "task", HOLDER = "holder";
const MEMBERS = { [HOLDER]: { id: HOLDER, kind: "agent", active: true, permissions: ["accept_work", "complete_work"] } };
const makeStore = () => ({
  roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }),
  room: () => ({ state: { messages: [] } }),
});
const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { throw new ServiceError(status, code, message); },
  body: async req => req.body,
};
async function call(registry, memberId, route, id, body) {
  try {
    return await routes.handleWorkClaims({ req: { method: "POST", body }, res: {},
      url: new URL("https://room.example/api/rooms/room1/work-claims"), store: makeStore(),
      roomId: ROOM, auth: { member: { id: memberId, kind: "agent", permissions: MEMBERS[memberId].permissions } },
      workClaimRoute: route, workClaimId: id, helpers, registry });
  } catch (thrown) {
    if (thrown instanceof ServiceError) return { status: thrown.status, code: thrown.code };
    return { status: 500, thrown };
  }
}
const snap = (registry, id) => JSON.parse(JSON.stringify(registry.get(ROOM, id)));
const basisOf = item => ({ expectedClaimedAt: item.claimedAt, expectedHistoryLength: claims.claimHistoryLength(item) });

// Round 1: claim -> start -> (done prepared, response "dropped") -> released
// via /release -> re-claimed (round 2) -> started again.
async function round2World() {
  const registry = routes.createWorkClaimRegistry();
  await call(registry, HOLDER, "create", null, { id: ITEM });
  await call(registry, HOLDER, "claim", ITEM, {});
  await call(registry, HOLDER, "update", ITEM, { state: "in_progress" });
  const b1 = basisOf(snap(registry, ITEM));
  await call(registry, HOLDER, "release", ITEM, { ...b1, reason: "superseded" });
  await call(registry, HOLDER, "claim", ITEM, {});
  await call(registry, HOLDER, "update", ITEM, { state: "in_progress" });
  return { registry, b1 };
}

const { registry: rA, b1: bA } = await round2World();
const staleA = await call(rA, HOLDER, "update", ITEM, { state: "done" });
const itemA = snap(rA, ITEM);
console.log("A  stale done, no preconditions :", staleA.status, staleA.code ?? "",
  `| round-2 state = ${itemA.state}`, `| claimedAt is round-2: ${itemA.claimedAt !== bA.expectedClaimedAt}`);

const { registry: rB, b1: bB } = await round2World();
const staleB = await call(rB, HOLDER, "update", ITEM, { state: "done", ...bB });
console.log("B  stale done, stale preconditions:", staleB.status, staleB.code ?? "",
  `| round-2 state = ${snap(rB, ITEM).state}`);

console.log(staleA.status === 200 && itemA.state === "done"
  ? "=> GAP REPRODUCED: the unbound done completed round 2 (fix absent)."
  : "=> GAP NOT PRESENT: the unbound done was refused (fix present).");
