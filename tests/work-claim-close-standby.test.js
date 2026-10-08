// Work-claim close/cancel + standby FIFO queue (B3 guild build).
// Fail-first: these tests were written before the implementation and must
// fail on the old code, then pass once close/cancel + standby land.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";

function fixture() {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (id, permissions) => store.command(ownerKey, "commons", {
    id: `add-${id}`, type: "member.added",
    data: { memberId: id, displayName: id, kind: "agent", permissions }
  });
  add("alice", ["accept_work", "complete_work"]);
  add("bob", ["accept_work", "complete_work"]);
  add("mgr", ["accept_work", "complete_work", "manage_claims"]);
  return { store };
}

async function call(store, { route, id = null, method = "POST", body = {}, member = "owner", search = "" }) {
  // B4 integration: B1's lease-first model made files mandatory at creation
  // (claim-channel addendum). These B3 tests predate that rule, so the
  // fixture supplies a default file on creates that don't name one.
  if (route === "create" && !("files" in body)) body = { ...body, files: [`tasks/${body.id ?? "claim"}.md`] };
  let out = null;
  const helpers = {
    body: async () => body,
    json: (res, status, value) => { out = { status, body: value }; },
    reject: (status, code, message, headers) => {
      const error = new Error(message);
      error.status = status; error.code = code; error.headers = headers;
      throw error;
    }
  };
  try {
    await handleWorkClaims({ req: { method }, res: {}, url: new URL(`http://localhost/${search}`),
      store, roomId: "commons", auth: { member: { id: member } },
      workClaimRoute: route, workClaimId: id, registry: store.workClaims, helpers });
  } catch (error) {
    if (error && Number.isInteger(error.status)) return { status: error.status, code: error.code, message: error.message };
    throw error;
  }
  return out;
}

const capCount = store => store.workClaims.list("commons")
  .filter(item => !["done", "cancelled", "standby"].includes(item.state)).length;
const lastHistory = item => item.history[item.history.length - 1];

// ---------- Priority 1: close/cancel ----------

test("close an unclaimed claim transitions it to cancelled and stamps history", async () => {
  const { store } = fixture();
  assert.equal((await call(store, { route: "create", body: { id: "c1" } })).status, 201);
  const closed = await call(store, { route: "close", id: "c1", body: { reason: "stale" } });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.state, "cancelled");
  assert.equal(closed.body.owner, null);
  assert.equal(closed.body.leaseStartAt, null);
  assert.equal(closed.body.leaseExpiresAt, null);
  const stamp = lastHistory(closed.body);
  assert.equal(stamp.action, "closed");
  assert.equal(stamp.agentId, "owner");
  assert.equal(stamp.note, "stale");
  store.close();
});

test("closing a claim frees a board slot: full -> close -> create succeeds", async () => {
  const { store } = fixture();
  store.workClaims.configure("commons", { maxOpenClaims: 3 });
  for (const id of ["a", "b", "c"]) assert.equal((await call(store, { route: "create", body: { id } })).status, 201);
  assert.equal(capCount(store), 3);
  const refused = await call(store, { route: "create", body: { id: "d" } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "work_board_full");
  const closed = await call(store, { route: "close", id: "a", body: { reason: "no longer needed" } });
  assert.equal(closed.status, 200);
  assert.equal(capCount(store), 2);
  const created = await call(store, { route: "create", body: { id: "d" } });
  assert.equal(created.status, 201);
  assert.equal(capCount(store), 3);
  store.close();
});

test("close a claimed claim cancels it and clears the holder", async () => {
  const { store } = fixture();
  await call(store, { route: "create", body: { id: "c1" } });
  assert.equal((await call(store, { route: "claim", id: "c1", member: "alice" })).status, 200);
  const closed = await call(store, { route: "close", id: "c1", member: "alice", body: { reason: "pivoting" } });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.state, "cancelled");
  assert.equal(closed.body.owner, null);
  assert.equal(closed.body.leaseExpiresAt, null);
  const stamp = lastHistory(closed.body);
  assert.equal(stamp.action, "closed");
  assert.equal(stamp.agentId, "alice");
  assert.equal(stamp.note, "pivoting");
  store.close();
});

test("a member who is not the holder, owner, or manage_claims gets 403", async () => {
  const { store } = fixture();
  await call(store, { route: "create", body: { id: "c1" } });
  assert.equal((await call(store, { route: "claim", id: "c1", member: "alice" })).status, 200);
  const denied = await call(store, { route: "close", id: "c1", member: "bob" });
  assert.equal(denied.status, 403);
  assert.equal(store.workClaims.get("commons", "c1").state, "claimed");
  store.close();
});

