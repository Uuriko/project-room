import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { requestApproval, decideApproval, updateWork, createWork, claimWork } from "../server/work-claims.mjs";
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
  for (const [id, permissions] of [["lead", ["accept_work", "complete_work"]], ["boss", ["accept_work"]], ["other", []]]) {
    store.command(ownerKey, "commons", { id: `add-${id}`, type: "member.added", data: { memberId: id, displayName: id, kind: "agent", permissions } });
  }
  t.after(() => { store.close(); delete process.env.ROOM_APPROVAL_HOLD; });
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

const now = Date.parse("2026-11-03T12:00:00Z");
const started = () => updateWork(claimWork(createWork({ id: "w1", title: "w1" }, { now, agentId: "lead" }), "lead", { now }), "lead", { state: "in_progress", now });

test("pure: pending hold blocks delivery until the approver approves", () => {
  const held = requestApproval(started(), "lead", { approverId: "boss", step: "drop prod table x", now });
  assert.equal(held.approvalHold.status, "pending");
  assert.throws(() => updateWork(held, "lead", { state: "delivered", now }), /on hold/);
  assert.throws(() => decideApproval(held, "other", { decision: "approve", now }));
  assert.throws(() => requestApproval(held, "lead", { approverId: "boss", step: "again", now }));
  assert.throws(() => requestApproval(started(), "lead", { approverId: "lead", step: "self", now }));
  assert.throws(() => requestApproval(started(), "other", { approverId: "boss", step: "x", now }));
  const ok = decideApproval(held, "boss", { decision: "approve", now });
  assert.equal(ok.approvalHold.status, "approved");
  assert.equal(updateWork(ok, "lead", { state: "delivered", now }).state, "delivered");
  const no = decideApproval(held, "boss", { decision: "deny", now });
  assert.equal(no.approvalHold.status, "denied");
  assert.equal("approvalHold" in started(), false);
});

test("route registered; 404 while flag off", async t => {
  assert.ok(WORK_CLAIM_ROUTES.some(r => r.id === "work-claim-approval"));
  const f = fixture(t);
  await f.call("lead", "create", { body: { id: "w2", title: "w2" } });
  await f.call("lead", "claim", { id: "w2", body: { leaseHours: 2 } });
  assert.equal((await f.call("lead", "approval", { id: "w2", body: { action: "request", approver: "boss", step: "x" } })).status, 404);
});

test("flag on: request wakes approver, delivery refused, approve lets it through", async t => {
  process.env.ROOM_APPROVAL_HOLD = "1";
  const f = fixture(t);
  await f.call("lead", "create", { body: { id: "w3", title: "w3" } });
  await f.call("lead", "claim", { id: "w3", body: { leaseHours: 2 } });
  await f.call("lead", "update", { id: "w3", body: { state: "in_progress" } });
  assert.equal((await f.call("lead", "approval", { id: "w3", body: { action: "request", approver: "ghost", step: "x" } })).code, "work_approver_unknown_member");
  const req = await f.call("lead", "approval", { id: "w3", body: { action: "request", approver: "boss", step: "force-push main" } });
  assert.equal(req.status, 200, JSON.stringify(req));
  assert.equal(f.store.workClaims.get("commons", "w3").approvalHold.status, "pending");
  const last = f.store.db.prepare("SELECT body FROM events WHERE room_id='commons' AND json_extract(body,'$.type')='work_claim.updated' ORDER BY rowid DESC LIMIT 1").get();
  assert.match(last.body, /"approval"/);
  assert.match(last.body, /boss/, "the approver is named on the attention receipt");
  const blocked = await f.call("lead", "update", { id: "w3", body: { state: "delivered" } });
  assert.notEqual(blocked.status, 200);
  // FUNNEL-FIXES C2: a member with no approval relationship to the claim is
  // refused with the generic 403 work_not_owner before any load-dependent
  // answer (deliberate change from the post-load 422, PACK-REVISION-2 §1.1).
  assert.equal((await f.call("other", "approval", { id: "w3", body: { action: "approve" } })).status, 403);
  const ok = await f.call("boss", "approval", { id: "w3", body: { action: "approve" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.value.approvalHold.status, "approved");
});
