// room_propose_plan: propose several related work items in one call.
//
// Steal from Vercel Board's `tasks create --file plan.json --idempotency-key`
// (packages/board/src/contract/task-batch.ts batchPlan). Each item names a
// local key and the keys it needs; the plan turns that into ordinary
// room_propose_work commands, in dependency order, with deterministic
// workItemIds and requestIds derived from one planId. Nothing new is
// authorized: every item is still one work.proposed command through the
// normal steer gate. The plan is not atomic. It is resumable: a replay of the
// same input records nothing twice, and a changed item under the same planId
// is refused as idempotency_conflict, as for any reused requestId.
import { validWorkArguments, workTools } from "./work-actions.mjs";

export const PLAN_TOOL = "room_propose_plan";
export const PLAN_ITEMS_MAX = 20;
const DEPENDS_MAX = 16;
const PLAN_ID = "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$";
const PLAN_KEY = "^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$";

const propose = workTools.find(tool => tool.name === "room_propose_work");
const { requestId: _requestId, workItemId: _workItemId, ...itemFields } = propose.inputSchema.properties;
const itemRequired = propose.inputSchema.required.filter(field => field !== "workItemId");
const ITEM_FIELDS = new Set(["key", "needs", ...Object.keys(itemFields)]);
const key = { type: "string", pattern: PLAN_KEY, description: "Plan-local key, unique in this plan. The item's workItemId is <planId>-<key>." };

