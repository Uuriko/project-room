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
  store: { roomAuthority: () => ({ members: {
    jill: { id: "jill", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
    claude: { id: "claude", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
    grokbot: { id: "grokbot", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
    ada: { id: "ada", kind: "agent", active: true, permissions: ["accept_work", "complete_work", "manage_claims"] },
  } }) },
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

// QA200 ch-2037 challenge: create-with-assignee is an acquire path that never
// touched the claim route — it landed overlapping file leases silently (201).
// The exclusivity check must run there too; the request is one transaction,
// so a conflict fails atomically and the item is never created.
test("create with assignee refuses overlapping file leases (409 file_lease_conflict)", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  await call(registry, "jill", "claim", "a", {});
  const out = await call(registry, "claude", "create", null, { id: "b", files: ["server/a.mjs"], assignee: "ada" });

  assert.equal(out.status, 409);
  assert.equal(out.value.error.code, "file_lease_conflict");
  assert.deepEqual(out.value.holder, { claimId: "a", owner: "jill" });
  assert.deepEqual(out.value.files, ["server/a.mjs"]);
  assert.equal(registry.has("room1", "b"), false);
  assert.deepEqual(registry.get("room1", "a").files, ["server/a.mjs"]);
});

test("create with assignee and disjoint files still claims (201)", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  await call(registry, "jill", "claim", "a", {});
  const out = await call(registry, "claude", "create", null, { id: "b", files: ["server/b.mjs"], assignee: "ada" });

  assert.equal(out.status, 201);
  assert.equal(out.value.state, "claimed");
  assert.equal(out.value.owner, "ada");
  assert.deepEqual(out.value.files, ["server/b.mjs"]);
});

// QA200 ch-2037 challenge: reassign is an acquire path too — a fresh
// unclaimed item with declared files lands claimed, and an active claim
// changes hands, both without touching the claim route. Overlap must 409.
test("reassign of an unclaimed file-declared item refuses on overlap (409)", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  await call(registry, "jill", "claim", "a", {});
  await call(registry, "claude", "create", null, { id: "b", files: ["server/a.mjs"] });
  const out = await call(registry, "claude", "reassign", "b", { newOwner: "ada" });

  assert.equal(out.status, 409);
  assert.equal(out.value.error.code, "file_lease_conflict");
  assert.deepEqual(out.value.holder, { claimId: "a", owner: "jill" });
  assert.equal(registry.get("room1", "b").state, "unclaimed");
  assert.equal(registry.get("room1", "b").owner, null);
});

test("reassign of an active claim to a holder of overlapping files refuses (409)", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  await call(registry, "jill", "claim", "a", {});
  // ada deliberately holds the overlap via advisory warn-and-proceed
  await call(registry, "claude", "create", null, { id: "b" });
  await call(registry, "ada", "claim", "b", { files: ["server/a.mjs"], advisory: true });
  const out = await call(registry, "jill", "reassign", "a", { newOwner: "ada" });

  assert.equal(out.status, 409);
  assert.equal(out.value.error.code, "file_lease_conflict");
  assert.equal(registry.get("room1", "a").owner, "jill");
});

test("reassign with no file overlap still transfers (200)", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  await call(registry, "jill", "claim", "a", {});
  const out = await call(registry, "jill", "reassign", "a", { newOwner: "ada" });

  assert.equal(out.status, 200);
  assert.equal(out.value.owner, "ada");
  assert.equal(out.value.state, "claimed");
  assert.deepEqual(out.value.files, ["server/a.mjs"]);
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

test("different block labels on one file do not conflict, and a whole-file claim still does", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: [{ path: "scripts/room", block: "header" }] });
  const held = await call(registry, "jill", "claim", "a", {});
  assert.equal(held.status, 200);
  assert.deepEqual(held.value.fileBlocks, { "scripts/room": "header" });
  await call(registry, "claude", "create", null, { id: "b" });
  const other = await call(registry, "claude", "claim", "b", { files: [{ path: "scripts/room", region: "footer" }] });
  assert.equal(other.status, 200);
  assert.equal(other.value.state, "claimed");
  assert.deepEqual(other.value.fileBlocks, { "scripts/room": "footer" });
  await call(registry, "ada", "create", null, { id: "c" });
  const same = await call(registry, "ada", "claim", "c", { files: [{ path: "scripts/room", block: "header" }] });
  assert.equal(same.status, 409);
  assert.equal(same.value.error.code, "file_lease_conflict");
  assert.deepEqual(same.value.files, ["scripts/room (header)"]);
  await call(registry, "ada", "create", null, { id: "d" });
  const whole = await call(registry, "ada", "claim", "d", { files: ["scripts/room"] });
  assert.equal(whole.status, 409);
  assert.equal(whole.value.error.code, "file_lease_conflict");
  assert.equal(registry.get("room1", "d").state, "unclaimed");
});

// QA200-MUT-26 Probe C: the declared files are immutable after claim — the
// update shape excludes "files", so an update that tries to change them is a
// 422 invalid_claim_input. Without this pin, update could rewrite the lease
// scope out from under the 409 conflict check.
test("update cannot change the declared files after claim (files are immutable)", async () => {
  const registry = createWorkClaimRegistry();
  await call(registry, "jill", "create", null, { id: "a", files: ["server/a.mjs"] });
  await call(registry, "jill", "claim", "a", {});
  // the update is otherwise valid (a note), so only the files key is at issue
  await assert.rejects(call(registry, "jill", "update", "a", { note: "progress", files: ["server/b.mjs"] }),
    error => error.status === 422 && error.code === "invalid_claim_input");
  assert.deepEqual(registry.get("room1", "a").files, ["server/a.mjs"]);
});

test("paths are normalized and paths that escape the repo are refused", async () => {
  const registry = createWorkClaimRegistry();
  const made = await call(registry, "claude", "create", null, { id: "n", files: ["./server//store.mjs", "server/store.mjs", "docs/"] });
  assert.deepEqual(made.value.files, ["docs", "server/store.mjs"]);
  for (const bad of ["../etc/passwd", "/abs/path", "server/../../x"]) {
    await assert.rejects(call(registry, "claude", "create", null, { id: `bad${bad.length}`, files: [bad] }), error => error.status === 422);
  }
});
