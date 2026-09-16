// F016 — tests for src/account-deletion.mjs.
//
// Covers: the plan covers every inventory category, step ordering respects
// declared dependencies (topological, deterministic, profile last), legal
// hold categories are flagged retained (never purged) with reasons,
// validatePurgePlan catches incomplete / inconsistent plans, and empty /
// malformed inventories degrade instead of throwing. Deterministic: the
// plan clock is pinned via `now`.

import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_FORMAT_VERSION,
  ACTIONS,
  DEFAULT_LEGAL_HOLD_REASON,
  planDeletion,
  validatePurgePlan,
  summarizePurge,
} from "../src/account-deletion.mjs";

const PINNED_NOW = 1_757_999_999_000; // 2026-09-16T04:33:19.000Z
const PINNED_ISO = new Date(PINNED_NOW).toISOString();
const now = () => PINNED_NOW;

const account = () => ({ id: "u-ada", name: "Ada" });

const inventory = () => ({
  profile: { itemCount: 1 },
  credentials: { itemCount: 3 },
  sessions: { itemCount: 2 },
  messages: { itemCount: 40 },
  media: { itemCount: 12 },
  settings: { itemCount: 5 },
  billing: { itemCount: 18, legalHold: true, legalHoldReason: "Tax records retained 7 years." },
  audit_trail: { itemCount: 90, legalHold: true }, // default reason
  custom_notes: { itemCount: 7, dependsOn: ["messages"] },
});

test("plan covers every inventory category with one step each", () => {
  const plan = planDeletion(account(), inventory(), { now });
  assert.equal(plan.format_version, PLAN_FORMAT_VERSION);
  assert.equal(plan.accountId, "u-ada");
  assert.equal(plan.planned_at, PINNED_ISO);
  const cats = Object.keys(inventory()).sort();
  assert.deepEqual(plan.categories, cats);
  assert.deepEqual(plan.steps.map(s => s.category).sort(), cats);
  assert.deepEqual(plan.errors, []);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.steps));
});

test("ordering respects dependencies and known priorities (profile last)", () => {
  const plan = planDeletion(account(), inventory(), { now });
  const order = plan.steps.map(s => s.category);
  const before = (a, b) => assert.ok(order.indexOf(a) < order.indexOf(b), `${a} before ${b}`);
  before("credentials", "sessions"); // default dependency
  before("messages", "media"); // default dependency
  before("messages", "custom_notes"); // caller dependency
  assert.equal(order[order.length - 1], "profile");
});

test("ordering is deterministic for the same inventory", () => {
  const a = planDeletion(account(), inventory(), { now });
  const b = planDeletion(account(), inventory(), { now });
  assert.deepEqual(a.steps.map(s => s.category), b.steps.map(s => s.category));
});

test("legal-hold categories are retained, never purged, with reasons", () => {
  const plan = planDeletion(account(), inventory(), { now });
  const byCat = name => plan.steps.find(s => s.category === name);
  assert.equal(byCat("billing").action, ACTIONS.RETAIN);
  assert.equal(byCat("billing").reason, "Tax records retained 7 years.");
  assert.equal(byCat("audit_trail").action, ACTIONS.RETAIN);
  assert.equal(byCat("audit_trail").reason, DEFAULT_LEGAL_HOLD_REASON);
  assert.equal(byCat("messages").action, ACTIONS.PURGE);
  assert.match(byCat("messages").reason, /full purge/);
  assert.ok(plan.steps.every(s => s.action === ACTIONS.PURGE || s.action === ACTIONS.RETAIN));
});

test("validatePurgePlan accepts a complete, consistent plan", () => {
  const plan = planDeletion(account(), inventory(), { now });
  assert.deepEqual(validatePurgePlan(plan), { valid: true, errors: [] });
});