export const planTool = {
  name: PLAN_TOOL,
  title: "Propose a plan of work",
  description: `Propose 1–${PLAN_ITEMS_MAX} related work items in one call. Each item takes room_propose_work's fields plus a plan-local key; needs lists keys of this plan that must be done first and becomes dependsOn. Items are proposed in dependency order as ordinary room_propose_work commands, each under the same steer permission. workItemId is <planId>-<key>. Not atomic: if one item is refused, the earlier ones stay recorded and the response says which; fix the cause and call again with the same planId and input to record the rest. In a legacy Board room a dependsOn must already be on the Board, so a dependent item is refused until its prerequisite is accepted; resume the same way. Before writing, the plan reads its existing items: if any was recorded with other values, nothing is written (plan_changed); use a new planId for a changed plan. A plan whose recorded items all match may add new items.`,
  inputSchema: {
    type: "object",
    properties: {
      planId: { type: "string", pattern: PLAN_ID, description: "Stable plan ID. Keep it and the whole input unchanged on a retry." },
      items: { type: "array", minItems: 1, maxItems: PLAN_ITEMS_MAX, items: {
        type: "object",
        properties: { key, needs: { type: "array", maxItems: DEPENDS_MAX, items: key, description: "Keys of this plan's items that must be done first." }, ...itemFields },
        required: ["key", ...itemRequired],
        additionalProperties: false
      } }
    },
    required: ["planId", "items"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
};

const refused = message => Object.assign(new Error(`Invalid plan: ${message}`), { code: "invalid_work_plan" });

/**
 * The plan's room_propose_work calls, each prerequisite before its dependents.
 * Refuses duplicate keys, unknown or self needs, cycles, and items whose
 * combined dependsOn would exceed the command's limit. Reads nothing.
 */
export function planSteps(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw refused("expected { planId, items }");
  const { planId, items } = args;
  if (typeof planId !== "string" || !new RegExp(PLAN_ID).test(planId)) throw refused("planId must match " + PLAN_ID);
  if (!Array.isArray(items) || items.length < 1 || items.length > PLAN_ITEMS_MAX) throw refused(`items must hold 1 to ${PLAN_ITEMS_MAX} items`);
  const at = new Map();
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || typeof item.key !== "string" || !new RegExp(PLAN_KEY).test(item.key)) throw refused(`items.${index}.key must match ${PLAN_KEY}`);
    const unknown = Object.keys(item).find(field => !ITEM_FIELDS.has(field));
    if (unknown !== undefined) throw refused(`items.${index}.${unknown} is not a plan item field; workItemId and requestId are derived from planId and key`);
    if (at.has(item.key)) throw refused(`two items have the key ${JSON.stringify(item.key)}`);
    at.set(item.key, index);
  }
  const ownKey = new Map(items.map(item => [`${planId}-${item.key}`, item.key]));
  const inside = items.map((item, index) => {
    const needs = item.needs ?? [];
    if (!Array.isArray(needs)) throw refused(`items.${index}.needs must be an array of keys`);
    if (item.dependsOn !== undefined && !Array.isArray(item.dependsOn)) throw refused(`items.${index}.dependsOn must be an array of claim ids`);
    // An explicit dependsOn on another item of this plan orders the plan exactly as needs does.
    const planned = (item.dependsOn ?? []).filter(id => ownKey.has(id)).map(id => ownKey.get(id));
    return [...new Set([...needs, ...planned])].map(need => {
      if (!at.has(need)) throw refused(`items.${index}.needs names ${JSON.stringify(need)}, which no item of this plan has`);
      if (need === item.key) throw refused(`the item ${JSON.stringify(need)} needs itself`);
      return at.get(need);
    });
  });
  // Iterative depth-first order, so a long chain cannot overflow the stack.
  const order = [], state = new Uint8Array(items.length);
  for (let start = 0; start < items.length; start += 1) {
    if (state[start] !== 0) continue;
    const path = [{ index: start, next: 0 }];
    state[start] = 1;
    while (path.length > 0) {
      const top = path.at(-1), need = inside[top.index][top.next++];
      if (need === undefined) { state[top.index] = 2; order.push(top.index); path.pop(); continue; }
      if (state[need] === 1) throw refused(`items wait for each other: ${[...path.map(step => items[step.index].key), items[need].key].join(" -> ")}`);
      if (state[need] === 0) { state[need] = 1; path.push({ index: need, next: 0 }); }
    }
  }
  const workItemIdOf = itemKey => `${planId}-${itemKey}`;
  return order.map(index => {
    const { key: itemKey, needs: _needs, dependsOn = [], ...fields } = items[index];
    const merged = [...new Set([...dependsOn, ...inside[index].map(need => workItemIdOf(items[need].key))])].sort();
    if (merged.length > DEPENDS_MAX) throw refused(`items.${index} would depend on ${merged.length} items; at most ${DEPENDS_MAX}`);
    return { key: itemKey, name: "room_propose_work", args: {
      requestId: `plan.${planId}.${itemKey}`, workItemId: workItemIdOf(itemKey), ...fields,
      ...(merged.length > 0 ? { dependsOn: merged } : {})
    } };
  });
}

/** A work-context read for submitPlan: a missing item (404) is null, anything else is thrown. */
export function planRead(workContext) {
  return async workItemId => {
    try {
      return await workContext(workItemId);
    } catch (cause) {
      if (cause?.status === 404) return null;
      throw cause;
    }
  };
}

const definitive = cause => Number.isInteger(cause?.status) && cause.status >= 400 && cause.status < 500 && typeof cause.code === "string";
const sameValue = (left, right) => (left ?? null) === (right ?? null);

/**
 * The fields of a recorded item that differ from this plan's step: the
 * proposal fields, the proposer and the dependencies. An empty list means the
 * recorded item is this step's proposal.
 */
export function planDrift(step, context, memberId) {
  const work = context?.work ?? {};
  const { requestId: _requestId, workItemId: _workItemId, dependsOn = [], ...fields } = step.args;
  const drift = Object.keys(fields).filter(field => !sameValue(fields[field], work[field]));
  if (memberId !== undefined && !sameValue(work.proposedById, memberId)) drift.push("proposedById");
  const recordedDepends = (context?.dependencies ?? []).map(dependency => dependency.id).sort();
  if (recordedDepends.join() !== [...dependsOn].sort().join()) drift.push("dependsOn");
  return drift;
}

