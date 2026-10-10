// A handoff or supersede names a successor card. That id may already be a
// live claim held by someone else. The mirror must not report that card as
// the successor, and it must not point the source chain at it.
import test from "node:test";
import assert from "node:assert/strict";
import { mirrorProjectionClaim } from "../server/work-claim-mirror.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const members = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_members", "steer", "manage_claims", "accept_work", "complete_work"] },
  holder: { id: "holder", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  other: { id: "other", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};
const at = "2026-10-09T18:40:00.000Z";

function board() {
  const registry = createWorkClaimRegistry();
  const store = {
    workClaims: registry,
    now: () => Date.parse(at),
    roomAuthority: () => ({ ownerId: "owner", members, sequence: 1 }),
  };
  const helpers = () => ({
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
    body: async req => req.body,
  });
  const call = (member, route, id, body) => handleWorkClaims({
    req: { method: "POST", body },
    res: {},
    url: new URL("https://room.example/api/rooms/room1/work-claims"),
    store,
    roomId: "room1",
    auth: { member: { id: member, kind: members[member].kind, permissions: members[member].permissions } },
    workClaimRoute: route,
    workClaimId: id,
    helpers: helpers(),
    registry,
  });
  return { registry, store, call };
}

test("a handoff does not adopt another member's live card as the successor", async () => {
  const { registry, store, call } = board();
  await call("owner", "create", "taken", { id: "taken", title: "Taken source" });
  await call("other", "claim", "taken", { files: ["client/a.mjs"], leaseHours: 48 });
  await call("owner", "create", "taken-next", { id: "taken-next", title: "Taken next" });
  await call("holder", "claim", "taken-next", { files: ["server/other.mjs"], leaseHours: 48 });
  const beforeSource = registry.get("room1", "taken");
  const beforeNext = registry.get("room1", "taken-next");

  assert.throws(
    () => mirrorProjectionClaim(store, "room1", "other", {
      type: "work.handoff_recorded",
      at,
      data: { workItemId: "taken", doneSummary: "partial", nextAction: "continue the adapter", limitReason: "context" },
    }),
    error => error.code === "work_claim_conflict"
  );

  const source = registry.get("room1", "taken");
  const next = registry.get("room1", "taken-next");
  assert.equal(source.state, "claimed");
  assert.equal(source.owner, "other");
  assert.deepEqual(source.files, ["client/a.mjs"]);
  assert.equal(source.chain?.length ?? 0, beforeSource.chain?.length ?? 0);
  assert.equal(next.state, "claimed");
  assert.equal(next.owner, "holder");
  assert.deepEqual(next.files, beforeNext.files);
  assert.equal((next.dependsOn ?? []).includes("taken"), false);
});

test("a handoff still creates a successor when that card is free", async () => {
  const { registry, store, call } = board();
  await call("owner", "create", "lane", { id: "lane", title: "Lane" });
  await call("other", "claim", "lane", { files: ["client/a.mjs"], leaseHours: 24 });
  const successor = mirrorProjectionClaim(store, "room1", "other", {
    type: "work.handoff_recorded",
    at,
    data: { workItemId: "lane", doneSummary: "partial", nextAction: "Review the header", limitReason: "context" },
  });
  assert.equal(successor.id, "lane-next");
  assert.equal(successor.state, "unclaimed");
  assert.deepEqual(successor.dependsOn, ["lane"]);
  assert.equal(registry.get("room1", "lane").chain.at(-1).targetId, "lane-next");
});

test("a supersede does not adopt another member's live card as the replacement", async () => {
  const { registry, store, call } = board();
  await call("owner", "create", "old-lane", { id: "old-lane", title: "Old lane" });
  await call("other", "claim", "old-lane", { files: ["client/a.mjs"], leaseHours: 24 });
  await call("owner", "create", "replacement", { id: "replacement", title: "Replacement" });
  await call("holder", "claim", "replacement", { files: ["server/other.mjs"], leaseHours: 48 });

  assert.throws(
    () => mirrorProjectionClaim(store, "room1", "other", {
      type: "work.superseded",
      at,
      data: { workItemId: "old-lane", supersededByWorkItemId: "replacement", reason: "Direction changed" },
    }),
    error => error.code === "work_claim_conflict"
  );

  const source = registry.get("room1", "old-lane");
  const next = registry.get("room1", "replacement");
  assert.equal(source.supersededBy ?? null, null);
  assert.equal(source.owner, "other");
  assert.equal(next.owner, "holder");
  assert.deepEqual(next.files, ["server/other.mjs"]);
});
