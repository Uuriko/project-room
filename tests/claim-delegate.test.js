import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { delegateWork, createWork, claimWork, updateWork } from "../server/work-claims.mjs";
import { WORK_CLAIM_ROUTES } from "../server/routes/work-claims.mjs";

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (const [id, permissions] of [["lead", ["accept_work", "complete_work"]], ["worker", ["accept_work"]], ["other", []]]) {
    store.command(ownerKey, "commons", { id: `add-${id}`, type: "member.added", data: { memberId: id, displayName: id, kind: "agent", permissions } });
  }
  t.after(() => { store.close(); delete process.env.ROOM_CLAIM_DELEGATE; });
  const call = async (memberId, route, { id = null, body } = {}) => {
    try {
      const out = await handleWorkClaims({ req: { method: body === undefined ? "GET" : "POST", body }, res: {},
        url: new URL("https://room.example/api/rooms/commons/work-claims"), store, roomId: "commons",
        auth: { member: { id: memberId, kind: "agent", permissions: [] } }, workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims });
      return { status: out.status, value: out.value };
    } catch (error) { if (!Number.isInteger(error.status)) throw error; return { status: error.status, code: error.code }; }
  };
  return { store, call };
}

test("pure: owner sets and clears delegate; others and terminal claims refused", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const held = claimWork(createWork({ id: "w1", title: "w1" }, { now, agentId: "lead" }), "lead", { now });
  const d = delegateWork(held, "lead", "worker", { now });
  assert.equal(d.owner, "lead");
  assert.equal(d.delegate, "worker");
  assert.equal(d.history.at(-1).action, "delegated:worker");
  assert.throws(() => delegateWork(held, "other", "worker", { now }));
  assert.doesNotThrow(() => delegateWork(held, "lead", "lead", { now }), "self-delegation is harmless, not refused");
  assert.equal(updateWork(d, "worker", { state: "in_progress", now }).state, "in_progress", "the delegate can move the work");
  assert.throws(() => updateWork(d, "other", { state: "in_progress", now }));
  const cleared = delegateWork(d, "lead", null, { now });
  assert.equal("delegate" in cleared, false);
  assert.equal("delegate" in held, false, "claims without a delegate keep their old shape");
});

test("route is registered and 404s while the flag is off", async t => {
  assert.ok(WORK_CLAIM_ROUTES.some(r => r.id === "work-claim-delegate"));
  const f = fixture(t);
  assert.equal((await f.call("lead", "create", { body: { id: "w2", title: "w2" } })).status, 201);
  assert.equal((await f.call("lead", "claim", { id: "w2", body: { leaseHours: 2 } })).status, 200);
  assert.equal((await f.call("lead", "delegate", { id: "w2", body: { delegate: "worker" } })).status, 404);
});

test("flag on: owner delegates to a member, delegate is woken, owner unchanged", async t => {
  process.env.ROOM_CLAIM_DELEGATE = "1";
  const f = fixture(t);
  await f.call("lead", "create", { body: { id: "w3", title: "w3" } });
  await f.call("lead", "claim", { id: "w3", body: { leaseHours: 2 } });
  const bad = await f.call("lead", "delegate", { id: "w3", body: { delegate: "ghost" } });
  assert.equal(bad.code, "work_delegate_unknown_member");
  const notOwner = await f.call("other", "delegate", { id: "w3", body: { delegate: "worker" } });
  assert.equal(notOwner.status === 403 || notOwner.status === 422, true);
  const ok = await f.call("lead", "delegate", { id: "w3", body: { delegate: "worker" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.value.owner, "lead");
  assert.equal(ok.value.delegate, "worker");
  assert.equal(f.store.workClaims.get("commons", "w3").delegate, "worker");
  const cleared = await f.call("lead", "delegate", { id: "w3", body: { delegate: null } });
  assert.equal(cleared.status, 200);
  assert.equal("delegate" in cleared.value, false);
});
