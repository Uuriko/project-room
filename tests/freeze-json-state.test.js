// PERF-BUILDS P0-4 — freezeJsonState is incremental.
// The walk used to re-verify and re-freeze the ENTIRE room state for
// every command candidate (~10% of every post). A WeakSet of subtrees
// that completed the full walk now lets shared, unchanged subtrees be
// skipped. The contract that must never weaken: a subtree is skipped
// ONLY if it was fully verified and frozen by a previous walk — new or
// changed state is always walked in full.
import test from "node:test";
import assert from "node:assert/strict";
import { freezeJsonState } from "../server/store.mjs";

function largeState() {
  const messages = [];
  for (let i = 0; i < 2000; i++) messages.push({ id: `m${i}`, authorId: "owner", body: `message ${i}`, createdAt: "2026-10-02T00:00:00.000Z" });
  return {
    room: { id: "commons", ownerId: "owner", title: "Commons" },
    members: { owner: { id: "owner", kind: "human", active: true } },
    messages,
    workItems: {}
  };
}

test("a full walk verifies and deep-freezes (pre-change behavior preserved)", () => {
  const state = largeState();
  assert.equal(freezeJsonState(state), true);
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.messages));
  assert.ok(Object.isFrozen(state.messages[1234]));
  assert.ok(Object.isFrozen(state.room));
});

test("exotic values are still refused, wherever they hide", () => {
  assert.equal(freezeJsonState({ a: undefined }), false);
  assert.equal(freezeJsonState({ a: -0 }), false);
  assert.equal(freezeJsonState({ a: () => {} }), false);
  assert.equal(freezeJsonState({ a: Number.NaN }), false);
  assert.equal(freezeJsonState([1, , 3]), false, "sparse arrays are refused");
  assert.equal(freezeJsonState({ when: new Date(0) }), false, "non-plain prototypes are refused");
  const accessor = {};
  Object.defineProperty(accessor, "x", { get: () => 1, enumerable: true });
  assert.equal(freezeJsonState(accessor), false, "accessors are refused");
});

test("a small change on a verified state verifies — and the new subtree is fully walked and frozen", () => {
  const state = largeState();
  assert.equal(freezeJsonState(state), true);
  const newMessage = { id: "new", authorId: "owner", body: "new", createdAt: "2026-10-02T00:00:01.000Z", meta: { flags: ["fresh"] } };
  const changed = { ...state, messages: [...state.messages, newMessage] };
  assert.equal(freezeJsonState(changed), true);
  assert.ok(Object.isFrozen(changed));
  assert.ok(Object.isFrozen(changed.messages));
  assert.ok(Object.isFrozen(newMessage), "the newly added subtree must be frozen by the walk");
  assert.ok(Object.isFrozen(newMessage.meta), "nested new subtrees must be frozen too");
  assert.ok(Object.isFrozen(newMessage.meta.flags));
});

test("an exotic value inside a NEW subtree is refused even when every sibling is already verified", () => {
  const state = largeState();
  assert.equal(freezeJsonState(state), true);
  // New message carrying an exotic leaf: the WeakSet must not let the
  // walk skip it just because the rest of the state is verified.
  const badNew = { ...state, messages: [...state.messages, { id: "bad", body: "x", score: -0 }] };
  assert.equal(freezeJsonState(badNew), false);
  const badNested = { ...state, extra: { deep: [{ nope: undefined }] } };
  assert.equal(freezeJsonState(badNested), false);
  // A new container reusing verified children but adding an accessor:
  const withAccessor = { ...state };
  Object.defineProperty(withAccessor, "sneaky", { get: () => 1, enumerable: true });
  assert.equal(freezeJsonState(withAccessor), false);
});

test("a partially verified graph is not trusted: failure in one branch does not certify the rest", () => {
  const shared = { id: "shared", body: "ok" };
  const attempt = { good: shared, bad: { value: Number.POSITIVE_INFINITY } };
  assert.equal(freezeJsonState(attempt), false);
  // `shared` completed its own walk before the failure, so it is frozen —
  // that is sound, because it WAS fully verified. Reusing it alone is fine.
  assert.ok(Object.isFrozen(shared));
  assert.equal(freezeJsonState({ wrapped: shared }), true);
  // The failed parent was never frozen or certified:
  assert.equal(Object.isFrozen(attempt), false);
  assert.equal(freezeJsonState(attempt), false, "re-walking the failed parent still refuses");
});

test("the small-change walk is proportional to the change, not the state", () => {
  // Relative assertion (machine-independent): the median small-change
  // walk over an already-verified 2,000-message state must cost a small
  // fraction of the median fresh full walk over the same-size state.
  const median = samples => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  const fullSamples = [];
  for (let i = 0; i < 3; i++) {
    const fresh = largeState();
    const started = performance.now();
    assert.equal(freezeJsonState(fresh), true);
    fullSamples.push(performance.now() - started);
  }
  const state = largeState();
  assert.equal(freezeJsonState(state), true);
  const smallSamples = [];
  for (let i = 0; i < 7; i++) {
    // Fresh wrapper containers each time, so only subtree reuse can help.
    const changed = { ...state, messages: [...state.messages, { id: `n${i}`, authorId: "o", body: "b", createdAt: "2026-10-02T00:00:02.000Z" }] };
    const started = performance.now();
    assert.equal(freezeJsonState(changed), true);
    smallSamples.push(performance.now() - started);
  }
  const full = median(fullSamples), small = median(smallSamples);
  assert.ok(small < full * 0.25,
    `small-change walk ${small.toFixed(2)} ms must be < 25% of the full walk ${full.toFixed(2)} ms`);
});
