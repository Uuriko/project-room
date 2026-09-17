// W4-47 H6: dry-run preview. Done-when: the preview itself has no external
// effects - it is a pure read over committed state.
import test from "node:test";
import assert from "node:assert/strict";
import { RECIPE_CATALOG, RECIPE_READS, REVIEW_REQUEST_AFTER_MS, previewRecipe, previewAllRecipes } from "../src/work-recipes.js";

function fixture() {
  return {
    room: { id: "commons", ownerId: "owner" },
    sequence: 42,
    members: {
      owner: { id: "owner", kind: "human", active: true, permissions: ["verify"] },
      guest: { id: "guest", kind: "human", active: true, permissions: ["verify", "accept_work"] }
    },
    messages: [],
    replyRequests: {},
    workItems: {}
  };
}
const NOW = Date.parse("2026-09-13T12:00:00Z");

function firingState() {
  const state = fixture();
  state.workItems.assigned = { id: "assigned", title: "A small contribution", state: "proposed", mode: "read",
    accountableMemberId: "guest", receipt: null, updatedAt: "2026-09-13T11:00:00Z" };
  state.workItems.w1 = { id: "w1", title: "Write the report", state: "completed", mode: "read",
    accountableMemberId: "guest", verifierMemberId: "owner",
    independentVerificationRequired: true, ownerDecisionRequired: false,
    receipt: { eventId: "e1", evidenceVersion: "v1", producerAttribution: "reported", producerId: "guest" }, verification: null,
    updatedAt: new Date(NOW - REVIEW_REQUEST_AFTER_MS - 60000).toISOString() };
  return state; // catch-up fires too when previewed with a cursor behind sequence
}

test("preview covers every catalog recipe even when nothing fires", () => {
  const state = fixture();
  const previews = previewAllRecipes(state, "guest", { now: NOW, cursor: 42, sequence: 42 });
  assert.deepEqual(previews.map(p => p.id), RECIPE_CATALOG.map(r => r.id));
  for (const p of previews) {
    assert.equal(p.firesNow, false);
    assert.equal(p.preview, null);
    assert.ok(p.reads.length > 0, `${p.id} names what it reads`);
    assert.equal(p.trigger, RECIPE_CATALOG.find(r => r.id === p.id).trigger);
    assert.equal(p.outcome, RECIPE_CATALOG.find(r => r.id === p.id).outcome);
    assert.equal(p.reads, RECIPE_READS[p.id]);
  }
});

test("preview shows the concrete outcome a firing recipe would produce, without producing it", () => {
  const state = firingState();
  const catchUp = previewRecipe(state, "guest", "draft-catch-up", { now: NOW, cursor: 40, sequence: 42 });
  assert.equal(catchUp.firesNow, true);
  assert.deepEqual(catchUp.preview, { kind: "catch_up_draft" });
  const next = previewRecipe(state, "guest", "suggest-next-work", { now: NOW, cursor: 42, sequence: 42 });
  assert.equal(next.firesNow, true);
  assert.equal(next.preview.kind, "work_suggestion");
  assert.equal(next.preview.workItemId, "assigned");
  const review = previewRecipe(state, "guest", "request-review", { now: NOW, cursor: 42, sequence: 42 });
  assert.equal(review.firesNow, true);
  assert.equal(review.preview.kind, "review_request_draft");
  assert.equal(review.preview.workItemId, "w1");
  assert.equal(review.preview.toMemberId, "owner");
});

test("unknown recipe throws; unknown or inactive member still gets the description but never a firing preview", () => {
  const state = firingState();
  assert.throws(() => previewRecipe(state, "guest", "nope", { now: NOW }), /Unknown recipe/);
  const stranger = previewRecipe(state, "stranger", "suggest-next-work", { now: NOW, cursor: 0, sequence: 42 });
  assert.equal(stranger.firesNow, false);
  assert.equal(stranger.preview, null);
  assert.ok(stranger.reads.length > 0);
  state.members.guest.active = false;
  assert.equal(previewRecipe(state, "guest", "suggest-next-work", { now: NOW, cursor: 0, sequence: 42 }).firesNow, false);
});

test("done-when: preview has no external effects - state is byte-identical afterwards and results are frozen", () => {
  const state = firingState();
  const before = structuredClone(state);
  const first = previewAllRecipes(state, "guest", { now: NOW, cursor: 40, sequence: 42 });
  const second = previewAllRecipes(state, "guest", { now: NOW, cursor: 40, sequence: 42 });
  assert.deepEqual(state, before); // no mutation, no cursor advance, no marker written
  assert.deepEqual(first, second); // deterministic: same state, same preview
  assert.notEqual(first, second); // fresh objects each call
  for (const p of first) {
    assert.ok(Object.isFrozen(p));
    assert.ok(Object.isFrozen(p.reads));
    if (p.preview) assert.ok(Object.isFrozen(p.preview));
  }
});
