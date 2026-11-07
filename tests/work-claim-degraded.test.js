// Fo panel fix (muse-room seq 19947): during Durable Object degradation,
// work-claim routes answered 8 attempts over 25 minutes with a 500-class
// refusal instead of a retryable 503, and the caller's claims then lapsed
// via lease_expired while it retried blind. The escrow door already maps
// SQLite BUSY to a clean 503 (PR #4908, server/bounty-escrow-routes.mjs),
// but that map lives in runPure at the escrow door only: the work-claims
// door had no map, and BUSY (SQLite primary code 5) is deliberately NOT in
// store.mjs's storageFailureSqlite set {8,10,13,14} — contention is not
// storage failure — so a BUSY/degraded error escaping the claim registry's
// transaction reached server/http.mjs with no status and became a 500.
//
// This file pins the claims-door map: a storage busy/degraded error at the
// registry seam is a 503 service_degraded (Retry-After, nothing applied,
// exact request safe to retry), never a 500 and never a 422
// invalid_claim_input. Genuine claim errors keep their own shapes, and a
// typed storage_unavailable refusal keeps its established 503 code.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore, StorageUnavailableError } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { handleWorkClaims, isWorkClaimStorageDegraded } from "../server/work-claim-routes.mjs";
import { ClaimError } from "../server/work-claims.mjs";

const auth = (id, kind, permissions) => ({ member: { id, kind, permissions } });
const OWNER = auth("owner", "human", ["manage_claims"]);
const WORKER = auth("worker", "agent", ["accept_work", "complete_work"]);

const busyError = () => Object.assign(new Error("database is locked"),
  { code: "ERR_SQLITE_ERROR", errcode: 5 });

async function room(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons",
    { id: "add-worker", type: "member.added", data: { memberId: "worker", displayName: "worker", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  const helpers = {
    json: (_res, status, value) => ({ status, value }),
    reject: (status, code, message, headers) => {
      const error = new Error(message); error.status = status; error.code = code; error.headers = headers ?? null; throw error;
    },
    body: async req => req.body,
  };
  const call = (route, id, body, extra = {}) => handleWorkClaims({
    req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
    res: {}, url: new URL("https://room.example/api/rooms/commons/work-claims"),
    store, roomId: "commons", auth: extra.auth ?? OWNER,
    workClaimRoute: route, workClaimId: id, helpers,
    registry: extra.registry ?? store.workClaims,
  });
  return { store, call };
}

// A registry that delegates reads to the real durable registry but whose
// transaction seam fails the way a degraded store does — the exact seam
// handleWorkClaims wraps (registry.transaction(run)).
const degradedRegistry = (real, makeError) => Object.assign(Object.create(real), {
  transaction: () => { throw makeError(); },
});

test("classifier: BUSY shapes are degraded; claim and other sqlite errors are not", () => {
  assert.equal(isWorkClaimStorageDegraded(busyError()), true);
  assert.equal(isWorkClaimStorageDegraded(Object.assign(new Error("snapshot busy"), { errcode: 517 })), true,
    "extended BUSY codes share the low byte");
  assert.equal(isWorkClaimStorageDegraded({ code: "SQLITE_BUSY", message: "x" }), true);
  assert.equal(isWorkClaimStorageDegraded({ code: "ERR_SQLITE_BUSY", message: "x" }), true);
  assert.equal(isWorkClaimStorageDegraded(
    Object.assign(new Error("UNIQUE constraint failed"), { code: "ERR_SQLITE_ERROR", errcode: 19 })), false);
  assert.equal(isWorkClaimStorageDegraded(
    Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10 })), false,
    "storage failures keep their own storage_unavailable path");
  assert.equal(isWorkClaimStorageDegraded(new ClaimError("invalid_claim_input", "bad input")), false,
    "a genuine claim-input refusal is never remapped to degradation");
  assert.equal(isWorkClaimStorageDegraded(new Error("boom")), false);
  assert.equal(isWorkClaimStorageDegraded(null), false);
});

test("degraded seam: a claim under a busy store is 503 service_degraded, writes nothing, retries clean", async t => {
  const r = await room(t);
  await r.call("create", null, { id: "deg-1", title: "Degraded claim" });
  const degraded = degradedRegistry(r.store.workClaims, busyError);
  await assert.rejects(
    r.call("claim", "deg-1", { leaseHours: 6 }, { auth: WORKER, registry: degraded }),
    error => error.status === 503 && error.code === "service_degraded" && error.headers?.["Retry-After"] === "1",
    "expected the mapped 503 service_degraded, not a raw throw (500 at the HTTP door)");
  // Nothing was applied: the claim is still unclaimed and claimable.
  assert.equal(r.store.workClaims.get("commons", "deg-1").state, "unclaimed");
  assert.equal(r.store.workClaims.get("commons", "deg-1").owner, null);
  const retry = await r.call("claim", "deg-1", { leaseHours: 6 }, { auth: WORKER });
  assert.equal(retry.status, 200);
  assert.equal(retry.value.state, "claimed");
  assert.equal(retry.value.owner, "worker");
});

test("degraded seam: a SQLITE_BUSY-coded failure on a read is also 503 service_degraded", async t => {
  const r = await room(t);
  const degraded = degradedRegistry(r.store.workClaims,
    () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }));
  await assert.rejects(
    r.call("list", null, undefined, { registry: degraded }),
    error => error.status === 503 && error.code === "service_degraded");
});

test("degraded seam: a bare ClaimError escaping the core is 422, never a 500", async t => {
  const r = await room(t);
  await r.call("create", null, { id: "deg-3", title: "ClaimError escape" });
  // ClaimError carries a code but no HTTP status; the module's contract maps
  // it to 422 (runPure), but paths outside runPure (the lease sweep, live
  // close, pull settlement inside the core) used to let one escape to
  // server/http.mjs, which renders a status-less error as a 500 — the
  // 500 invalid_claim_input shape Fo reported (seq 19947).
  const escaping = degradedRegistry(r.store.workClaims,
    () => new ClaimError("invalid_claim_input", "stored claim row failed validation"));
  await assert.rejects(
    r.call("claim", "deg-3", { leaseHours: 6 }, { auth: WORKER, registry: escaping }),
    error => error.status === 422 && error.code === "invalid_claim_input");
  assert.equal(r.store.workClaims.get("commons", "deg-3").state, "unclaimed");
});

test("degraded seam: a genuine invalid_claim_input refusal is NOT remapped", async t => {
  const r = await room(t);
  // Missing the required id field is a caller error on a healthy store.
  await assert.rejects(
    r.call("create", null, { title: "no id" }),
    error => error.status === 422 && error.code === "invalid_claim_input");
});

test("degraded seam: a typed storage_unavailable refusal passes through unchanged", async t => {
  const r = await room(t);
  await r.call("create", null, { id: "deg-2", title: "Unavailable claim" });
  const unavailable = degradedRegistry(r.store.workClaims, () => new StorageUnavailableError(new Error("disk full")));
  await assert.rejects(
    r.call("claim", "deg-2", { leaseHours: 6 }, { auth: WORKER, registry: unavailable }),
    error => error.status === 503 && error.code === "storage_unavailable" && error.headers?.["Retry-After"] === "30",
    "the established storage_unavailable shape (Retry-After 30) must not be relabelled");
  assert.equal(r.store.workClaims.get("commons", "deg-2").state, "unclaimed");
});