test("a manage_claims holder can close someone else's claim", async () => {
  const { store } = fixture();
  await call(store, { route: "create", body: { id: "c1" } });
  assert.equal((await call(store, { route: "claim", id: "c1", member: "alice" })).status, 200);
  const closed = await call(store, { route: "close", id: "c1", member: "mgr", body: { reason: "duplicate work" } });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.state, "cancelled");
  assert.equal(lastHistory(closed.body).agentId, "mgr");
  store.close();
});

test("the room owner can close an unclaimed claim they do not hold", async () => {
  const { store } = fixture();
  await call(store, { route: "create", body: { id: "c1" } });
  const closed = await call(store, { route: "close", id: "c1", body: {} });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.state, "cancelled");
  store.close();
});

test("closing an already-done claim is 422", async () => {
  const { store } = fixture();
  await call(store, { route: "create", body: { id: "c1" } });
  assert.equal((await call(store, { route: "claim", id: "c1", member: "alice" })).status, 200);
  assert.equal((await call(store, { route: "update", id: "c1", member: "alice", body: { state: "in_progress" } })).status, 200);
  assert.equal((await call(store, { route: "update", id: "c1", member: "alice", body: { state: "done" } })).status, 200);
  const closed = await call(store, { route: "close", id: "c1", member: "alice" });
  assert.equal(closed.status, 422);
  assert.equal(store.workClaims.get("commons", "c1").state, "done");
  store.close();
});

test("closing twice is idempotent and writes no extra history", async () => {
  const { store } = fixture();
  await call(store, { route: "create", body: { id: "c1" } });
  const first = await call(store, { route: "close", id: "c1", body: { reason: "x" } });
  assert.equal(first.status, 200);
  const before = first.body.history.length;
  const second = await call(store, { route: "close", id: "c1", body: { reason: "x" } });
  assert.equal(second.status, 200);
  assert.equal(second.body.state, "cancelled");
  assert.equal(second.body.history.length, before);
  store.close();
});

test("closing an unknown claim is 404", async () => {
  const { store } = fixture();
  const res = await call(store, { route: "close", id: "nope" });
  assert.equal(res.status, 404);
  store.close();
});

test("a cancelled claim is immutable via update", async () => {
  const { store } = fixture();
  await call(store, { route: "create", body: { id: "c1" } });
  await call(store, { route: "close", id: "c1" });
  const res = await call(store, { route: "update", id: "c1", body: { note: "late note" } });
  assert.equal(res.status, 422);
  store.close();
});

// ---------- Priority 2: standby FIFO ----------

test("a standby create bypasses a full board and does not count toward the cap", async () => {
  const { store } = fixture();
  store.workClaims.configure("commons", { maxOpenClaims: 2 });
  for (const id of ["a", "b"]) assert.equal((await call(store, { route: "create", body: { id } })).status, 201);
  assert.equal((await call(store, { route: "create", body: { id: "c" } })).status, 409);
  const parked = await call(store, { route: "create", body: { id: "s1", standby: true } });
  assert.equal(parked.status, 201);
  assert.equal(parked.body.state, "standby");
  assert.equal(capCount(store), 2);
  assert.equal((await call(store, { route: "create", body: { id: "c" } })).status, 409);
  store.close();
});

test("?standby=true creates a standby claim even when the board is full", async () => {
  const { store } = fixture();
  store.workClaims.configure("commons", { maxOpenClaims: 1 });
  assert.equal((await call(store, { route: "create", body: { id: "a" } })).status, 201);
  const parked = await call(store, { route: "create", body: { id: "s1" }, search: "?standby=true" });
  assert.equal(parked.status, 201);
  assert.equal(parked.body.state, "standby");
  store.close();
});

test("standby has its own cap: standby_full 409", async () => {
  const { store } = fixture();
  store.workClaims.configure("commons", { maxStandbyClaims: 1 });
  assert.equal((await call(store, { route: "create", body: { id: "s1", standby: true } })).status, 201);
  const refused = await call(store, { route: "create", body: { id: "s2", standby: true } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "standby_full");
  store.close();
});

test("closing a claim promotes the oldest standby claim to unclaimed (FIFO)", async () => {
  const { store } = fixture();
  store.workClaims.configure("commons", { maxOpenClaims: 2 });
  for (const id of ["a", "b"]) await call(store, { route: "create", body: { id } });
  await call(store, { route: "create", body: { id: "s1", standby: true } });
  await call(store, { route: "create", body: { id: "s2", standby: true } });
  const closed = await call(store, { route: "close", id: "a" });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.state, "cancelled");
  assert.equal(closed.body.promoted?.id, "s1");
  assert.equal(closed.body.promoted?.state, "unclaimed");
  assert.equal(store.workClaims.get("commons", "s1").state, "unclaimed");
  assert.equal(store.workClaims.get("commons", "s2").state, "standby");
  assert.equal(capCount(store), 2);
  store.close();
});

