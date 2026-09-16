// F016 — account deletion with full purge (pairs with F015 data export).
//
// Pure planner: turns an account + a caller-supplied data inventory into an
// ordered purge plan that a later wiring slice can execute. This module
// never deletes anything itself: it computes WHAT to purge in WHAT order,
// and flags what must be retained under legal hold instead of purged.
// It touches no store, no network, and no timers.
//
// The inventory is a plain map of category -> descriptor supplied by the
// caller (wired to whatever store or database the room uses):
//   { itemCount, dependsOn, legalHold, legalHoldReason }
//
//   - itemCount:      number of records in the category (for the summary).
//   - dependsOn:      array of category names that must be purged BEFORE
//                     this category (e.g. media after messages that
//                     reference it). Defaults come from KNOWN_CATEGORIES
//                     when the caller does not specify them.
//   - legalHold:      truthy marks the category retained, not purged
//                     (e.g. billing records, audit trail entries kept for
//                     tax or fraud-prevention obligations).
//   - legalHoldReason: human-readable reason shown at confirmation time.
//                     Defaults to DEFAULT_LEGAL_HOLD_REASON.
//
// Suggested wiring (follow-up slice): DELETE /api/account ->
// planDeletion(account, inventoryFromStore(userId)) -> confirm with the
// user using summarizePurge(plan) -> execute steps in order, then
// validatePurgePlan(plan) as a post-run completeness check.

export const PLAN_FORMAT_VERSION = "1.0.0";
export const DEFAULT_LEGAL_HOLD_REASON =
  "Retained to meet legal or regulatory obligations (tax, fraud prevention, dispute resolution).";

export const ACTIONS = Object.freeze({ PURGE: "purge", RETAIN: "retain" });

// Known data categories with default purge priorities. Lower priority
// purges first; the account profile goes last so nothing dangles while its
// children still exist. Unknown caller-defined categories get priority 50
// and sort alphabetically among themselves.
export const KNOWN_CATEGORIES = Object.freeze({
  credentials: { priority: 10, dependsOn: [] },
  sessions: { priority: 20, dependsOn: ["credentials"] },
  notifications: { priority: 30, dependsOn: [] },
  messages: { priority: 40, dependsOn: [] },
  media: { priority: 50, dependsOn: ["messages"] },
  activity: { priority: 60, dependsOn: [] },
  integrations: { priority: 70, dependsOn: [] },
  settings: { priority: 80, dependsOn: [] },
  billing: { priority: 90, dependsOn: [] },
  profile: { priority: 100, dependsOn: [] },
});

const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

const knownDefaults = category => Object.hasOwn(KNOWN_CATEGORIES, category)
  ? KNOWN_CATEGORIES[category]
  : { priority: 50, dependsOn: [] };

// Normalize one inventory descriptor into { itemCount, dependsOn,
// legalHold, legalHoldReason }. Malformed entries degrade to documented
// defaults instead of failing the plan.
function normalizeEntry(category, entry) {
  const defaults = knownDefaults(category);
  const source = isPlainObject(entry) ? entry : {};
  const itemCount = Number.isSafeInteger(source.itemCount) && source.itemCount >= 0 ? source.itemCount : 0;
  const dependsOn = Array.isArray(source.dependsOn)
    ? [...new Set(source.dependsOn.filter(d => typeof d === "string" && d.length > 0 && d !== category))]
    : [...defaults.dependsOn];
  const legalHold = Boolean(source.legalHold);
  const reason = typeof source.legalHoldReason === "string" && source.legalHoldReason.trim().length > 0
    ? source.legalHoldReason.trim()
    : DEFAULT_LEGAL_HOLD_REASON;
  return {
    category,
    priority: defaults.priority,
    itemCount,
    dependsOn: Object.freeze(dependsOn.sort()),
    legalHold,
    legalHoldReason: reason,
  };
}

// Deterministic topological order: a step runs only after every category
// in its dependsOn list. One node per round (Kahn's algorithm), ties broken
// by priority then alphabetically, so the same inventory always yields the
// same plan and dependency-free high-priority nodes (like the profile,
// priority 100) still run last. Unknown dependency names are ignored
// (recorded in errors) rather than failing the plan; dependency cycles fall
// back to priority/name order for the cyclic members.
function orderSteps(entries) {
  const byName = new Map(entries.map(e => [e.category, e]));
  const errors = [];
  const placed = new Set();
  const steps = [];
  const remaining = new Set(entries);
  const byPriority = (a, b) => a.priority - b.priority || (a.category < b.category ? -1 : 1);
  while (remaining.size > 0) {
    const ready = [...remaining].filter(e =>
      e.dependsOn.every(dep => !byName.has(dep) || placed.has(dep)));
    if (ready.length === 0) {
      errors.push("dependency cycle detected; remaining categories ordered by priority");
      for (const e of [...remaining].sort(byPriority)) {
        placed.add(e.category);
        steps.push(e);
      }
      break;
    }
    ready.sort(byPriority);
    const next = ready[0];
    placed.add(next.category);
    steps.push(next);
    remaining.delete(next);
  }
  for (const e of steps) {
    for (const dep of e.dependsOn) {
      if (!byName.has(dep)) errors.push(`"${e.category}" depends on unknown category "${dep}"; ignored`);
    }
  }
  return { steps, errors };
}

