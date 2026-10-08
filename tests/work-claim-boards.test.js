// Sharded claim boards: namespaces partition a room's claims into
// independent boards, each with its own open-claim cap. The default board
// behaves exactly like the old single board (backward compatible).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, displayName, kind, permissions) => store.command(ownerKey, "commons", {
    id: `add-${id}`, type: "member.added",
    data: { memberId: id, displayName, kind, permissions }
  });
  add("coord", "Coord", "agent", ["accept_work", "complete_work"]);
  const coordKey = store.issueAccessKey("commons", "coord");
  const server = createRoomServer({ store, githubToken: "test-token" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, path, body) => {
    const response = await fetch(`${origin}/api/rooms/commons${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, value: await response.json() };
  };
  return { store, ownerKey, coordKey, call };
}

test("creates a claim on a named board", async t => {
  const { call, ownerKey } = await fixture(t);
  const created = await call(ownerKey, "/work-claims", { id: "b1", namespace: "guild-load" });
  assert.equal(created.status, 201);
  assert.equal(created.value.namespace, "guild-load");
});

test("defaults to the default board", async t => {
  const { call, ownerKey } = await fixture(t);
  const created = await call(ownerKey, "/work-claims", { id: "b2" });
  assert.equal(created.status, 201);
  assert.equal(created.value.namespace, "default");
});

test("rejects an invalid namespace", async t => {
  const { call, ownerKey } = await fixture(t);
  const created = await call(ownerKey, "/work-claims", { id: "b3", namespace: "no spaces!" });
  assert.equal(created.status, 422);
});

test("enforces independent per-board caps", async t => {
  const { call, ownerKey } = await fixture(t);
  const cfg = await call(ownerKey, "/work-claims/config", { maxMemberOpenClaims: 20, boards: { "guild-a": { maxOpenClaims: 2 } } });
  assert.equal(cfg.status, 200);
  assert.equal((await call(ownerKey, "/work-claims", { id: "a1", namespace: "guild-a" })).status, 201);
  assert.equal((await call(ownerKey, "/work-claims", { id: "a2", namespace: "guild-a" })).status, 201);
  const full = await call(ownerKey, "/work-claims", { id: "a3", namespace: "guild-a" });
  assert.equal(full.status, 409);
  assert.equal(full.value.error.code, "work_board_full");
  assert.match(full.value.error.message, /guild-a/);
  // Another board is unaffected by guild-a's cap.
  assert.equal((await call(ownerKey, "/work-claims", { id: "b1", namespace: "guild-b" })).status, 201);
  // And the default board keeps the room-level default (200), not guild-a's 2.
  assert.equal((await call(ownerKey, "/work-claims", { id: "d1" })).status, 201);
  assert.equal((await call(ownerKey, "/work-claims", { id: "d2" })).status, 201);
  assert.equal((await call(ownerKey, "/work-claims", { id: "d3" })).status, 201);
});

test("counts the per-member cap across boards", async t => {
  const { call, ownerKey, coordKey } = await fixture(t);
  assert.equal((await call(ownerKey, "/work-claims/config", { maxMemberOpenClaims: 1 })).status, 200);
  assert.equal((await call(ownerKey, "/work-claims", { id: "m1", namespace: "guild-a", assignee: "coord" })).status, 201);
  const blocked = await call(ownerKey, "/work-claims", { id: "m2", namespace: "guild-b", assignee: "coord" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.value.error.code, "too_many_open_claims");
});

test("keeps claim ids room-unique across boards", async t => {
  const { call, ownerKey } = await fixture(t);
  assert.equal((await call(ownerKey, "/work-claims", { id: "dup", namespace: "guild-a" })).status, 201);
  const again = await call(ownerKey, "/work-claims", { id: "dup", namespace: "guild-b" });
  assert.equal(again.status, 409);
  assert.equal(again.value.error.code, "work_claim_exists");
});

test("un-namespaced list shows the default board", async t => {
  const { call, ownerKey } = await fixture(t);
  await call(ownerKey, "/work-claims", { id: "l1", namespace: "guild-a" });
  await call(ownerKey, "/work-claims", { id: "l2" });
  const listed = await call(ownerKey, "/work-claims?view=summary");
  assert.equal(listed.status, 200);
  const ids = (listed.value.claims ?? []).map(item => item.id);
  assert.deepEqual(ids.sort(), ["l2"]);
});

test("global view merges boards with namespace stamped", async t => {
  const { call, ownerKey } = await fixture(t);
  await call(ownerKey, "/work-claims", { id: "g1", namespace: "guild-a" });
  await call(ownerKey, "/work-claims", { id: "g2" });
  const merged = await call(ownerKey, "/work-claims?namespace=*&view=summary");
  assert.equal(merged.status, 200);
  const byId = Object.fromEntries((merged.value.claims ?? []).map(item => [item.id, item.namespace]));
  assert.deepEqual(byId, { g1: "guild-a", g2: "default" });
});

test("boards route lists per-board counts", async t => {
  const { call, ownerKey } = await fixture(t);
  await call(ownerKey, "/work-claims", { id: "s1", namespace: "guild-a" });
  await call(ownerKey, "/work-claims", { id: "s2", namespace: "guild-a" });
  await call(ownerKey, "/work-claims", { id: "s3" });
  const boards = await call(ownerKey, "/work-claim-boards");
  assert.equal(boards.status, 200);
  const byNs = Object.fromEntries(boards.value.boards.map(b => [b.namespace, b]));
  assert.equal(byNs["guild-a"].total, 2);
  assert.equal(byNs["guild-a"].open, 2);
  assert.equal(byNs["guild-a"].cap, 200);
  assert.equal(byNs["default"].total, 1);
});

test("claim-scoped routes resolve across boards", async t => {
  const { call, ownerKey } = await fixture(t);
  await call(ownerKey, "/work-claims", { id: "r1", namespace: "guild-a" });
  // No namespace on the read: resolved by id across boards.
  const read = await call(ownerKey, "/work-claims/r1");
  assert.equal(read.status, 200);
  assert.equal(read.value.namespace, "guild-a");
  // Explicit namespace also works.
  const readNs = await call(ownerKey, "/work-claims/r1?namespace=guild-a");
  assert.equal(readNs.status, 200);
});

test("durable registry persists namespaces across reopen", async t => {
  const { call, ownerKey, store } = await fixture(t);
  await call(ownerKey, "/work-claims", { id: "p1", namespace: "guild-a" });
  const again = store.workClaims;
  const item = again.get("commons", "p1");
  assert.equal(item.namespace, "guild-a");
  const listed = again.list("commons", "guild-a");
  assert.deepEqual(listed.map(i => i.id), ["p1"]);
  assert.deepEqual(again.list("commons", "default").map(i => i.id), []);
});