test("a done transition also promotes the oldest standby claim", async () => {
  const { store } = fixture();
  store.workClaims.configure("commons", { maxOpenClaims: 2 });
  for (const id of ["a", "b"]) await call(store, { route: "create", body: { id } });
  await call(store, { route: "create", body: { id: "s1", standby: true } });
  assert.equal((await call(store, { route: "claim", id: "a", member: "alice" })).status, 200);
  assert.equal((await call(store, { route: "update", id: "a", member: "alice", body: { state: "in_progress" } })).status, 200);
  const done = await call(store, { route: "update", id: "a", member: "alice", body: { state: "done" } });
  assert.equal(done.status, 200);
  assert.equal(done.body.promoted?.id, "s1");
  assert.equal(store.workClaims.get("commons", "s1").state, "unclaimed");
  store.close();
});

test("?state=standby filters the list to standby claims", async () => {
  const { store } = fixture();
  await call(store, { route: "create", body: { id: "a" } });
  await call(store, { route: "create", body: { id: "s1", standby: true } });
  const listed = await call(store, { route: "list", method: "GET", search: "?state=standby" });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.claims.map(item => item.id), ["s1"]);
  store.close();
});

test("standby claims in the list carry queuePosition in FIFO order", async () => {
  const { store } = fixture();
  await call(store, { route: "create", body: { id: "s1", standby: true } });
  await call(store, { route: "create", body: { id: "s2", standby: true } });
  const listed = await call(store, { route: "list", method: "GET" });
  assert.equal(listed.status, 200);
  const byId = new Map(listed.body.claims.filter(item => item.state === "standby").map(item => [item.id, item]));
  assert.equal(byId.size, 2);
  assert.equal(byId.get("s1").queuePosition, 1);
  assert.equal(byId.get("s2").queuePosition, 2);
  store.close();
});

test("claiming a standby item is refused with guidance", async () => {
  const { store } = fixture();
  await call(store, { route: "create", body: { id: "s1", standby: true } });
  const res = await call(store, { route: "claim", id: "s1", member: "alice" });
  assert.equal(res.status, 409);
  assert.match(res.message, /standby/i);
  store.close();
});

test("a standby claim can be closed directly", async () => {
  const { store } = fixture();
  store.workClaims.configure("commons", { maxOpenClaims: 1 });
  await call(store, { route: "create", body: { id: "a" } });
  await call(store, { route: "create", body: { id: "s1", standby: true } });
  const closed = await call(store, { route: "close", id: "s1", body: { reason: "withdrawn" } });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.state, "cancelled");
  assert.equal(capCount(store), 1);
  store.close();
});

test("the MCP mirror cap predicate also excludes cancelled and standby claims", async () => {
  const { store } = fixture();
  const { mirrorProjectionClaim } = await import("../server/work-claim-mirror.mjs");
  const { createWork } = await import("../server/work-claims.mjs");
  store.workClaims.configure("commons", { maxOpenClaims: 2 });
  // A board "full" of only cancelled + standby claims still has real slots.
  for (const id of ["x1", "x2"]) {
    const item = createWork({ id }, { now: Date.now(), agentId: "owner" });
    store.workClaims.set("commons", { ...item, state: "cancelled" });
  }
  const parked = createWork({ id: "xs" }, { now: Date.now(), agentId: "owner" });
  store.workClaims.set("commons", { ...parked, state: "standby" });
  const at = new Date().toISOString();
  const item = mirrorProjectionClaim(store, "commons", "owner",
    { type: "claim.acquired", at, data: { workItemId: "mirror-one" } });
  assert.ok(item);
  assert.equal(item.state, "claimed"); // claim.acquired creates AND claims
  // But a genuinely full board still 409s on the mirror path: mirror-one is
  // now held, so one more open claim reaches the cap of 2.
  store.workClaims.set("commons", createWork({ id: "y1" }, { now: Date.now(), agentId: "owner" }));
  assert.throws(() => mirrorProjectionClaim(store, "commons", "owner",
    { type: "claim.acquired", at, data: { workItemId: "mirror-two" } }),
    error => error?.status === 409 && error?.code === "work_board_full");
  store.close();
});
