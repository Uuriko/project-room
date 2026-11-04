import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { planningPatchOf, sortPlanning } from "../server/board-planning.mjs";

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: "add-lead", type: "member.added", data: { memberId: "lead", displayName: "lead", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  t.after(() => { store.close(); delete process.env.ROOM_BOARD_PLANNING_FIELDS; });
  const call = async (route, { id = null, body, query = "" } = {}) => {
    try {
      const out = await handleWorkClaims({ req: { method: body === undefined ? "GET" : "POST", body }, res: {},
        url: new URL(`https://room.example/api/rooms/commons/work-claims${query}`), store, roomId: "commons",
        auth: { member: { id: "lead", kind: "agent", permissions: [] } }, workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims });
      return { status: out.status, value: out.value };
    } catch (error) { if (!Number.isInteger(error.status)) throw error; return { status: error.status, code: error.code }; }
  };
  return { store, call };
}

test("pure: type checks, null clears, dueAt normalized, missing sorts last", () => {
  assert.deepEqual(planningPatchOf({ priority: 1, dueAt: "2030-01-01T00:00:00Z", cycleId: null }).patch,
    { priority: 1, dueAt: "2030-01-01T00:00:00.000Z", cycleId: null });
  assert.ok(planningPatchOf({ priority: "high" }).error);
  assert.ok(planningPatchOf({ dueAt: "soon" }).error);
  const sorted = sortPlanning([{ id: "a" }, { id: "b", planning: { priority: 2 } }, { id: "c", planning: { priority: 0 } }], "priority");
  assert.deepEqual(sorted.map(i => i.id), ["c", "b", "a"]);
});

test("flag off: planning fields are unknown (422), as today", async t => {
  const f = fixture(t);
  const r = await f.call("create", { body: { id: "w0", title: "w0", priority: 2 } });
  assert.equal(r.status, 422);
});

test("flag on: create, update, filter and sort", async t => {
  process.env.ROOM_BOARD_PLANNING_FIELDS = "1";
  const f = fixture(t);
  for (const [id, extra] of [["w1", { priority: 2, estimate: 3, cycleId: "c1", milestone: "m1", dueAt: "2030-02-01T00:00:00Z" }],
    ["w2", { priority: 0, cycleId: "c1" }], ["w3", {}]]) {
    const r = await f.call("create", { body: { id, title: id, ...extra } });
    assert.equal(r.status === 200 || r.status === 201, true, `${id} ${r.status} ${r.code}`);
  }
  assert.equal(f.store.workClaims.get("commons", "w1").planning.milestone, "m1");
  const bad = await f.call("create", { body: { id: "w4", title: "w4", estimate: "big" } });
  assert.equal(bad.status, 422);
  const upd = await f.call("update", { id: "w3", body: { priority: 1, dueAt: "2030-01-01T00:00:00Z" } });
  assert.equal(upd.status, 200, upd.code);
  assert.equal(f.store.workClaims.get("commons", "w3").planning.priority, 1);
  const cleared = await f.call("update", { id: "w1", body: { milestone: null } });
  assert.equal(cleared.status, 200);
  assert.equal("milestone" in f.store.workClaims.get("commons", "w1").planning, false);
  const cyc = await f.call("list", { query: "?cycleId=c1" });
  assert.deepEqual(cyc.value.claims.map(c => c.id).sort(), ["w1", "w2"]);
  const byPri = await f.call("list", { query: "?sort=priority" });
  assert.deepEqual(byPri.value.claims.map(c => c.id), ["w2", "w3", "w1"]);
  const byDue = await f.call("list", { query: "?sort=dueAt" });
  assert.deepEqual(byDue.value.claims.map(c => c.id), ["w3", "w1", "w2"]);
  const due = await f.call("list", { query: "?dueBefore=2030-01-15T00:00:00Z" });
  assert.deepEqual(due.value.claims.map(c => c.id), ["w3"]);
  assert.equal((await f.call("list", { query: "?sort=title" })).status, 422);
});

test("projects: flag off refuses project fields; on: set, filter, groupBy", async t => {
  process.env.ROOM_BOARD_PLANNING_FIELDS = "1";
  t.after(() => { delete process.env.ROOM_BOARD_PROJECTS; });
  const f = fixture(t);
  assert.equal((await f.call("create", { body: { id: "p0", title: "p0", projectId: "alpha" } })).status, 422);
  assert.equal((await f.call("list", { query: "?groupBy=projectId" })).status, 422);
  process.env.ROOM_BOARD_PROJECTS = "1";
  for (const [id, extra] of [["p1", { projectId: "alpha", initiativeId: "q1" }], ["p2", { projectId: "beta", initiativeId: "q1" }], ["p3", {}], ["p4", { projectId: "alpha" }]]) {
    const r = await f.call("create", { body: { id, title: id, ...extra } });
    assert.ok(r.status === 200 || r.status === 201, `${id} ${r.code}`);
  }
  assert.equal((await f.call("update", { id: "p3", body: { projectId: "beta" } })).status, 200);
  const alpha = await f.call("list", { query: "?projectId=alpha" });
  assert.deepEqual(alpha.value.claims.map(c => c.id).sort(), ["p1", "p4"]);
  const g = await f.call("list", { query: "?groupBy=initiativeId" });
  assert.equal(g.value.groupBy, "initiativeId");
  const q1 = g.value.groups.find(x => x.key === "q1");
  assert.deepEqual(q1.claimIds.sort(), ["p1", "p2"]);
  assert.equal(g.value.groups.at(-1).key, null);
  const gs = await f.call("list", { query: "?groupBy=projectId&view=summary" });
  assert.equal(gs.value.groups.find(x => x.key === "beta").count, 2);
  assert.equal((await f.call("list", { query: "?groupBy=title" })).status, 422);
});
