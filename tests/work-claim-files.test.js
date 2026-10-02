// Work claims can declare the files they will touch. A claim whose files
// overlap another live claim is refused: 409 file_lease_conflict names the
// holder, the files, and the lease expiry, and the refused claim stays
// unclaimed. advisory: true still claims and returns fileWarnings. Closed
// claims and claims with no files never conflict.
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

test("claiming a file another active claim holds is refused with the holder, the files, and the lease expiry", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["scripts/room", "./docs/x.md"] });
  const held = await call(registry, "jill", "claim", "a", {});
  await call(registry, "claude", "create", null, { id: "b" });
  const out = await call(registry, "claude", "claim", "b", { files: ["scripts/room", "tests/new.test.js"] });

  assert.equal(out.status, 409);
  assert.equal(out.value.error.code, "file_lease_conflict");
  assert.deepEqual(out.value.holder, { claimId: "a", owner: "jill" });
  assert.deepEqual(out.value.files, ["scripts/room"]);
  assert.equal(out.value.leaseExpiresAt, held.value.leaseExpiresAt);
  assert.equal(registry.get("room1", "b").state, "unclaimed");
  assert.deepEqual(registry.get("room1", "a").files, ["docs/x.md", "scripts/room"]);
});

test("advisory true still claims and names the other holder in fileWarnings", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["scripts/room"] });
  await call(registry, "jill", "claim", "a", {});
  await call(registry, "claude", "create", null, { id: "b" });
  const out = await call(registry, "claude", "claim", "b", { files: ["scripts/room", "tests/new.test.js"], advisory: true });

  assert.equal(out.status, 200);
  assert.equal(out.value.state, "claimed");
  assert.deepEqual(out.value.files, ["scripts/room", "tests/new.test.js"]);
  assert.deepEqual(out.value.fileWarnings, [{ file: "scripts/room", heldBy: [{ id: "a", owner: "jill" }] }]);
});

test("a lapsed lease frees the files, and a lease that never expires still blocks", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["scripts/room"] });
  await call(registry, "jill", "claim", "a", { leaseHours: null });
  await call(registry, "claude", "create", null, { id: "b", files: ["scripts/room"] });
  const blocked = await call(registry, "claude", "claim", "b", {});
  assert.equal(blocked.status, 409);
  assert.equal(blocked.value.leaseExpiresAt, null);
  assert.equal(blocked.value.holder.owner, "jill");

  registry.set("room1", { ...registry.get("room1", "a"), leaseExpiresAt: "2020-01-01T00:00:00.000Z" });
  const freed = await call(registry, "claude", "claim", "b", {});
  assert.equal(freed.status, 200);
  assert.equal(freed.value.state, "claimed");
  assert.equal(registry.get("room1", "a").state, "unclaimed");
});

test("the same owner cannot take a second live lease on the same file", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  await call(registry, "jill", "claim", "a", {});
  await call(registry, "jill", "create", null, { id: "b" });
  const out = await call(registry, "jill", "claim", "b", { files: ["server/a.mjs"] });
  assert.equal(out.status, 409);
  assert.equal(out.value.holder.claimId, "a");
  assert.equal(registry.get("room1", "b").state, "unclaimed");
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
