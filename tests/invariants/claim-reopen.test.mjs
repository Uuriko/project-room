// Invariant: reopening shows committed state.
//
// claim -> update with data -> close -> reopen the view -> the reopened view
// shows the COMMITTED state (the update AND the close), never stale
// pre-update data and never a partial record.
//
// Two reopen timings, both pinned:
//   1. immediate reopen: a fresh snapshot on the same store, right after the
//      writes, before any cache TTL could expire. The in-memory projection
//      cache must not serve the pre-update / pre-close projection.
//   2. reopen after process restart: the store is closed and reopened on the
//      same database file. The view must come from the store, not memory —
//      committed means durable.
//
// Fail-first note: this scenario goes red if the projection cache ever
// serves a stale sequence (e.g. ProjectionCache.lookup ignoring the
// sequence), and green once the read path re-validates against the store.

import assert from "node:assert/strict";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { invariant } from "./dsl.mjs";
import { invariantSuite } from "./runner.mjs";
import {
  proposeWork,
  acceptWork,
  acquireClaim,
  releaseClaim,
  workItemRevision,
  workItemState,
} from "./fixtures.mjs";
import { EVENT_TYPES as T } from "../../src/events.js";
import { RoomStore } from "../../server/store.mjs";

const ROOM = "commons";
const PATHS = ["src/app.js", "src/board.js"];

// The claim "update with data": renew the lease with a new expiry.
// Commits new claim data without closing the claim.
function renewClaim(f, workItemId, { actor, expiresAt }) {
  return f.store.command(actor, ROOM, {
    id: randomUUID(),
    type: T.CLAIM_RENEWED,
    data: {
      workItemId,
      expectedRevision: workItemRevision(f, actor, workItemId),
      expiresAt,
    },
  });
}

function claimOf(f, actor, workItemId) {
  return workItemState(f, actor, workItemId)?.claim ?? null;
}

invariantSuite([
  invariant("claim-reopen-committed-state", "reopening the view after close shows the committed update, never stale or partial data")
    .given((f, ctx) => {
      ctx.workItemId = proposeWork(f);
      acceptWork(f, ctx.workItemId);
      ctx.expiresAt1 = new Date(Date.now() + 3600_000).toISOString();
      acquireClaim(f, ctx.workItemId, {
        actor: f.keys.owner,
        extra: { expiresAt: ctx.expiresAt1, paths: PATHS },
      });
      const claim = claimOf(f, f.keys.owner, ctx.workItemId);
      assert.equal(claim?.status, "active");
      ctx.holderId = claim.holderId;
      return ctx;
    })
    .when(async (f, ctx) => {
      // Update with data: the renewal commits a new expiry on the claim.
      ctx.expiresAt2 = new Date(Date.now() + 7200_000).toISOString();
      renewClaim(f, ctx.workItemId, { actor: f.keys.owner, expiresAt: ctx.expiresAt2 });
      // Close the claim.
      releaseClaim(f, ctx.workItemId, { actor: f.keys.owner });
      // Reopen the board view session immediately: a fresh snapshot on the
      // same store, before any cache TTL could expire.
      ctx.immediate = claimOf(f, f.keys.owner, ctx.workItemId);
      // Reopen after a process restart: close the store and boot a new one
      // on the same database file. State must come from the store, not memory.
      f.store.close();
      f.store = new RoomStore(join(f.directory, "room.sqlite"));
      ctx.restarted = claimOf(f, f.keys.owner, ctx.workItemId);
      return ctx;
    })
    .then((f, ctx) => {
      assert.ok(!ctx.error, `unexpected refusal during update/close: ${ctx.error?.message}`);
      for (const [label, claim] of [["immediate", ctx.immediate], ["restarted", ctx.restarted]]) {
        assert.ok(claim, `${label} view: the claim record must survive close (no partial/missing record)`);
        assert.equal(claim.status, "released", `${label} view: must show the committed close, not the stale "active" state`);
        assert.equal(claim.expiresAt, ctx.expiresAt2,
          `${label} view: must show the committed update (expiresAt), not the stale pre-update value`);
        assert.equal(claim.holderId, ctx.holderId, `${label} view: claim holder must be intact (no partial record)`);
        assert.deepEqual(claim.paths, PATHS, `${label} view: claim paths must be intact (no partial record)`);
        assert.ok(claim.releasedAt, `${label} view: the close must carry its release stamp`);
      }
    })
    .build(),
]);
