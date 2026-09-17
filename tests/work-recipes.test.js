import test from "node:test";
import assert from "node:assert/strict";
import { RECIPE_CATALOG, REVIEW_REQUEST_AFTER_MS, activeRecipes } from "../src/work-recipes.js";

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

function completedUnverified(over = {}) {
  return { id: "w1", title: "Write the report", state: "completed", mode: "read",
    accountableMemberId: "guest", verifierMemberId: "owner",
    independentVerificationRequired: true, ownerDecisionRequired: false,
    receipt: { eventId: "e1", evidenceVersion: "v1", producerAttribution: "reported", producerId: "guest" }, verification: null,
    updatedAt: new Date(NOW - REVIEW_REQUEST_AFTER_MS - 60000).toISOString(), ...over };
}

test("catalog names exactly the three starter recipes, each with an explicit trigger and bounded outcome", () => {
  assert.deepEqual(RECIPE_CATALOG.map(r => r.id), ["draft-catch-up", "suggest-next-work", "request-review"]);
  for (const recipe of RECIPE_CATALOG) {
    assert.equal(typeof recipe.trigger, "string"); assert.ok(recipe.trigger.length > 10);
    assert.equal(typeof recipe.outcome, "string"); assert.ok(recipe.outcome.length > 10);
  }
});

test("catch-up triggers only on unseen committed activity and bounds to a draft the member opens", () => {
  const state = fixture();
  let out = activeRecipes(state, "guest", { now: NOW, cursor: 42, sequence: 42 });
  assert.equal(out.find(r => r.id === "draft-catch-up"), undefined);
  out = activeRecipes(state, "guest", { now: NOW, cursor: 40, sequence: 42 });
  const recipe = out.find(r => r.id === "draft-catch-up");
  assert.ok(recipe);
  assert.deepEqual(recipe.trigger, { cursor: 40, sequence: 42, unseen: 2 });
  assert.equal(recipe.outcome.kind, "catch_up_draft");
});

test("suggest-next-work triggers on committed steps and bounds to exactly one suggestion", () => {
  const state = fixture();
  state.workItems.assigned = { id: "assigned", title: "A small contribution", state: "proposed", mode: "read",
    accountableMemberId: "guest", receipt: null, updatedAt: "2026-09-13T11:00:00Z" };
  const out = activeRecipes(state, "guest", { now: NOW, cursor: 42, sequence: 42 });
  const recipe = out.find(r => r.id === "suggest-next-work");
  assert.ok(recipe);
  assert.equal(recipe.outcome.kind, "work_suggestion");
  assert.equal(recipe.outcome.workItemId, "assigned");
  // one suggestion only, even when several steps exist
  state.replyRequests.q = { id: "q", recipientId: "guest", status: "open", createdAt: "2026-09-13T11:30:00Z" };
  state.messages.push({ id: "q", body: "Which option?" });
  const again = activeRecipes(state, "guest", { now: NOW, cursor: 42, sequence: 42 }).find(r => r.id === "suggest-next-work");
  assert.equal(again.outcome.kind, "work_suggestion");
  assert.ok(!Array.isArray(again.outcome.steps));
});

test("request-review triggers only for your own stale unverified result and bounds to a draft to the named verifier", () => {
  const state = fixture();
  state.workItems.w1 = completedUnverified();
  let out = activeRecipes(state, "guest", { now: NOW, cursor: 42, sequence: 42 });
  const recipe = out.find(r => r.id === "request-review");
  assert.ok(recipe);
  assert.equal(recipe.outcome.kind, "review_request_draft");
  assert.equal(recipe.outcome.workItemId, "w1");
  assert.equal(recipe.outcome.toMemberId, "owner");
  // fresh result: not yet stale
  state.workItems.w1 = completedUnverified({ updatedAt: new Date(NOW - 60000).toISOString() });
  assert.equal(activeRecipes(state, "guest", { now: NOW, cursor: 42, sequence: 42 }).find(r => r.id === "request-review"), undefined);
  // verified, not yours, or inactive verifier: no trigger
  state.workItems.w1 = completedUnverified({ verification: { result: "pass", completionEventId: "e1", evidenceVersion: "v1", verifierId: "owner", independenceConfirmed: true } });
  assert.equal(activeRecipes(state, "guest", { now: NOW, cursor: 42, sequence: 42 }).find(r => r.id === "request-review"), undefined);
  state.workItems.w1 = completedUnverified({ accountableMemberId: "owner" });
  assert.equal(activeRecipes(state, "guest", { now: NOW, cursor: 42, sequence: 42 }).find(r => r.id === "request-review"), undefined);
  state.workItems.w1 = completedUnverified(); state.members.owner.active = false;
  assert.equal(activeRecipes(state, "guest", { now: NOW, cursor: 42, sequence: 42 }).find(r => r.id === "request-review"), undefined);
});

test("unknown or inactive members get no recipes; state is never mutated", () => {
  const state = fixture();
  state.workItems.w1 = completedUnverified();
  const before = structuredClone(state);
  assert.deepEqual(activeRecipes(state, "unknown", { now: NOW, cursor: 0, sequence: 42 }), []);
  assert.deepEqual(state, before);
  state.members.guest.active = false;
  assert.deepEqual(activeRecipes(state, "guest", { now: NOW, cursor: 0, sequence: 42 }), []);
});
