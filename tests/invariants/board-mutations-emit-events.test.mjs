// INVARIANT: every board mutation emits its board event.
//
// The land-queue board (land_queue table) wrote rows with no event at all: a
// land-queue add committed a row plus its mirrored work claim and appended
// zero land.updated events, a land-queue remove deleted the row with no
// land-level receipt, and a duplicate add that renamed the claimant updated
// the row silently. The room's event tail, digests and wake feeds could never
// see the board change, and event-replay could not reconstruct the board.
// This suite pins the invariant at the store level: add, remove, claimant
// handoff, tip reports and poll refreshes each append the land.updated
// receipt naming the item, in the same transaction as the row write (the
// room sequence advances exactly with the receipts, so a torn commit is
// impossible).
//
// The work-claim board's pairing is anchored separately in
// tests/work-claim-events.test.js: created, claimed, state_changed,
// reviewed, renewed, reassigned and released each append exactly one
// work_claim.updated event, and a refused change appends nothing.

import assert from "node:assert/strict";
import { invariant } from "./dsl.mjs";
import { invariantSuite } from "./runner.mjs";
import { mintIdentity, linkToRoom } from "./fixtures.mjs";
import { EVENT_TYPES as T } from "../../src/events.js";

const ROOM = "commons";
const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);

// GitHub answers from the fixture: no token leaves the scenario, no network.
function mockGitHub({ checks = "success", sha = SHA, notFound = false } = {}) {
  return async url => {
    if (notFound && !url.includes("/check-runs") && !url.endsWith("/status")) {
      return { status: 404, ok: false, json: async () => ({ message: "Not Found" }) };
    }
    let body;
    if (url.includes("/check-runs")) {
      body = { check_runs: [{ status: "completed", conclusion: checks, name: "unit" }] };
    } else if (url.endsWith("/status")) {
      body = { state: checks };
    } else {
      body = { title: "Land the queue", merged: false, mergeable: true, mergeable_state: "clean", head: { sha } };
    }
    return { status: 200, ok: true, json: async () => body };
  };
}

function landEvents(f) {
  return f.store.db.prepare(
    "SELECT body FROM events WHERE room_id=? AND json_extract(body,'$.type')=? ORDER BY sequence"
  ).all(ROOM, T.LAND_UPDATED).map(row => JSON.parse(row.body));
}

function roomSequence(f) {
  return f.store.room(ROOM).sequence;
}

function configureBoard(f, mockOpts) {
  f.store.landQueue.configure({ token: "<test-token>", fetchImpl: mockGitHub(mockOpts) });
}

async function addItem(f) {
  const added = await f.store.landQueue.add(ROOM, "owner", { repo: "acme/demo", prNumber: 969 });
  assert.equal(added.duplicate, false);
  return added.item;
}

