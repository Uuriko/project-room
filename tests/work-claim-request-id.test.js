// requestId idempotency for work-claim write routes (PHOENIX squad W4 gap #1).
//
// Measured 2026-10-07: work-claim routes have no requestId (sending one is a
// 422) and identical claim updates double-apply 100% (4/4 trials: two
// identical `noted` history entries). The room-commands path already dedupes
// in-transaction on (room_id, actor_id, command.id) with 409
// idempotency_conflict on same-id/different-content; these tests pin the
// same contract on the work-claim write routes (update, create, claim,
// release, reassign, renew).
//
// Authoring-gate answers:
// 1. Observable contract: identical write + same requestId applies once
//    (second returns 200 duplicate:true, no new history entry); same
//    requestId + different content -> 409 idempotency_conflict; absent
//    requestId -> legacy behavior (double-apply), backward compatible.
// 2. Credible regression: dropping the dedupe lookup (or the record write)
//    reintroduces the W4 double-apply; a broken fingerprint comparison
//    either false-409s or lets double-applies through.
// 3. Existing coverage: none — requestId on work-claims is currently a 422,
//    and no test asserts single-apply on retry.
// 4. No production seam: the real handleWorkClaims + a real RoomStore
//    (:memory: and temp-file for the durability case) with the durable
//    store.workClaims registry — the same boundary production serves.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims } from "../server/work-claim-routes.mjs";

const fakeHelpers = () => ({
  body: async req => req.body,
  json: (res, status, value) => ({ status, value }),
  reject: (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  },
});

const openStore = (t, file = ":memory:") => {
  const store = new RoomStore(file);
  t.after(() => store.close());
  store.initialize(initialRoom("commons"));
  return store;
};

// Drives the real HTTP work-claim handler in-process against the real
// durable registry, mirroring the production call shape in server/http.mjs.
const runRoute = async ({ store, route, id, body = {}, memberId = "owner" }) => {
  const helpers = fakeHelpers();
  try {
    const out = await handleWorkClaims({
      req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
      res: {}, url: new URL("http://localhost"), store, roomId: "commons",
      auth: { member: { id: memberId, kind: "human" } },
      workClaimRoute: route, workClaimId: id, helpers, registry: store.workClaims,
    });
    return { out, error: null };
  } catch (error) {
    return { out: null, error };
  }
};

const setupClaim = async (t, store, id = "w1") => {
  const created = await runRoute({ store, route: "create", body: { id, title: "t" } });
  assert.equal(created.error, null, `create failed: ${created.error?.message}`);
  const claimed = await runRoute({ store, route: "claim", id, body: { leaseHours: 1 } });
  assert.equal(claimed.error, null, `claim failed: ${claimed.error?.message}`);
  return store.workClaims.get("commons", id);
};

const notedEntries = item => item.history.filter(entry => entry.action === "noted");

// ---------------------------------------------------------------------------
// A: identical updates with the same requestId apply exactly once
// ---------------------------------------------------------------------------
test("A: the same update sent twice with one requestId applies once (W4 repro)", async t => {
  const store = openStore(t);
  await setupClaim(t, store);
  const body = { note: "progress checkpoint", requestId: "req-a1" };
  const first = await runRoute({ store, route: "update", id: "w1", body });
  assert.equal(first.error, null, `first update failed: ${first.error?.message}`);
  assert.equal(first.out.status, 200);
  const second = await runRoute({ store, route: "update", id: "w1", body });
  assert.equal(second.error, null, `retry failed: ${second.error?.message}`);
  assert.equal(second.out.status, 200);
  assert.equal(second.out.value.duplicate, true, "retry must be flagged as a duplicate replay");
  const item = store.workClaims.get("commons", "w1");
  assert.equal(notedEntries(item).length, 1,
    `double-apply: expected 1 noted entry, got ${notedEntries(item).length}`);
});

// ---------------------------------------------------------------------------
// B: same requestId + different content fails loud, not silent double-apply
// ---------------------------------------------------------------------------
test("B: same requestId with different content is a 409 idempotency_conflict", async t => {
  const store = openStore(t);
  await setupClaim(t, store);
  const first = await runRoute({ store, route: "update", id: "w1",
    body: { note: "original note", requestId: "req-b1" } });
  assert.equal(first.error, null, `first update failed: ${first.error?.message}`);
  const second = await runRoute({ store, route: "update", id: "w1",
    body: { note: "different note, same requestId", requestId: "req-b1" } });
  assert.ok(second.error, "expected a 409, got success");
  assert.equal(second.error.status, 409);
  assert.equal(second.error.code, "idempotency_conflict");
  const item = store.workClaims.get("commons", "w1");
  assert.equal(notedEntries(item).length, 1, "the conflicting write must not have applied");
});

// ---------------------------------------------------------------------------
// C: no requestId -> legacy behavior, unchanged (backward compatible)
// ---------------------------------------------------------------------------
test("C: updates without requestId keep the legacy double-apply behavior", async t => {
  const store = openStore(t);
  await setupClaim(t, store);
  const body = { note: "no idempotency key" };
  const first = await runRoute({ store, route: "update", id: "w1", body });
  assert.equal(first.error, null);
  const second = await runRoute({ store, route: "update", id: "w1", body });
  assert.equal(second.error, null);
  assert.equal(second.out.status, 200);
  assert.equal(second.out.value.duplicate, undefined, "legacy path must not claim duplicate");
  const item = store.workClaims.get("commons", "w1");
  assert.equal(notedEntries(item).length, 2,
    "legacy path must still apply each write (callers opt into safety)");
});

// ---------------------------------------------------------------------------
// D: the dedupe record is durable — survives a store reopen
// ---------------------------------------------------------------------------
test("D: a retry after reopening the database still dedupes", async t => {
  const dir = mkdtempSync(join(tmpdir(), "room-requestid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "room.sqlite");
  {
    const store = new RoomStore(file);
    store.initialize(initialRoom("commons"));
    await setupClaim(t, store);
    const first = await runRoute({ store, route: "update", id: "w1",
      body: { note: "before restart", requestId: "req-d1" } });
    assert.equal(first.error, null, `first update failed: ${first.error?.message}`);
    store.close();
  }
  const reopened = new RoomStore(file);
  t.after(() => reopened.close());
  const retry = await runRoute({ store: reopened, route: "update", id: "w1",
    body: { note: "before restart", requestId: "req-d1" } });
  assert.equal(retry.error, null, `retry after reopen failed: ${retry.error?.message}`);
  assert.equal(retry.out.status, 200);
  assert.equal(retry.out.value.duplicate, true);
  const item = reopened.workClaims.get("commons", "w1");
  assert.equal(notedEntries(item).length, 1, "reopened store double-applied the retry");
});

// ---------------------------------------------------------------------------
// E: malformed requestId values are rejected, not treated as absent
// ---------------------------------------------------------------------------
test("E: a non-string or oversized requestId is a 422", async t => {
  const store = openStore(t);
  await setupClaim(t, store);
  for (const bad of [42, "", "x".repeat(129), "has space"]) {
    const { error } = await runRoute({ store, route: "update", id: "w1",
      body: { note: "n", requestId: bad } });
    assert.ok(error, `expected a 422 for ${JSON.stringify(bad)}`);
    assert.equal(error.status, 422, `expected 422 for ${JSON.stringify(bad)}, got ${error.status}`);
  }
});
