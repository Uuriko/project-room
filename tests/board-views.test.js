import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { viewQueryOf, withSavedView } from "../server/board-views.mjs";
import { postBoardViews, BOARD_VIEW_ROUTES } from "../server/routes/board-views.mjs";
import { ROUTES } from "../server/routes/table.mjs";

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
  t.after(() => { store.close(); delete process.env.ROOM_BOARD_VIEWS; delete process.env.ROOM_BOARD_PLANNING_FIELDS; });
  const call = async (route, { id = null, body, query = "" } = {}) => {
    try {
      const out = await handleWorkClaims({ req: { method: body === undefined ? "GET" : "POST", body }, res: {},
        url: new URL(`https://room.example/api/rooms/commons/work-claims${query}`), store, roomId: "commons",
        auth: { member: { id: "lead", kind: "agent", permissions: [] } }, workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims });
      return { status: out.status, value: out.value };
    } catch (error) { if (!Number.isInteger(error.status)) throw error; return { status: error.status, code: error.code }; }
  };
  const admin = async (memberId, body) => {
    const ctx = { params: { roomId: "commons" }, req: {}, res: {}, url: new URL("https://room.example/"), store,
      roomCredentials: () => ({ mode: "room", bearer: false }), expectedBinding: () => null, accountBinding: () => null,
      roomAuth: () => ({ member: { id: memberId }, credentialScope: "room", credentialHash: memberId }),
      protectWrite: () => {}, rate: () => {}, body: async () => body, json: helpers.json, reject: helpers.reject };
    try { return await postBoardViews(ctx); } catch (error) { if (!Number.isInteger(error.status)) throw error; return { status: error.status, code: error.code }; }
  };
  return { store, call, admin };
}

test("pure: only Board list keys; explicit params win over the saved ones", () => {
  assert.deepEqual(viewQueryOf({ sort: "priority", priority: 1 }), { sort: "priority", priority: "1" });
  assert.equal(viewQueryOf({ secret: "x" }), null);
  assert.equal(viewQueryOf({}), null);
  const merged = withSavedView(new URLSearchParams("savedView=v&state=blocked"), { query: { state: "claimed", sort: "dueAt" } });
  assert.equal(merged.toString(), "state=blocked&sort=dueAt");
});

test("route is in the table and 404s with the flag off", async t => {
  assert.ok(ROUTES.includes(BOARD_VIEW_ROUTES[0]));
  const f = fixture(t);
  assert.equal((await f.admin("lead", { list: true })).status, 404);
});

test("flag on: save a view, read the Board through it, delete it", async t => {
  process.env.ROOM_BOARD_VIEWS = "1";
  process.env.ROOM_BOARD_PLANNING_FIELDS = "1";
  const f = fixture(t);
  await f.call("create", { body: { id: "w1", title: "w1", cycleId: "c1", priority: 2 } });
  await f.call("create", { body: { id: "w2", title: "w2", cycleId: "c1", priority: 0 } });
  await f.call("create", { body: { id: "w3", title: "w3" } });
  const made = await f.admin("lead", { create: { name: "Cycle 1 by priority", query: { cycleId: "c1", sort: "priority" } } });
  assert.equal(made.status, 201);
  const viewId = made.value.view.viewId;
  assert.equal((await f.admin("lead", { create: { name: "bad", query: { owner: "x" } } })).status, 422);
  assert.equal((await f.admin("lead", { list: true })).value.views.length, 1);
  const page = await f.call("list", { query: `?savedView=${viewId}` });
  assert.deepEqual(page.value.claims.map(c => c.id), ["w2", "w1"]);
  assert.equal((await f.call("list", { query: "?savedView=view_missing" })).status, 404);
  assert.equal((await f.admin("someone", { delete: viewId })).status, 403);
  assert.equal((await f.admin("lead", { delete: viewId })).status, 200);
});
