// F013: moderation queue bulk actions (pairs with F014 abuse reporting).
//
// One operator, one action, many queue items: approve / reject / escalate a
// set of moderation queue items in a single call. The F014 abuse-report
// lifecycle (submitted -> triaged -> actioned | dismissed) is what feeds
// this queue, so the status vocabulary is imported from src/abuse-reporting.mjs
// rather than redefined: only items in an OPEN status (submitted, triaged)
// are actionable; terminal items (actioned, dismissed) fail per-item.
//
// Pure functions, plain arguments, no I/O: the store, the audit sink, the
// clock, and the idempotency memory are all injected, so the wiring slice
// can drive the same logic server-side or in tests.
//
// API:
//   ACTIONS / ACTION_APPROVE / ACTION_REJECT / ACTION_ESCALATE — the three
//     bulk actions. approve -> actioned, reject -> dismissed,
//     escalate -> (re-)triaged; the store performs the actual mutation.
//   TRANSITIONS — action -> { from: actionable statuses, to: target status }.
//   LIMITS — batch limits (maxBatch mirrors the F014 list page cap of 200).
//   BulkActionError — typed error carrying { code, errors }; batch-level
//     validation failures throw this, per-item failures never throw.
//   validateBulkAction(items, action, actor) — batch validation returning a
//     list of typed errors: [] means the batch may run. Batch-aborting
//     codes: empty_batch, invalid_items, duplicate_item, unknown_action,
//     invalid_actor, forbidden_actor. Per-item codes (isolation candidates):
//     not_actionable.
//   bulkAction(items, action, { actor, store, idempotencyKey, audit, now, id,
//     idempotency }) — run the batch. Batch-level validation failures throw
//     BulkActionError. Every item is then applied individually: a
//     non-actionable item or a store throw is recorded as a per-item
//     failure and never aborts the batch. Returns { action, idempotencyKey,
//     actorId, at, succeeded, failed, total, results } where each result is
//     { itemId, ok, code?, message?, from?, to? }.
//
// Store interface (injected):
//   store.applyAction(itemId, action, { actorId, at }) -> the updated item
//     (its `status` is recorded as the result's `to`). Throws on failure;
//     the throw is isolated to that item's result.
//
// Audit: one batch-level entry is emitted through the injected `audit`
// sink (F004/F020 style: { id, type, actorId, at, data }) carrying the
// action, every item id, the succeeded/failed counts, and the idempotency
// key. No audit entry is emitted on an idempotent replay.
//
// Idempotency: `idempotency` is an injectable Map-like ({ get, set }) owned
// by the caller (the wiring slice persists it). The first call for a key
// computes and stores the summary; later calls with the same key return
// the stored summary without touching the store or the audit sink.
// Without an injected map there is no cross-call memory — every call runs.

import { randomUUID } from "node:crypto";
import { STATUSES, OPEN_STATUSES } from "./abuse-reporting.mjs";

export const ACTION_APPROVE = "approve";
export const ACTION_REJECT = "reject";
export const ACTION_ESCALATE = "escalate";

export const ACTIONS = Object.freeze([ACTION_APPROVE, ACTION_REJECT, ACTION_ESCALATE]);

// Queue statuses that accept a bulk action; reuses the F014 lifecycle.
export const ACTIONABLE_STATUSES = Object.freeze([...OPEN_STATUSES]);

// What each bulk action means in the F014 lifecycle. approve closes a
// report as actioned, reject closes it as dismissed, escalate (re-)opens
// triage so an owner can look again.
export const TRANSITIONS = Object.freeze({
  [ACTION_APPROVE]: Object.freeze({ from: ACTIONABLE_STATUSES, to: STATUSES.actioned }),
  [ACTION_REJECT]: Object.freeze({ from: ACTIONABLE_STATUSES, to: STATUSES.dismissed }),
  [ACTION_ESCALATE]: Object.freeze({ from: ACTIONABLE_STATUSES, to: STATUSES.triaged })
});

// Roles allowed to run a bulk action.
export const MODERATOR_ROLES = Object.freeze(["owner", "moderator"]);

export const LIMITS = Object.freeze({
  maxBatch: 200,
  idLength: 128,
  idempotencyKeyLength: 128
});

export class BulkActionError extends Error {
  constructor(code, message, errors = []) {
    super(message);
    this.name = "BulkActionError";
    this.code = code;
    this.errors = errors;
  }
}

const fail = (code, message, errors) => {
  throw new BulkActionError(code, message, errors);
};

const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

// Batch-level codes abort the whole run; per-item codes isolate to one result.
const BATCH_CODES = new Set([
  "empty_batch",
  "invalid_items",
  "duplicate_item",
  "unknown_action",
  "invalid_actor",
  "forbidden_actor",
  "batch_too_large",
  "invalid_idempotency_key"
]);

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const validItemId = (value) =>
  isNonEmptyString(value) && value.trim().length <= LIMITS.idLength && idPattern.test(value.trim());

const validKey = (value) =>
  isNonEmptyString(value) && value.trim().length <= LIMITS.idempotencyKeyLength;

