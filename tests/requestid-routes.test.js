// Request-id idempotency on the work-claim create/update HTTP routes
// (crash-recovery guild system #1). A retried mutation that already landed
// must replay its stored result instead of applying twice.
//
// Authoring gate:
// 1. Observable contract: POSTing create or update with a previously-seen
//    requestId returns the stored result with duplicate:true; the board
//    gains no extra claim and the history gains no extra entry. Without a
//    requestId, with a non-string requestId, or with no dedupe store wired,
//    behavior is exactly as before.
// 2. Credible regression: dropping the route-level check/record calls makes
//    a retried create 409 (or double-create) and a retried update
//    double-append history — the lost-response replay failure this guild
//    exists to fix.
// 3. Existing coverage does not catch it: no route-level test sends
//    requestId; the updateWork unit tests from the prior commit covered the
//    superseded history-stamping design, which this change removes.
// 4. No test-only production seam: readRequestId and store.requestDedupe are
//    the guild's production wiring. This drives the real handleWorkClaims
//    entry against a real in-memory RoomStore.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";
import { createDedupeStore, readRequestId } from "../server/request-dedupe.mjs";

const reject = (status, code, message) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
};

const fixture = (t, { dedupe = true } = {}) => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom("commons"));
  if (dedupe) store.requestDedupe = createDedupeStore(store.db);
  return store;
};

// Drive the real HTTP entry point (outer handleWorkClaims) with a fixed
// payload; resolves to { status, value } like the JSON response body.
const post = (store, workClaimRoute, workClaimId, payload) =>
  handleWorkClaims({
    req: { method: "POST" }, res: {},
    url: new URL("http://localhost"), store, roomId: "commons",
    auth: { member: { id: "owner", kind: "human" } },
    workClaimRoute, workClaimId, registry: store.workClaims,
    helpers: {
      body: async () => payload,
      json: (_res, status, value) => ({ status, value }),
      reject,
    },
  });

test("create with the same requestId twice creates one claim and replays it", async t => {
  const store = fixture(t);
  const first = await post(store, "create", undefined, { id: "idem-c1", requestId: "req-create-1" });
  assert.equal(first.status, 201);
  assert.equal(first.value.id, "idem-c1");
  assert.equal(first.value.duplicate, undefined);

  const second = await post(store, "create", undefined, { id: "idem-c1", requestId: "req-create-1" });
  assert.equal(second.status, 200);
  assert.equal(second.value.duplicate, true);
  assert.equal(second.value.id, "idem-c1"); // same claim, not a duplicate
  assert.deepEqual(
    { ...second.value, duplicate: undefined },
    { ...first.value, duplicate: undefined });

  const matches = store.workClaims.list("commons").filter(claim => claim.id === "idem-c1");
  assert.equal(matches.length, 1); // exactly one claim on the board
});

test("update with the same requestId twice appends one history entry and replays it", async t => {
  const store = fixture(t);
  await post(store, "create", undefined, { id: "idem-u1" });
  await post(store, "claim", "idem-u1", {});
  const claimed = store.workClaims.get("commons", "idem-u1");
  const historyBefore = claimed.history.length;

  const first = await post(store, "update", "idem-u1", { note: "first", requestId: "req-update-1" });
  assert.equal(first.status, 200);
  assert.equal(first.value.duplicate, undefined);
  assert.equal(first.value.history.length, historyBefore + 1);

  const second = await post(store, "update", "idem-u1", { note: "first", requestId: "req-update-1" });
  assert.equal(second.status, 200);
  assert.equal(second.value.duplicate, true);
  assert.equal(second.value.id, "idem-u1");
  assert.equal(second.value.history.length, historyBefore + 1); // no duplicate entry

  const stored = store.workClaims.get("commons", "idem-u1");
  assert.equal(stored.history.length, historyBefore + 1);
});

test("without a requestId, create and update behave as before", async t => {
  const store = fixture(t);
  const created = await post(store, "create", undefined, { id: "plain-1" });
  assert.equal(created.status, 201);
  // A retried create with no requestId still 409s on the existing claim.
  await assert.rejects(
    post(store, "create", undefined, { id: "plain-1" }),
    error => error.status === 409 && error.code === "work_claim_exists");

  await post(store, "claim", "plain-1", {});
  const first = await post(store, "update", "plain-1", { note: "one" });
  const second = await post(store, "update", "plain-1", { note: "two" });
  assert.equal(second.value.duplicate, undefined);
  assert.equal(second.value.history.length, first.value.history.length + 1); // both applied
});

test("a non-string requestId is treated as absent, without crashing", async t => {
  const store = fixture(t);
  const created = await post(store, "create", undefined, { id: "bad-rid-1", requestId: 42 });
  assert.equal(created.status, 201);
  assert.equal(created.value.duplicate, undefined);
  // It is not recorded either: the same numeric key applies again (409 here
  // proves the first create was not recorded as a duplicate).
  await assert.rejects(
    post(store, "create", undefined, { id: "bad-rid-1", requestId: 42 }),
    error => error.status === 409 && error.code === "work_claim_exists");
});

test("with no dedupe store installed, requestId is ignored (backward compatible)", async t => {
  const store = fixture(t, { dedupe: false });
  const first = await post(store, "create", undefined, { id: "noguard-1", requestId: "req-x" });
  assert.equal(first.status, 201);
  assert.equal(first.value.duplicate, undefined);
  // No store means no replay: the retry hits the normal 409 path.
  await assert.rejects(
    post(store, "create", undefined, { id: "noguard-1", requestId: "req-x" }),
    error => error.status === 409 && error.code === "work_claim_exists");
});

test("readRequestId only accepts a 1..128-char string and never throws", () => {
  assert.equal(readRequestId({ requestId: "abc" }), "abc");
  assert.equal(readRequestId({}), null);
  assert.equal(readRequestId(null), null);
  assert.equal(readRequestId(undefined), null);
  assert.equal(readRequestId({ requestId: 42 }), null);
  assert.equal(readRequestId({ requestId: "" }), null);
  assert.equal(readRequestId({ requestId: "x".repeat(129) }), null);
  assert.equal(readRequestId("requestId"), null);
});
