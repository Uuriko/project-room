// Invariant: FAILED ACTIONS PRESERVE DATA — claim update.
//
// A claim update that fails validation must leave the claim (and the whole
// work item) byte-identical to its pre-update state: every field, the history
// length, and the event journal. This pins the invariant at two levels:
//
//   1. store level: a refused T.CLAIM_RENEWED command must not journal an
//      event and must not alter the projection. The reducer runs against a
//      structuredClone draft inside a DB transaction, so a throw discards
//      everything — these scenarios pin that property, including for a
//      LATE validation (after earlier checks passed).
//   2. pure-function level: server/work-claims.mjs updateWork() validates
//      every field BEFORE building the next object and never mutates its
//      input — a failed update must leave the input object deep-identical.
//
// Scenario ids are stable; the runner boots a fresh disposable DB per case.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { invariant } from "./dsl.mjs";
import { invariantSuite } from "./runner.mjs";
import { createWork, claimWork, updateWork } from "../../server/work-claims.mjs";
import { proposeWork, acceptWork, acquireClaim, renewClaim, workItemState } from "./fixtures.mjs";

const ROOM = "commons";

function snapshotClaimState(f, actor, workItemId) {
  return {
    json: JSON.stringify(workItemState(f, actor, workItemId)),
    sequence: f.store.room(ROOM).sequence,
  };
}

function assertUnchanged(f, ctx, why) {
  assert.equal(ctx.error?.status, 422, `${why}: the update must be refused with 422`);
  assert.equal(ctx.error?.code, "command_rejected", `${why}: the refusal code must be command_rejected`);
  const after = snapshotClaimState(f, f.keys.owner, ctx.workItemId);
  assert.equal(after.json, ctx.before.json, `${why}: claim state must be byte-identical after a failed update`);
  assert.equal(after.sequence, ctx.before.sequence, `${why}: a failed update must not journal an event`);
}

invariantSuite([
  // --- 1. store level: failed claim update leaves state byte-identical ---
  invariant("failed-update-preserves-claim", "a refused claim update leaves the claim byte-identical and journals nothing")
    .given((f, ctx) => {
      ctx.workItemId = proposeWork(f);
      acceptWork(f, ctx.workItemId);
      acquireClaim(f, ctx.workItemId);
      ctx.before = snapshotClaimState(f, f.keys.owner, ctx.workItemId);
      assert.ok(ctx.before.json.includes('"status":"active"'), "given: the claim must start active");
      return ctx;
    })
    .when((f, ctx) => {
      // Validation failure: the new expiry is not in the future.
      renewClaim(f, ctx.workItemId, {
        overrides: { expiresAt: new Date(Date.now() - 1000).toISOString() },
      });
    })
    .then((f, ctx) => {
      assertUnchanged(f, ctx, "failed-update-preserves-claim");
    })
    .build(),

  invariant("failed-update-late-validation", "a claim update failing on a late validation leaves no partial write")
    .given((f, ctx) => {
      ctx.workItemId = proposeWork(f);
      acceptWork(f, ctx.workItemId);
      acquireClaim(f, ctx.workItemId);
      ctx.before = snapshotClaimState(f, f.keys.owner, ctx.workItemId);
      return ctx;
    })
    .when((f, ctx) => {
      // The expiry checks pass; the failure lands in the LATE
      // requireProgressCheckin validation — after holder, claim, and expiry
      // checks all succeeded. Nothing may be written.
      renewClaim(f, ctx.workItemId, { overrides: { progressMessageId: "no-such-message" } });
    })
    .then((f, ctx) => {
      assertUnchanged(f, ctx, "failed-update-late-validation");
    })
    .build(),

  // --- 2. pure-function level: updateWork() never mutates its input ---
  invariant("failed-updatework-no-mutation", "a failed updateWork() leaves its input object deep-identical")
    .given((f, ctx) => {
      const now = new Date("2026-10-08T20:00:00.000Z").toISOString();
      const created = createWork(
        { id: `inv-pure-${randomUUID().slice(0, 8)}`, title: "Pure update target", note: "known state" },
        { now, agentId: "owner" },
      );
      ctx.item = claimWork(created, "owner", { note: "holding", leaseHours: 24, now });
      ctx.beforeJson = JSON.stringify(ctx.item);
      ctx.beforeHistoryLength = ctx.item.history.length;
      assert.equal(ctx.item.state, "claimed", "given: the item must start claimed");
      return ctx;
    })
    .when((f, ctx) => {
      // Late validation: the note check passes, then parentClaimIdOf rejects
      // inside withProvenance — the last validation before the next object
      // is built. The input must be untouched.
      updateWork(ctx.item, "owner", {
        note: "a fine note",
        parentClaimId: "!!!not-a-claim-id!!!",
        now: new Date().toISOString(),
      });
    })
    .then((f, ctx) => {
      assert.ok(ctx.error, "the update must throw");
      assert.match(ctx.error.message, /parentClaimId must be a claim id/);
      assert.equal(JSON.stringify(ctx.item), ctx.beforeJson, "failed updateWork must not mutate its input");
      assert.equal(ctx.item.history.length, ctx.beforeHistoryLength, "history length must be unchanged");
    })
    .build(),
]);