// Build the ordered purge plan. Frozen, deterministic, never throws.
// `now` is an injectable clock (defaults to Date.now) so tests can pin time.
export function planDeletion(account, inventory, { now } = {}) {
  const clock = typeof now === "function" ? now : () => Date.now();
  const errors = [];
  const accountId = isPlainObject(account) && typeof account.id === "string" ? account.id : null;
  if (accountId === null) errors.push("account has no id; plan is not attributable");
  const source = isPlainObject(inventory) ? inventory : {};
  if (!isPlainObject(inventory)) errors.push("inventory must be a plain object; planned with no categories");
  const categories = Object.keys(source).filter(name => typeof name === "string" && name.length > 0).sort();
  const entries = categories.map(category => normalizeEntry(category, source[category]));
  const ordered = orderSteps(entries);
  errors.push(...ordered.errors);
  const steps = ordered.steps.map(e => Object.freeze({
    category: e.category,
    action: e.legalHold ? ACTIONS.RETAIN : ACTIONS.PURGE,
    itemCount: e.itemCount,
    dependsOn: e.dependsOn,
    reason: e.legalHold ? e.legalHoldReason : "User-requested full purge on account deletion.",
  }));
  return Object.freeze({
    format_version: PLAN_FORMAT_VERSION,
    accountId,
    planned_at: new Date(clock()).toISOString(),
    categories: Object.freeze([...categories]),
    steps: Object.freeze(steps),
    errors: Object.freeze(errors),
  });
}

// Validate a plan for completeness and internal consistency: every
// inventory category it was planned from has exactly one step, retained
// steps carry a reason, dependency order is honored, and nothing deletes
// before its prerequisites. Never throws; returns { valid, errors }.
export function validatePurgePlan(plan) {
  const errors = [];
  if (!isPlainObject(plan)) {
    return { valid: false, errors: ["plan must be a plain object"] };
  }
  const categories = Array.isArray(plan.categories) ? plan.categories : [];
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const seen = new Set();
  const stepByCategory = new Map();
  for (const step of steps) {
    if (!isPlainObject(step) || typeof step.category !== "string") {
      errors.push("plan contains a malformed step");
      continue;
    }
    if (seen.has(step.category)) errors.push(`duplicate step for category "${step.category}"`);
    seen.add(step.category);
    stepByCategory.set(step.category, step);
    if (step.action !== ACTIONS.PURGE && step.action !== ACTIONS.RETAIN) {
      errors.push(`step "${step.category}" has unknown action "${step.action}"`);
    }
    if (step.action === ACTIONS.RETAIN
      && (typeof step.reason !== "string" || step.reason.trim().length === 0)) {
      errors.push(`retained category "${step.category}" is missing a legal-hold reason`);
    }
    if (!Number.isSafeInteger(step.itemCount) || step.itemCount < 0) {
      errors.push(`step "${step.category}" has an invalid itemCount`);
    }
  }
  for (const category of categories) {
    if (!stepByCategory.has(category)) errors.push(`inventory category "${category}" has no purge step`);
  }
  const position = new Map(steps.map((step, index) => [step?.category, index]));
  for (const step of steps) {
    if (!isPlainObject(step)) continue;
    const deps = Array.isArray(step.dependsOn) ? step.dependsOn : [];
    for (const dep of deps) {
      if (typeof dep !== "string") continue;
      if (!stepByCategory.has(dep)) continue; // unknown deps are already flagged at plan time
      if (position.get(dep) > position.get(step.category)) {
        errors.push(`step "${step.category}" runs before its dependency "${dep}"`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

// Human-facing confirmation summary for the deletion dialog: what goes,
// what stays (and why), in execution order. Never throws.
export function summarizePurge(plan) {
  const steps = isPlainObject(plan) && Array.isArray(plan.steps) ? plan.steps : [];
  const purged = steps.filter(s => isPlainObject(s) && s.action === ACTIONS.PURGE);
  const retained = steps.filter(s => isPlainObject(s) && s.action === ACTIONS.RETAIN);
  const purgedItems = purged.reduce((sum, s) => sum + (Number.isSafeInteger(s.itemCount) ? s.itemCount : 0), 0);
  const retainedItems = retained.reduce((sum, s) => sum + (Number.isSafeInteger(s.itemCount) ? s.itemCount : 0), 0);
  const lines = [];
  lines.push(`Account deletion: ${purged.length} categor${purged.length === 1 ? "y" : "ies"} purged (${purgedItems} items), `
    + `${retained.length} retained under legal hold (${retainedItems} items).`);
  if (purged.length > 0) {
    lines.push("Purged, in order:");
    for (const s of purged) lines.push(`  - ${s.category} (${s.itemCount} items)`);
  }
  if (retained.length > 0) {
    lines.push("Retained under legal hold:");
    for (const s of retained) lines.push(`  - ${s.category} (${s.itemCount} items): ${s.reason}`);
  }
  if (steps.length === 0) lines.push("No data categories in inventory: nothing to purge.");
  return Object.freeze({
    accountId: isPlainObject(plan) ? plan.accountId ?? null : null,
    purgeCount: purged.length,
    retainCount: retained.length,
    purgedItems,
    retainedItems,
    purgeOrder: Object.freeze(purged.map(s => s.category)),
    retained: Object.freeze(retained.map(s => Object.freeze({ category: s.category, reason: s.reason }))),    text: lines.join("\n"),
  });
}
