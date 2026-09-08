import { validId } from "../src/events.js";
import { HELP_OFFER_OPENED, HELP_OFFER_UPDATED, validateHelpOfferData } from "../src/help-offers.js";
import { conforms, confirmsAgentCommand } from "./work-actions.mjs";

const id = { type: "string", minLength: 1, maxLength: 128, pattern: "^(?!(?:constructor|prototype|__proto__)$)[A-Za-z0-9][A-Za-z0-9_.:-]*$" };
const revision = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 };
const text = { type: "string", minLength: 1, maxLength: 600, pattern: "\\S" };
const invitation = { expectedHelpRevision: revision, helpEventId: id };
const common = { requestId: { ...id, description: "Stable operation ID. Preserve ALL input on uncertain retry, including across reconnects." },
  workItemId: id, offerId: id, expectedRevision: { ...revision, description: "Exact task revision inspected; never automatically refresh it on retry." } };
const definitions = [
  ["room_offer_help", null, "Offer help", "Offer one bounded contribution to a current help invitation. Read room_read_work with includeOffers=true first. Requires current invitation eligibility and capacity; no assignment, execution or payment follows.", { ...invitation, plan: text }],
  ["room_select_help_offer", "selected", "Select helper", "Select one current offer as the task's accountable member. At most one helper can be selected; competing selections are refused. This reserves coordination only, not external authority or work completion.", invitation],
  ["room_decline_help_offer", "declined", "Decline offer", "Decline a pending offer as the accountable member or room owner. Does not cancel external activity.", {}],
  ["room_withdraw_help_offer", "withdrawn", "Withdraw offer", "Withdraw your own pending offer. A selected offer must be explicitly released instead.", {}],
  ["room_release_help_offer", "released", "Release helper", "Release a selected offer as its helper, accountable member or room owner. Even if consent expired, selection remains reserved until explicit release. You must acknowledge that outside activity is unverified; this never stops a runtime.", {
    externalActivityUnverified: { type: "boolean", enum: [true], description: "Must be true. Release does not confirm that outside work stopped." }
  }]
];
const actions = new Map(definitions.map(([name, status, title, description, extra]) => {
  const properties = { ...common, ...(status ? { expectedOfferRevision: revision, reason: text } : {}), ...extra };
  return [name, { status, type: status ? HELP_OFFER_UPDATED : HELP_OFFER_OPENED,
    tool: { name, title, description: description + " Keep the exact input and requestId after an unknown result. Read current offers after a receipt; receipts describe the original operation, not current selection.",
      inputSchema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } } }];
}));
export const helpTools = [...actions.values()].map(action => action.tool);
export const isHelpTool = name => actions.has(name);

function commandData(action, args) {
  const { requestId, ...data } = args;
  return { ...data, ...(action.status ? { status: action.status } : {}) };
}
export function validHelpArguments(name, args) {
  const action = actions.get(name);
  if (!action || !conforms(args, action.tool.inputSchema)) return false;
  try { validateHelpOfferData(action.type, commandData(action, args)); return true; }
  catch { return false; }
}
export function buildHelpCommand(name, args) {
  if (!validHelpArguments(name, args)) throw Object.assign(new Error("Invalid help action input"), { code: "invalid_help_action" });
  const action = actions.get(name);
  return { id: args.requestId, type: action.type, data: structuredClone(commandData(action, args)) };
}
export async function submitHelpAction(client, identity, name, args, { signal } = {}) {
  if (!validId(identity?.roomId) || !validId(identity?.memberId)) throw new Error("Pinned agent identity required");
  const command = buildHelpCommand(name, args), receipt = await client.command(command, { signal });
  if (!confirmsAgentCommand(receipt, command, identity)) return { status: "unconfirmed", requestId: command.id,
    message: "Outcome unknown. Retain and retry the exact original input; do not create a replacement requestId." };
  return { contractVersion: 1, status: "recorded", action: name, requestId: command.id, workItemId: command.data.workItemId,
    offerId: command.data.offerId, appliedOfferRevision: command.type === HELP_OFFER_OPENED ? 0 : command.data.expectedOfferRevision + 1,
    sequence: receipt.sequence, eventId: receipt.event.id, duplicate: receipt.duplicate, currentStateVerified: false,
    authority: "coordination_only", externalExecution: false, workStateChanged: false,
    next: { tool: "room_read_work", arguments: { workItemId: command.data.workItemId, includeOffers: true } },
    message: "The original coordination operation was recorded. Read current offers before another action; no execution or payment was authorized." };
}
export function helpActionRefusal(cause) {
  const common = { type: "help_offer_refused", outcome: "not_confirmed",
    message: "Outcome not confirmed. Keep the exact original input and requestId; a lost response does not prove the operation was not saved." };
  if (cause?.code === "invalid_help_action") return { ...common, code: cause.code, outcome: "this_attempt_not_sent",
    message: "Use the listed fields and a short plan or reason. If an earlier attempt was uncertain, reconcile that exact input before changing it." };
  if ([409, 422].includes(cause?.status) && ["command_rejected", "idempotency_conflict", "pilot_limit"].includes(cause.code)) return {
    ...common, code: cause.code, outcome: "this_attempt_refused",
    message: cause.code === "idempotency_conflict"
      ? "This requestId belongs to different input. Recover the original; never replace its ID blindly."
      : "The task, invitation, offer, membership or capacity no longer permits this action. Read current offers and review the change; never automatically rebase or take over."
  };
  return null;
}
