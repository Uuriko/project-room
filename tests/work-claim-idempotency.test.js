// QA200 mutation probe (qa200-mut-01): CREATE idempotency + per-identity cap.
// These tests pin the HTTP contract that duplicate CREATEs and cap-breaking
// CREATEs are refused with 409, so a future regression that silently accepts
// them (200) cannot slip through.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { DEFAULT_MAX_MEMBER_OPEN_CLAIMS } from "../server/work-claims.mjs";

const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true, permissions: ["manage_claims", "accept_work", "complete_work", "verify", "steer"] },
  holder: { id: "holder", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
};

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  // Mirror the server's refusal shape: handleWorkClaims converts a thrown
  // refusal to {status, value} only when it carries error.body.
  reject: (status, code, message) => {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    error.body = { error: { code, message } };
    throw error;
  },
  body: async req => req.body,
};

const call = (registry, memberId, route, id, body, query = "") => handleWorkClaims({
  req: { method: "POST", body },
  res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${query}`),
  store: { roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }), room: () => ({ state: { messages: [] } }) },
  roomId: "room1",
  auth: { member: { id: memberId, kind: MEMBERS[memberId].kind, permissions: MEMBERS[memberId].permissions } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});

test("duplicate CREATE returns 409 work_claim_exists and leaves the claim unchanged", async () => {
  const registry = createWorkClaimRegistry();
  const first = await call(registry, "owner", "create", null, { id: "idem-1", title: "First write" });
  assert.equal(first.status, 201);
  assert.equal(first.value.title, "First write");
  const second = await call(registry, "owner", "create", null, { id: "idem-1", title: "Second write" });
  assert.equal(second.status, 409, "duplicate CREATE must not be accepted");
  assert.equal(second.value.error.code, "work_claim_exists");
  assert.equal(registry.get("room1", "idem-1").title, "First write");
  assert.equal(registry.list("room1").length, 1);
});

test("CREATE with assignee refuses 409 too_many_open_claims when the assignee is at cap", async () => {
  const registry = createWorkClaimRegistry();
  registry.configure("room1", { maxMemberOpenClaims: 1 });
  const first = await call(registry, "owner", "create", null, { id: "assign-1", title: "First", assignee: "holder" });
  assert.equal(first.status, 201, "first assign-create should succeed");
  assert.equal(first.value.owner, "holder");
  assert.equal(first.value.state, "claimed");
  const second = await call(registry, "owner", "create", null, { id: "assign-2", title: "Second", assignee: "holder" });
  assert.equal(second.status, 409, "assign-create over the per-member cap must not be accepted");
  assert.equal(second.value.error.code, "too_many_open_claims");
  assert.equal(registry.has("room1", "assign-2"), false);
  assert.equal(
    registry.list("room1").filter(item => item.owner === "holder").length, 1,
    "the cap break must not leave a second held claim behind",
  );
});

test("claim route still refuses 409 too_many_open_claims at the default cap", async () => {
  const registry = createWorkClaimRegistry();
  for (let index = 0; index < DEFAULT_MAX_MEMBER_OPEN_CLAIMS + 1; index += 1) {
    assert.equal((await call(registry, "owner", "create", null, { id: `capm-${index}` })).status, 201);
  }
  for (let index = 0; index < DEFAULT_MAX_MEMBER_OPEN_CLAIMS; index += 1) {
    assert.equal((await call(registry, "holder", "claim", `capm-${index}`, {})).status, 200);
  }
  const over = await call(registry, "holder", "claim", `capm-${DEFAULT_MAX_MEMBER_OPEN_CLAIMS}`, {});
  assert.equal(over.status, 409);
  assert.equal(over.value.error.code, "too_many_open_claims");
});
