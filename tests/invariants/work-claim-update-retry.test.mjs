// PRODUCT-200 reliability A4: INVARIANT "RETRY NEVER DUPLICATES" —
// UPDATE RETRY / HISTORY APPEND (QA-200 AQ-HI-06).
//
// QA-200 found that retrying the identical claim update appends a duplicate
// history entry: the update path takes no requestId and calls withHistory()
// unconditionally. These scenarios pin the fix: an update that carries a
// requestId is applied exactly once — a retry with the same requestId
// replays the stored outcome (200, the current item) without appending
// another history entry. requestId is opt-in; updates without one keep the
// legacy append behavior. The replay record rides on the work item itself,
// so it survives the durable SQLite registry round-trip (restart/deploy).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWork, claimWork, updateWork } from "../../server/work-claims.mjs";
import { createWorkClaimRegistry, handleWorkClaims } from "../../server/work-claim-routes.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../../server/work-claim-sqlite.mjs";
import { invariant } from "./dsl.mjs";
import { invariantSuite } from "./runner.mjs";

const MEMBERS = {
  owner: { id: "owner", kind: "human", active: true,
    permissions: ["manage_claims", "accept_work", "complete_work", "verify", "steer"] },
  worker: { id: "worker", kind: "agent", active: true,
    permissions: ["accept_work", "complete_work"] },
};

const helpers = {
  json: (_res, status, value) => ({ status, value }),
  reject: (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; },
  body: async req => req.body,
};

const call = (registry, memberId, route, id, body, query = "") => handleWorkClaims({
  req: { method: route === "list" || route === "read" ? "GET" : "POST", body },
  res: {},
  url: new URL(`https://room.example/api/rooms/room1/work-claims${query}`),
  store: { roomAuthority: () => ({ ownerId: "owner", members: MEMBERS }), room: () => ({ state: { messages: [] } }) },
  roomId: "room1",
  auth: { member: { id: memberId, kind: MEMBERS[memberId].kind, permissions: MEMBERS[memberId].permissions } },
  workClaimRoute: route,
  workClaimId: id,
  helpers,
  registry,
});

const seedClaim = async registry => {
  await call(registry, "owner", "create", null, { id: "task" });
  await call(registry, "worker", "claim", "task", {});
  return registry.get("room1", "task").history.length;
};

