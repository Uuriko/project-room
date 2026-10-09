// WAVE-500 W8: per-namespace event budget allocator prototype.
// Fail-first: every test below must fail before server/event-budget.mjs exists
// and pass after. Pure functions only — no DB, no store coupling.
import test from "node:test";
import assert from "node:assert/strict";
import { createBudget, tryConsume, usage } from "../server/event-budget.mjs";

test("weighted allocation splits the non-reserve pool by weight", () => {
  const state = createBudget({
    total: 1000,
    namespaces: { a: 1, b: 2, c: 1 },
    reserveRatio: 0.1,
  });
  assert.equal(state.reserve, 100);
  assert.equal(state.ns.a.allocated, 225);
  assert.equal(state.ns.b.allocated, 450);
  assert.equal(state.ns.c.allocated, 225);
  assert.equal(state.ns.a.allocated + state.ns.b.allocated + state.ns.c.allocated + state.unallocatedPool, 900);
});

test("exhaustion returns the honest 409-shape with retryAfterSec and does not mutate", () => {
  let state = createBudget({ total: 100, namespaces: { a: 1 }, reserveRatio: 0.1, borrowRatio: 0 });
  let r = tryConsume(state, "a", 90);
  assert.equal(r.ok, true);
  state = r.state;
  r = tryConsume(state, "a", 1);
  assert.equal(r.ok, false);
  assert.equal(r.code, "namespace_event_budget_exhausted");
  assert.ok(typeof r.retryAfterSec === "number" && r.retryAfterSec > 0);
  assert.ok(typeof r.message === "string" && r.message.length > 0);
  // refusal must not consume anything
  assert.equal(usage(r.state).a.used, 90);
});

test("borrowing is capped at K% of the unallocated pool and never touches the reserve", () => {
  const state0 = createBudget({
    total: 1000,
    namespaces: { a: 1, b: 1 },
    reserveRatio: 0.1, // 100 reserve, 900 allocatable -> 450 each, unallocated 0
    borrowRatio: 0.5,
  });
  // leave some unallocated: reserve 101, weights give 454/454, 1 left over
  const s = createBudget({ total: 1010, namespaces: { a: 1, b: 1 }, reserveRatio: 0.1, borrowRatio: 1 });
  assert.equal(s.reserve, 101);
  assert.equal(s.unallocatedPool, 1); // 909 allocatable -> 454+454, 1 left
  // burn a's whole allocation
  let st = tryConsume(s, "a", 454).state;
  // borrow the single unallocated unit
  const r = tryConsume(st, "a", 1);
  assert.equal(r.ok, true);
  assert.equal(r.state.unallocatedPool, 0);
  assert.equal(r.state.reserve, 101);
  // nothing left to borrow anywhere: further consume is refused, reserve intact
  const r2 = tryConsume(r.state, "a", 1);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "namespace_event_budget_exhausted");
  assert.equal(r2.state.reserve, 101);
  assert.equal(r2.state.unallocatedPool, 0);
  assert.equal(r2.state.ns.b.allocated, 454);
});

test("one namespace's burst cannot reduce another namespace's availability (no starvation)", () => {
  let state = createBudget({ total: 1000, namespaces: { a: 9, b: 1 }, reserveRatio: 0.1, borrowRatio: 0 });
  // a burns everything it can
  state = tryConsume(state, "a", 810).state;
  const refused = tryConsume(state, "a", 1);
  assert.equal(refused.ok, false);
  // b still gets its full 90-unit allocation, untouched by a's burst
  const r = tryConsume(state, "b", 90);
  assert.equal(r.ok, true);
  assert.equal(usage(r.state).b.used, 90);
  assert.equal(r.state.ns.a.allocated, 810);
});

test("usage() reports per-namespace used, allocated and pct", () => {
  let state = createBudget({ total: 1000, namespaces: { a: 3, b: 1 }, reserveRatio: 0.1 });
  state = tryConsume(state, "a", 675).state; // a allocated 675
  const u = usage(state);
  assert.equal(u.a.used, 675);
  assert.equal(u.a.allocated, 675);
  assert.equal(u.a.pct, 1);
  assert.equal(u.b.used, 0);
  assert.equal(u.b.allocated, 225);
  assert.equal(u.b.pct, 0);
  // borrowed consumption shows pct above 1 honestly
  // (weights leave a 2-unit unallocated pool; borrowRatio 1 lets a take it)
  const s2 = createBudget({ total: 1000, namespaces: { a: 1, b: 1, c: 1 }, reserveRatio: 0.2, borrowRatio: 1 });
  const st2 = tryConsume(s2, "a", 266).state;
  const r2 = tryConsume(st2, "a", 2);
  assert.equal(r2.ok, true);
  assert.equal(r2.state.unallocatedPool, 0);
  assert.ok(usage(r2.state).a.pct > 1);
});

test("unknown namespace is refused honestly, never silently consumed", () => {
  const state = createBudget({ total: 100, namespaces: { a: 1 } });
  const r = tryConsume(state, "nope", 1);
  assert.equal(r.ok, false);
  assert.equal(r.code, "namespace_event_budget_unknown");
  assert.ok(typeof r.retryAfterSec === "number" && r.retryAfterSec > 0);
});
