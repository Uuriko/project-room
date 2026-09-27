// Work claims can declare the files they will touch, and claiming warns when
// another active claim already declares one of them. Contract guarded: the
// claim still succeeds (warn, never block), the warning names the other claim
// and its owner, and closed claims or claims with no files never warn. This is
// the in-room version of the #266 file-overlap rule, which today only exists
// as prose checks on the board.
import test from "node:test";
import assert from "node:assert/strict";
import { createWork } from "../server/work-claims.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";

const helpers = () => ({
  json: (res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
});

const call = (registry, member, route, id, body) => handleWorkClaims({
  req: { method: route === "read" ? "GET" : "POST", body },
  res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${id ? `/${id}/${route}` : ""}`),
  store: {},
  roomId: "room1",
  auth: { member: { id: member, kind: "agent", permissions: [] } },
  workClaimRoute: route,
  workClaimId: id,
  helpers: helpers(),
  registry,
});

test("claiming a file another active claim holds succeeds and warns with the holder", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["scripts/room", "./docs/x.md"] });
  await call(registry, "jill", "claim", "a", {});
  await call(registry, "claude", "create", null, { id: "b" });
  const out = await call(registry, "claude", "claim", "b", { files: ["scripts/room", "tests/new.test.js"] });

  assert.equal(out.status, 200);
  assert.equal(out.value.state, "claimed");
  assert.deepEqual(out.value.files, ["scripts/room", "tests/new.test.js"]);
  assert.deepEqual(out.value.fileWarnings, [{ file: "scripts/room", heldBy: [{ id: "a", owner: "jill" }] }]);
});

test("done claims and claims without files never produce warnings", async () => {
  const registry = createWorkClaimRegistry();
  registry.set("room1", { ...createWork({ id: "old", files: ["scripts/room"] }), state: "done", owner: "jill" });
  await call(registry, "grokbot", "create", null, { id: "nofiles" });
  await call(registry, "grokbot", "claim", "nofiles", {});
  await call(registry, "claude", "create", null, { id: "b", files: ["scripts/room"] });
  const out = await call(registry, "claude", "claim", "b", {});
  assert.deepEqual(out.value.files, ["scripts/room"]);
  assert.deepEqual(out.value.fileWarnings, []);
});

test("paths are normalized and paths that escape the repo are refused", async () => {
  const registry = createWorkClaimRegistry();
  const made = await call(registry, "claude", "create", null, { id: "n", files: ["./server//store.mjs", "server/store.mjs", "docs/"] });
  assert.deepEqual(made.value.files, ["docs", "server/store.mjs"]);
  for (const bad of ["../etc/passwd", "/abs/path", "server/../../x"]) {
    await assert.rejects(call(registry, "claude", "create", null, { id: `bad${bad.length}`, files: [bad] }), error => error.status === 422);
  }
});