// validateBulkAction returns typed errors; [] means the batch may run.
// Batch-aborting codes are surfaced by bulkAction as a thrown
// BulkActionError; not_actionable entries describe items that bulkAction
// isolates as per-item failures instead of aborting.
export function validateBulkAction(items, action, actor) {
  const errors = [];
  const err = (code, message, itemId) =>
    errors.push(itemId === undefined ? { code, message } : { code, message, itemId });

  if (!Array.isArray(items) || items.length === 0) {
    err("empty_batch", "Bulk action needs at least one queue item");
    return errors;
  }
  if (items.length > LIMITS.maxBatch) {
    err("batch_too_large", `Bulk action accepts at most ${LIMITS.maxBatch} items, got ${items.length}`);
  }

  if (!ACTIONS.includes(action)) {
    err("unknown_action", `Action must be one of ${ACTIONS.join(", ")}, got ${String(action)}`);
  }

  if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
    err("invalid_actor", "Actor must be an object with { id, role }");
  } else {
    if (!validItemId(actor.id)) {
      err("invalid_actor", "Actor id must be a valid member id");
    }
    if (!MODERATOR_ROLES.includes(actor.role)) {
      err("forbidden_actor", `Actor role must be one of ${MODERATOR_ROLES.join(", ")}, got ${String(actor.role)}`);
    }
  }

  const seen = new Set();
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      err("invalid_items", `items[${index}] must be a queue item object with { id, status }`);
      continue;
    }
    if (!validItemId(item.id)) {
      err("invalid_items", `items[${index}].id must be a valid item id`);
      continue;
    }
    const itemId = item.id.trim();
    if (seen.has(itemId)) {
      err("duplicate_item", `Item ${itemId} appears more than once in the batch`);
    } else {
      seen.add(itemId);
    }
    if (!ACTIONABLE_STATUSES.includes(item.status)) {
      err("not_actionable", `Item ${itemId} is ${String(item.status)} and cannot be actioned`, itemId);
    }
  }
  return errors;
}

const iso = (ms) => new Date(ms).toISOString();

// One audit entry per bulk run, in the F004/F020 event style:
// { id, type, actorId, at, data }. The wiring slice owns the sink (and its
// persistence); this module only shapes the entry.
const auditEntry = ({ id, action, actorId, at, itemIds, succeeded, failed, idempotencyKey }) => ({
  id,
  type: `moderation.bulk_${action}`,
  actorId,
  at: iso(at),
  data: { action, itemIds, succeeded, failed, idempotencyKey }
});

// bulkAction applies one action across a set of queue items.
//
// Validation: batch-level failures (empty set, unknown action, actor
// without permission, malformed items, duplicates) throw BulkActionError.
// Per-item failures (non-actionable status, store throw) are isolated into
// the summary's results and never abort the batch.
//
// Idempotency: when `idempotency` (an injectable Map-like owned by the
// caller) already holds the key, the stored summary is returned verbatim:
// no store calls, no audit entry.
export function bulkAction(items, action, options = {}) {
  const {
    actor,
    store,
    idempotencyKey,
    audit = () => {},
    now = () => Date.now(),
    id = () => randomUUID(),
    idempotency = new Map()
  } = options;

  if (!validKey(idempotencyKey)) {
    fail("invalid_idempotency_key", "idempotencyKey must be a non-empty string", [
      { code: "invalid_idempotency_key", message: "idempotencyKey must be a non-empty string" }
    ]);
  }
  const key = idempotencyKey.trim();

  const errors = validateBulkAction(items, action, actor);
  const batchErrors = errors.filter((e) => BATCH_CODES.has(e.code));
  if (batchErrors.length > 0) {
    fail("invalid_batch", `Bulk action rejected: ${batchErrors.map((e) => e.code).join(", ")}`, batchErrors);
  }

  if (idempotency && typeof idempotency.get === "function") {
    const replay = idempotency.get(key);
    if (replay !== undefined) return replay;
  }

  if (!store || typeof store.applyAction !== "function") {
    fail("invalid_store", "store must expose applyAction(itemId, action, { actorId, at })", [
      { code: "invalid_store", message: "store must expose applyAction(itemId, action, { actorId, at })" }
    ]);
  }

  const actorId = actor.id.trim();
  const transition = TRANSITIONS[action];
  const at = now();
  const notActionable = new Map(
    errors.filter((e) => e.code === "not_actionable").map((e) => [e.itemId, e])
  );

  const results = [];
  const itemIds = [];
  let succeeded = 0;
  for (const item of items) {
    const itemId = item.id.trim();
    itemIds.push(itemId);
    const blocked = notActionable.get(itemId);
    if (blocked) {
      results.push({ itemId, ok: false, code: "not_actionable", message: blocked.message, from: item.status });
      continue;
    }
    const from = item.status;
    try {
      const updated = store.applyAction(itemId, action, { actorId, at });
      succeeded += 1;
      results.push({
        itemId,
        ok: true,
        action,
        from,
        to: updated && updated.status !== undefined ? updated.status : transition.to
      });
    } catch (cause) {
      results.push({
        itemId,
        ok: false,
        code: "apply_failed",
        message: cause instanceof Error ? cause.message : String(cause),
        from
      });
    }
  }

  const summary = {
    action,
    idempotencyKey: key,
    actorId,
    at: iso(at),
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    expectedTo: transition.to,
    results
  };

  audit(
    auditEntry({
      id: id(),
      action,
      actorId,
      at,
      itemIds,
      succeeded: summary.succeeded,
      failed: summary.failed,
      idempotencyKey: key
    })
  );

  if (idempotency && typeof idempotency.set === "function") {
    idempotency.set(key, summary);
  }
  return summary;
}