invariantSuite([
  // The anchor: a board write with no event is the QA-200 P0. The add
  // receipt lands in the same transaction as the row (sequence +1 exactly).
  invariant("board-mutation-add", "land-queue add appends a land.updated added receipt")
    .given((f, ctx) => {
      configureBoard(f);
      ctx.before = roomSequence(f);
      return ctx;
    })
    .when(async (f, ctx) => {
      ctx.item = await addItem(f);
      return ctx;
    })
    .then((f, ctx) => {
      const events = landEvents(f);
      assert.equal(events.length, 1, "exactly one board event for the add");
      const [receipt] = events;
      assert.deepEqual(receipt.data.changed, ["added"]);
      assert.equal(receipt.data.itemId, ctx.item.itemId);
      assert.equal(receipt.data.repo, "acme/demo");
      assert.equal(receipt.data.pr, 969);
      assert.equal(receipt.data.claimantMemberId, "owner");
      assert.equal(receipt.actorId, "owner");
      assert.equal(receipt.roomId, ROOM);
      assert.equal(roomSequence(f), ctx.before + 1, "row write and receipt commit together");
    })
    .build(),

  // A duplicate add that names a new claimant reassigns the board row: the
  // handoff commits its land.updated reassigned receipt naming the item and
  // the new claimant.
  invariant("board-mutation-reassign", "land-queue claimant handoff appends a land.updated reassigned receipt")
    .given(async (f, ctx) => {
      configureBoard(f);
      ctx.item = await addItem(f);
      const agent = mintIdentity(f, "handoff-probe");
      const { link } = linkToRoom(f, agent, ["accept_work"]);
      ctx.other = link.memberId;
      ctx.before = roomSequence(f);
      return ctx;
    })
    .when(async (f, ctx) => {
      const again = await f.store.landQueue.add(ROOM, "owner", {
        repo: "acme/demo", prNumber: 969, claimantMemberId: ctx.other
      });
      assert.equal(again.duplicate, true);
      assert.equal(again.item.claimantMemberId, ctx.other);
      return ctx;
    })
    .then((f, ctx) => {
      const events = landEvents(f);
      const [receipt] = events.slice(-1);
      assert.deepEqual(receipt.data.changed, ["reassigned"]);
      assert.equal(receipt.data.itemId, ctx.item.itemId);
      assert.equal(receipt.data.claimantMemberId, ctx.other);
      assert.equal(roomSequence(f), ctx.before + 1, "row update and receipt commit together");
    })
    .build(),

  // A removal is a board mutation too: the delete commits its land.updated
  // receipt (changed ["removed"]) in the same transaction as the row, so
  // a removal never lands silently in the event log.
  invariant("board-mutation-remove", "land-queue remove appends a land.updated removed receipt")
    .given(async (f, ctx) => {
      configureBoard(f);
      ctx.item = await addItem(f);
      ctx.before = roomSequence(f);
      return ctx;
    })
    .when((f, ctx) => {
      const result = f.store.landQueue.remove(ROOM, "owner", { itemId: ctx.item.itemId });
      assert.equal(result.removed, true);
      return ctx;
    })
    .then((f, ctx) => {
      const events = landEvents(f);
      const [receipt] = events.slice(-1);
      assert.deepEqual(receipt.data.changed, ["removed"]);
      assert.equal(receipt.data.itemId, ctx.item.itemId);
      assert.equal(receipt.data.repo, "acme/demo");
      assert.equal(receipt.data.pr, 969);
      // The delete commits two receipts together: the land.updated removed
      // receipt plus the mirrored work claim's deletion receipt.
      assert.equal(roomSequence(f), ctx.before + 2, "row delete and receipts commit together");
    })
    .build(),

  // A vanished PR auto-deletes the board row on refresh: same removed
  // receipt, so the silent GitHub-side deletion stays observable.
  invariant("board-mutation-pr-vanished", "land-queue auto-delete on vanished PR appends a removed receipt")
    .given(async (f, ctx) => {
      configureBoard(f);
      ctx.item = await addItem(f);
      return ctx;
    })
    .when(async (f, ctx) => {
      configureBoard(f, { notFound: true });
      // The refresh throws pr_not_found after committing the delete; the
      // refusal is the signal, the receipts are the assertion.
      await f.store.landQueue.refreshDue({ now: Date.now() + 3_600_000 });
      return ctx;
    })
    .then((f, ctx) => {
      const events = landEvents(f);
      assert.deepEqual(events.map(e => e.data.changed), [["added"], ["removed"]]);
      const [, removed] = events;
      assert.equal(removed.data.itemId, ctx.item.itemId);
      assert.equal(f.store.landQueue.list(ROOM, "owner").items.length, 0, "the row is gone");
    })
    .build(),

  // A tip report is a board update: it appends the land.updated tip receipt.
  invariant("board-mutation-tip", "land-queue tip report appends a land.updated tip receipt")
    .given(async (f, ctx) => {
      configureBoard(f);
      ctx.item = await addItem(f);
      ctx.before = roomSequence(f);
      return ctx;
    })
    .when((f, ctx) => {
      const { changed } = f.store.landQueue.reportTip(ROOM, "owner", {
        itemId: ctx.item.itemId, sourceRevision: "abc123def", buildId: "build-42"
      });
      assert.deepEqual(changed, ["tip"]);
      return ctx;
    })
    .then((f, ctx) => {
      const events = landEvents(f);
      const [receipt] = events.slice(-1);
      assert.deepEqual(receipt.data.changed, ["tip"]);
      assert.equal(receipt.data.itemId, ctx.item.itemId);
      assert.equal(roomSequence(f), ctx.before + 1);
    })
    .build(),

  // A poll refresh that flips check state is a board state change: the
  // refresh commits the land.updated receipt naming what flipped.
  invariant("board-mutation-refresh", "land-queue refresh on flipped checks appends a land.updated receipt")
    .given(async (f, ctx) => {
      configureBoard(f, { checks: "success" });
      ctx.item = await addItem(f);
      ctx.before = roomSequence(f);
      return ctx;
    })
    .when(async (f, ctx) => {
      configureBoard(f, { checks: "failure", sha: SHA2 });
      const { updated } = await f.store.landQueue.refreshDue({ now: Date.now() + 3_600_000 });
      assert.equal(updated, 1);
      return ctx;
    })
    .then((f, ctx) => {
      const events = landEvents(f);
      const [receipt] = events.slice(-1);
      assert.ok(receipt.data.changed.includes("red"), "the check flip is named");
      assert.equal(receipt.data.itemId, ctx.item.itemId);
      assert.equal(receipt.data.head, SHA2, "the receipt carries the new head");
      assert.equal(roomSequence(f), ctx.before + 1);
    })
    .build(),
]);
