// PRODUCT-200 RELIABILITY — INVARIANT "RETRY NEVER DUPLICATES": CLAIM CREATE.
//
// John's never-break invariant #1: a retried request must never duplicate
// work. Scenario: create a work-item claim, then retry the identical create
// (same idempotency key + same payload). The API contract (store.command,
// server/store.mjs) is:
//   - the command `id` IS the idempotency key (commands table:
//     PRIMARY KEY(room_id, actor_id, id));
//   - identical retry -> the idempotent replay: { duplicate: true } with the
//     ORIGINAL sequence and event body; no new event, no second claim;
//   - same id + different payload -> 409 idempotency_conflict;
//   - exactly ONE claim.acquired event lands in the room event log.
//
// Fail-first: verified red with the dedupe guard removed (the `if (prior)`
// early return in store.command), green with it restored. See PR body.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { invariant } from "./dsl.mjs";
import { invariantSuite } from "./runner.mjs";
import { proposeWork, acceptWork, workItemRevision, workItemState } from "./fixtures.mjs";
import { EVENT_TYPES as T } from "../../src/events.js";

const ROOM = "commons";

const claimAcquiredEvents = (store, roomId, workItemId) =>
  store.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence").all(roomId)
    .map(row => JSON.parse(row.body))
    .filter(event => event.type === T.CLAIM_ACQUIRED && event.data?.workItemId === workItemId);

invariantSuite([
  invariant("retry-never-duplicates-claim-create", "retrying an identical claim create is an idempotent replay, not a second claim")
    .given((f, ctx) => {
      // DECLARE the world. Do not perform the operation under test here.
      ctx.workItemId = proposeWork(f);
      acceptWork(f, ctx.workItemId);
      // The fixed command id is the idempotency key shared by the create
      // and its retry — exactly as a network retry of the same logical
      // request would reuse it. The payload is byte-identical too, so the
      // fingerprint matches the prior command.
      ctx.idempotencyKey = `retry-inv-${randomUUID()}`;
      ctx.commandData = {
        workItemId: ctx.workItemId,
        expectedRevision: workItemRevision(f, f.keys.owner, ctx.workItemId),
        repository: "test/invariants",
        ref: "synthetic",
        paths: ["src/app.js"],
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      return ctx;
    })
    .when(async (f, ctx) => {
      // ACT: the exact operation the invariant covers — create, then retry
      // the identical create.
      const create = () => f.store.command(f.keys.owner, ROOM, {
        id: ctx.idempotencyKey,
        type: T.CLAIM_ACQUIRED,
        data: ctx.commandData,
      });
      ctx.first = create(); // the original claim create
      ctx.retry = create(); // the retry: identical id + identical payload
    })
    .then((f, ctx) => {
      // ASSERT: pin the invariant. No new state changes here.
      // 1. The retry is the idempotent replay of the original command:
      //    flagged duplicate, same sequence, same event body.
      assert.equal(ctx.first.duplicate, false, "original create must not be a duplicate");
      assert.equal(ctx.retry.duplicate, true, "retry must be flagged duplicate: true");
      assert.equal(ctx.retry.sequence, ctx.first.sequence, "replay must return the original sequence");
      assert.deepEqual(ctx.retry.event, ctx.first.event, "replay must return the original event");
      // 2. Exactly one claim exists: a single claim.acquired event hit the log.
      const acquired = claimAcquiredEvents(f.store, ROOM, ctx.workItemId);
      assert.equal(acquired.length, 1, `expected exactly one claim.acquired event, found ${acquired.length}`);
      // 3. The visible state holds that one active claim.
      assert.equal(workItemState(f, f.keys.owner, ctx.workItemId).claim?.status, "active");
    })
    .build(),
]);
