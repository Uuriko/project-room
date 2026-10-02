// Claims declare dependencies on other claims. GET /work-claims?queue=ready
// lists claims that nobody holds and whose dependencies are all done. A
// missing dependency is not done. Holding a claim takes it off the queue
// even when its dependencies are already done.
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

const call = (registry, route, id, body, queue = null) => handleWorkClaims({
  req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
  res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${queue ? `?queue=${queue}` : ""}`),
  store: { roomAuthority: () => ({ members: {
    ada: { id: "ada", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
  } }) }, roomId: "room1",
  auth: { member: { id: "ada", kind: "agent", permissions: [] } },
  workClaimRoute: route, workClaimId: id, helpers, registry,
});

test("the ready queue lists unheld claims whose dependencies are done", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "create", null, { id: "base", title: "Base" });
  await call(registry, "create", null, { id: "next", dependsOn: ["base"] });
  await call(registry, "create", null, { id: "later", dependsOn: ["missing"] });
  await call(registry, "create", null, { id: "free" });

  const waiting = await call(registry, "list", null, null, "ready");
  assert.equal(waiting.status, 200);
  assert.equal(waiting.value.queue, "ready");
  assert.deepEqual(waiting.value.claims.map(item => item.id), ["base", "free"]);

  await call(registry, "claim", "base", {});
  await call(registry, "update", "base", { state: "in_progress" });
  await call(registry, "update", "base", { state: "done" });
  const ready = await call(registry, "list", null, null, "ready");
  assert.deepEqual(ready.value.claims.map(item => item.id), ["free", "next"]);

  await call(registry, "claim", "next", {});
  const held = await call(registry, "list", null, null, "ready");
  assert.deepEqual(held.value.claims.map(item => item.id), ["free"]);
});

test("a claim cannot depend on itself, and an unknown queue is refused", async () => {
  const registry = createWorkClaimRegistry();
  await assert.rejects(call(registry, "create", null, { id: "loop", dependsOn: ["loop"] }), error => error.status === 422);
  await assert.rejects(call(registry, "list", null, null, "soon"), error => error.status === 422);
});

test("dependencies survive the durable claim registry", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const out = await handleWorkClaims({
    req: { method: "POST", body: { id: "child", dependsOn: ["parent"] } },
    res: {},
    url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons",
    auth: { member: { id: "owner", kind: "human", permissions: [] } },
    workClaimRoute: "create", helpers, registry: store.workClaims,
  });
  assert.equal(out.status, 201);
  assert.deepEqual(store.workClaims.get("commons", "child").dependsOn, ["parent"]);
});