test("validatePurgePlan catches missing, duplicate, and misordered steps", () => {
  const plan = planDeletion(account(), inventory(), { now });
  const dropped = { ...plan, steps: plan.steps.filter(s => s.category !== "media") };
  const missing = validatePurgePlan(dropped);
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some(e => e.includes('"media"')), "flags the missing category");

  const doubled = { ...plan, steps: [...plan.steps, plan.steps[0]] };
  const dup = validatePurgePlan(doubled);
  assert.equal(dup.valid, false);
  assert.ok(dup.errors.some(e => e.includes("duplicate")), "flags the duplicate step");

  const swapped = { ...plan, steps: [...plan.steps].reverse() };
  const badOrder = validatePurgePlan(swapped);
  assert.equal(badOrder.valid, false);
  assert.ok(badOrder.errors.some(e => e.includes("before its dependency")), "flags the ordering violation");
});

test("validatePurgePlan requires reasons on retained steps and rejects bad input", () => {
  const plan = planDeletion(account(), inventory(), { now });
  const noReason = {
    ...plan,
    steps: plan.steps.map(s => (s.action === ACTIONS.RETAIN ? { ...s, reason: " " } : s)),
  };
  assert.equal(validatePurgePlan(noReason).valid, false);

  assert.deepEqual(validatePurgePlan(null), { valid: false, errors: ["plan must be a plain object"] });
  assert.equal(validatePurgePlan("nope").valid, false);
});

test("summarizePurge reports purge vs retained counts for confirmation", () => {
  const plan = planDeletion(account(), inventory(), { now });
  const summary = summarizePurge(plan);
  assert.equal(summary.accountId, "u-ada");
  assert.equal(summary.purgeCount, 7);
  assert.equal(summary.retainCount, 2);
  assert.equal(summary.purgedItems, 1 + 3 + 2 + 40 + 12 + 5 + 7);
  assert.equal(summary.retainedItems, 18 + 90);
  assert.ok(!summary.purgeOrder.includes("billing") && !summary.purgeOrder.includes("audit_trail"));
  assert.deepEqual(summary.retained.map(r => r.category).sort(), ["audit_trail", "billing"]);
  assert.ok(summary.text.includes("7 categor"));
  assert.ok(summary.text.includes("Retained under legal hold:"));
  assert.ok(summary.text.includes("Tax records retained 7 years."));
  assert.ok(Object.isFrozen(summary));
});

test("empty inventory plans to nothing and validates clean", () => {
  const plan = planDeletion(account(), {}, { now });
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.categories, []);
  assert.deepEqual(validatePurgePlan(plan), { valid: true, errors: [] });
  const summary = summarizePurge(plan);
  assert.equal(summary.purgeCount, 0);
  assert.equal(summary.retainCount, 0);
  assert.match(summary.text, /nothing to purge/);
});

test("malformed inputs degrade instead of throwing", () => {
  const plan = planDeletion(null, "nope", { now });
  assert.deepEqual(plan.steps, []);
  assert.ok(plan.errors.length > 0);
  assert.equal(validatePurgePlan(plan).valid, true); // empty plan covers empty categories

  const weird = planDeletion(account(), {
    profile: null,
    sessions: { itemCount: -5, dependsOn: "not-an-array" },
    media: { itemCount: 2.5, dependsOn: ["ghost-category", "media"] },
  }, { now });
  const byCat = name => weird.steps.find(s => s.category === name);
  assert.equal(byCat("profile").itemCount, 0);
  assert.equal(byCat("sessions").itemCount, 0);
  assert.deepEqual(byCat("sessions").dependsOn, ["credentials"]); // non-array falls back to known default
  assert.deepEqual(byCat("media").dependsOn, ["ghost-category"]); // self-dependency dropped
  assert.ok(weird.errors.some(e => e.includes("ghost-category")), "unknown dependency is flagged");
  assert.deepEqual(validatePurgePlan(weird), { valid: true, errors: [] });
});

test("dependency cycles terminate with a documented fallback", () => {
  const plan = planDeletion(account(), {
    alpha: { dependsOn: ["beta"] },
    beta: { dependsOn: ["alpha"] },
  }, { now });
  assert.equal(plan.steps.length, 2);
  assert.ok(plan.errors.some(e => e.includes("cycle")), "cycle is flagged");
});