invariantSuite([
  invariant("update-retry-same-requestid-appends-nothing",
    "retrying an identical update with the same requestId appends no history entry")
    .given(async (f, ctx) => {
      ctx.registry = createWorkClaimRegistry();
      ctx.before = await seedClaim(ctx.registry);
      return ctx;
    })
    .when(async (f, ctx) => {
      ctx.first = await call(ctx.registry, "worker", "update", "task", { note: "progress", requestId: "req-1" });
      ctx.retry = await call(ctx.registry, "worker", "update", "task", { note: "progress", requestId: "req-1" });
    })
    .then((f, ctx) => {
      assert.equal(ctx.error, undefined, "the retry must not throw");
      assert.equal(ctx.first.status, 200);
      const stored = ctx.registry.get("room1", "task");
      assert.equal(stored.history.length, ctx.before + 1, "first update appends exactly one entry");
      assert.equal(ctx.retry.status, 200, "the retry replays the stored outcome");
      assert.equal(stored.history.length, ctx.before + 1, "the retry must not append a duplicate entry");
      assert.deepEqual(ctx.retry.value.history, stored.history);
      assert.equal(stored.history[stored.history.length - 1].note, "progress");
    })
    .build(),

  invariant("update-retry-no-requestid-legacy-append",
    "updates without a requestId keep the legacy append behavior")
    .given(async (f, ctx) => {
      ctx.registry = createWorkClaimRegistry();
      ctx.before = await seedClaim(ctx.registry);
      return ctx;
    })
    .when(async (f, ctx) => {
      await call(ctx.registry, "worker", "update", "task", { note: "progress" });
      await call(ctx.registry, "worker", "update", "task", { note: "progress" });
    })
    .then((f, ctx) => {
      assert.equal(ctx.error, undefined);
      assert.equal(ctx.registry.get("room1", "task").history.length, ctx.before + 2,
        "no requestId means each call is a distinct write (unchanged legacy behavior)");
    })
    .build(),

  invariant("update-retry-different-requestid-is-new-write",
    "a different requestId is a distinct write")
    .given(async (f, ctx) => {
      ctx.registry = createWorkClaimRegistry();
      ctx.before = await seedClaim(ctx.registry);
      return ctx;
    })
    .when(async (f, ctx) => {
      await call(ctx.registry, "worker", "update", "task", { note: "a", requestId: "req-1" });
      ctx.second = await call(ctx.registry, "worker", "update", "task", { note: "b", requestId: "req-2" });
    })
    .then((f, ctx) => {
      assert.equal(ctx.error, undefined);
      const stored = ctx.registry.get("room1", "task");
      assert.equal(ctx.second.status, 200);
      assert.equal(stored.history.length, ctx.before + 2);
      assert.equal(stored.history[stored.history.length - 1].note, "b");
    })
    .build(),

  invariant("update-retry-short-circuits-stale-basis",
    "the identical retry replays 200 even when its precondition basis is now stale")
    .given(async (f, ctx) => {
      ctx.registry = createWorkClaimRegistry();
      await seedClaim(ctx.registry);
      const item = ctx.registry.get("room1", "task");
      ctx.basis = { expectedClaimedAt: item.claimedAt, expectedHistoryLength: item.history.length };
      return ctx;
    })
    .when(async (f, ctx) => {
      ctx.first = await call(ctx.registry, "worker", "update", "task",
        { note: "v1", requestId: "req-9", ...ctx.basis });
      // The identical retry carries the now-stale v0 basis. The requestId
      // replay must win: the client already got its 200 for this request.
      ctx.retry = await call(ctx.registry, "worker", "update", "task",
        { note: "v1", requestId: "req-9", ...ctx.basis });
    })
    .then((f, ctx) => {
      assert.equal(ctx.error, undefined);
      assert.equal(ctx.first.status, 200);
      assert.equal(ctx.retry.status, 200);
      assert.notEqual(ctx.retry.value?.error?.code, "work_claim_conflict");
      const v1 = ctx.registry.get("room1", "task").history.filter(entry => entry.note === "v1");
      assert.equal(v1.length, 1, "exactly one v1 entry despite the retried write");
    })
    .build(),

  invariant("update-retry-malformed-requestid-422",
    "a malformed requestId is refused with 422, never silently dropped")
    .given(async (f, ctx) => {
      ctx.registry = createWorkClaimRegistry();
      ctx.before = await seedClaim(ctx.registry);
      return ctx;
    })
    .when(async (f, ctx) => {
      await call(ctx.registry, "worker", "update", "task", { note: "x", requestId: "not a valid id!!" });
    })
    .then((f, ctx) => {
      assert.equal(ctx.error?.status, 422);
      assert.equal(ctx.registry.get("room1", "task").history.length, ctx.before,
        "a refused write appends nothing");
    })
    .build(),

  invariant("update-retry-pure-replay",
    "the pure machine replays a seen requestId without a new write")
    .given((f, ctx) => {
      ctx.item = claimWork(createWork({ id: "task", title: "task" }, { now: 1000 }), "worker", { now: 1001 });
      return ctx;
    })
    .when((f, ctx) => {
      ctx.first = updateWork(ctx.item, "worker", { note: "progress", requestId: "req-1", now: 2000 });
      ctx.retry = updateWork(ctx.first, "worker", { note: "progress", requestId: "req-1", now: 3000 });
    })
    .then((f, ctx) => {
      assert.equal(ctx.error, undefined);
      assert.equal(ctx.first.history.length, ctx.item.history.length + 1, "first update appends one entry");
      assert.deepEqual(ctx.retry.history, ctx.first.history, "the identical retry appends no history entry");
      assert.equal(ctx.retry.state, ctx.first.state, "the update still applied exactly once");
      assert.deepEqual(ctx.retry.requestOutcomes, ctx.first.requestOutcomes,
        "the replay record is preserved on the stored outcome");
    })
    .build(),

  invariant("update-retry-survives-durable-roundtrip",
    "the requestId replay record survives a durable registry rebuild (restart/deploy)")
    .given(async (f, ctx) => {
      ctx.dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "a4-updateretry-"));
      ctx.db = new DatabaseSync(join(ctx.dir, "claims.db"));
      ctx.db.exec(workClaimSchema);
      ctx.registry = createDurableWorkClaimRegistry(ctx.db, {});
      await seedClaim(ctx.registry);
      ctx.before = ctx.registry.get("room1", "task").history.length;
      return ctx;
    })
    .when(async (f, ctx) => {
      ctx.first = await call(ctx.registry, "worker", "update", "task", { note: "progress", requestId: "req-1" });
      // Rebuild the registry on the same database, as after a restart.
      const rebuilt = createDurableWorkClaimRegistry(ctx.db, {});
      ctx.retry = await call(rebuilt, "worker", "update", "task", { note: "progress", requestId: "req-1" });
      ctx.rebuilt = rebuilt;
    })
    .then((f, ctx) => {
      try {
        assert.equal(ctx.error, undefined);
        assert.equal(ctx.first.status, 200);
        assert.equal(ctx.retry.status, 200);
        const stored = ctx.rebuilt.get("room1", "task");
        assert.equal(stored.history.length, ctx.before + 1,
          "the retry against the rebuilt registry must not append a duplicate entry");
      } finally {
        ctx.db.close();
        rmSync(ctx.dir, { recursive: true, force: true });
      }
    })
    .build(),
]);