/**
 * Records the plan's steps in order through `execute(step)`, which returns the
 * normal room_propose_work receipt or throws. First, `read(workItemId)` (the
 * work context, or null when there is none) binds the plan to its planId:
 * if any item already exists and differs from this input, nothing is written.
 * Stops at the first refusal and reports what was recorded, what was not, and
 * the exact call that resumes. An unknown outcome is unconfirmed, never refused.
 */
export async function submitPlan(args, execute, { read, memberId, refusal = () => null } = {}) {
  const steps = planSteps(args), recorded = [];
  const retry = when => ({ tool: PLAN_TOOL, arguments: args, when });
  const changed = [];
  for (const step of steps) {
    let context;
    try {
      context = await read(step.args.workItemId);
    } catch (cause) {
      return { status: "unconfirmed", planId: args.planId, recorded, unconfirmed: { key: step.key, workItemId: step.args.workItemId, code: cause?.code ?? "unknown" },
        next: [retry("retry the exact same input; nothing was written")],
        message: "The plan's existing items could not be read, so nothing was written. Retry the exact same input." };
    }
    const drift = context ? planDrift(step, context, memberId) : [];
    if (drift.length > 0) changed.push({ key: step.key, workItemId: step.args.workItemId, fields: drift });
  }
  if (changed.length > 0) return { status: "refused", code: "plan_changed", planId: args.planId, recorded, changed,
    next: [{ tool: "room_read_work", arguments: { workItemId: changed[0].workItemId }, when: "to compare the recorded item with this input" },
      { tool: PLAN_TOOL, arguments: { ...args, planId: `${args.planId}-2` }, when: "to propose the changed plan as a new plan" }],
    message: `Nothing was written: ${changed.length} item(s) of planId ${args.planId} were already recorded with other values. Resend the original input, or use a new planId for a changed plan.` };
  for (const [index, step] of steps.entries()) {
    let receipt;
    try {
      receipt = await execute(step);
    } catch (cause) {
      if (!definitive(cause)) return { status: "unconfirmed", planId: args.planId, recorded,
        unconfirmed: { key: step.key, workItemId: step.args.workItemId, code: cause?.code ?? "unknown" },
        next: [retry("retry the exact same input; the item's outcome is unknown")],
        message: "Outcome of one item is unknown. Retry the exact same input; do not create a replacement planId." };
      return { status: "partial", planId: args.planId, recorded,
        refused: { key: step.key, workItemId: step.args.workItemId, code: cause.code, message: cause.message, detail: refusal(cause, step) },
        notAttempted: steps.slice(index + 1).map(rest => rest.key),
        next: [retry("after fixing the refused item's cause; recorded items replay as duplicates"),
          { tool: "room_read_work", arguments: { workItemId: step.args.workItemId }, when: "to see whether the refused item already exists" }],
        message: `Recorded ${recorded.length} of ${steps.length} items. Fix the refused item and call ${PLAN_TOOL} again with the same input; do not change the planId.` };
    }
    if (receipt?.status !== "recorded") return { status: "unconfirmed", planId: args.planId, recorded, unconfirmed: { key: step.key, workItemId: step.args.workItemId, receipt },
      next: [retry("retry the exact same input")],
      message: "Outcome of one item is unknown. Retry the exact same input; do not create a replacement planId." };
    recorded.push({ key: step.key, workItemId: step.args.workItemId, requestId: receipt.requestId, sequence: receipt.sequence, duplicate: receipt.duplicate });
  }
  return { status: "recorded", planId: args.planId, recorded,
    next: [{ tool: "room_read_work", arguments: { workItemId: recorded[0].workItemId }, when: "to read the first item with no prerequisite" }],
    message: "Every item was proposed. Proposals still need acceptance; dependsOn gates claiming and starting. This receipt does not prove current state." };
}

/** Input check for the MCP routers: the plan resolves and every step is a valid room_propose_work call. */
export function validPlanArguments(args) {
  try {
    return planSteps(args).every(step => validWorkArguments(step.name, step.args));
  } catch {
    return false;
  }
}
