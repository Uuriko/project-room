import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { EVENT_TYPES as T, validId } from "../src/events.js";
import { replyPostMode, REPLY_POLICY_VERSION } from "../src/reply-requests.js";
import { reportedProducer } from "../src/work-packet.js";
import { agentErrorAx } from "../src/agent-error.mjs";

const id = { type: "string", minLength: 1, maxLength: 128, pattern: "^(?!(?:constructor|prototype|__proto__)$)[A-Za-z0-9][A-Za-z0-9_.:-]*$" };
const text = { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S" };
const bool = { type: "boolean" }, revision = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const common = { requestId: { ...id, description: "Stable business operation ID. Keep this ID and ALL input unchanged after an uncertain result, cancellation or reconnect." },
  workItemId: id, expectedRevision: { ...revision, description: "The exact work revision you inspected. Never automatically replace it on retry." } };
const retry = " Preserve the exact input across retries. A saved receipt confirms this operation, not current ownership or approval; read the task again for its current next step.";
const externalProducer = { ...text, maxLength: 160, description: "Optional reported outside person, team or AI credit. Use only with producerId=null (or omitted for external evidence). Does not create membership, verify identity or establish reviewer independence." };
const definitions = [
  ["submit_text_result", "Save room text as result", T.WORK_COMPLETED, "Submit one immutable work-linked Room message as your assigned result. Preview it with room_read_result first. Pins its post event, exact UTF-8 SHA-256 and previous completion (explicit null for first). Same completion/claim gates as external evidence. Posting, producer attribution, review and human approval remain separate.", {
    summary: text, nextAction: text, evidenceMessageId: id, evidenceMessageEventId: id,
    evidenceVersion: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    previousCompletionEventId: { ...id, type: ["string", "null"] }, producerId: { ...id, type: ["string", "null"] },
    externalProducer,
    checksClaimed: { type: "array", maxItems: 64, items: { ...text, maxLength: 512 } }
  }, ["summary", "nextAction", "evidenceMessageId", "evidenceMessageEventId", "evidenceVersion", "previousCompletionEventId", "producerId"]],
  ["propose_work", "Propose work", T.WORK_PROPOSED, "Propose a new assigned task. Requires steer permission; ordinary enrolled agents do not receive it. This neither accepts nor starts work.", {
    title: text, definitionOfDone: text, accountableMemberId: id, mode: { type: "string", enum: ["read", "write"] },
    independentVerificationRequired: bool, ownerDecisionRequired: bool, verifierMemberId: id, humanDecisionMakerId: id, sourceMessageId: id
  }, ["title", "definitionOfDone", "accountableMemberId", "mode", "independentVerificationRequired", "ownerDecisionRequired"]],
  ["accept_work", "Accept assignment", T.WORK_ACCEPTED, "Accept your assigned proposed task. Requires accept_work. Does not grant outside access or start a runtime.", {}],
  ["start_work", "Record work started", T.WORK_STARTED, "Record that you are starting your assigned task. Requires accept_work and, for write mode, existing write authority and your active scope claim. Does not run code or tools. Starting blocked work requires resolvedBlocker.", { resolvedBlocker: text }, []],
  ["block_work", "Report blocker", T.WORK_BLOCKED, "Report a blocker or reopen your completed task for rework. Requires assigned accept_work. Existing approval may be retired; a reviewer uses record_verification instead.", { reason: text, nextAction: text }],
  ["resolve_blocker", "Resolve blocker", T.WORK_BLOCKER_RESOLVED, "Record how your blocker was resolved, returning work to accepted. Requires assigned accept_work. Does not restart work or renew a claim.", { resolution: text }],
  ["record_completion", "Submit result", T.WORK_COMPLETED, "Record your assigned task's result and evidence reference. Requires complete_work; write mode also requires current write authority and your active claim. Producer attribution is an explicit assertion, never inferred. Evidence is not fetched. This is not verification or human approval.", {
    summary: text, evidenceUrl: { ...text, description: "HTTPS reference without embedded credentials; not fetched or independently verified by Room." }, evidenceVersion: text, nextAction: text,
    producerId: { ...id, type: ["string", "null"], description: "Explicit reported producer. Omit or use null when unknown; do not guess." },
    externalProducer,
    checksClaimed: { type: "array", maxItems: 64, items: { ...text, maxLength: 512 } }
  }, ["summary", "evidenceUrl", "evidenceVersion", "nextAction"]],
  ["record_verification", "Record evidence review", T.VERIFICATION_RECORDED, "Record your own check of the exact completion event and evidence version inspected. Requires designated verify authority; independent review cannot be by its producer. Historical findings do not approve newer evidence. Never substitute the latest receipt automatically.", {
    result: { type: "string", enum: ["pass", "fail"] }, completionEventId: id, evidenceVersion: text, summary: text, nextAction: text
  }, ["result", "completionEventId", "evidenceVersion", "summary"]],
  ["acquire_claim", "Reserve work scope", T.CLAIM_ACQUIRED, "Reserve a declared repository/ref/path scope for your assigned write-mode task. Requires existing write_external authority, not granted by enrollment presets. Coordinates this room only; does not authorize external writes, resolve repository aliases or stop other processes.", {
    repository: text, ref: text, paths: { type: "array", minItems: 1, maxItems: 64, items: { ...text, maxLength: 512 } },
    expiresAt: { ...text, description: "Explicit ISO timestamp. The service checks that it is in the future; no automatic renewal." }
  }],
  ["release_claim", "Release work scope", T.CLAIM_RELEASED, "Release an active claim you hold (or manage with manage_claims). Does not stop an outside worker. A duplicate receipt does not describe the current reservation.", {}],
  ["supersede_work", "Replace work", T.WORK_SUPERSEDED, "Replace work with an already-existing work item. Requires steer, not granted by enrollment presets. Retires the original work's active reservation/approval; does not transfer them to its replacement.", { supersededByWorkItemId: id, reason: text }],
  ["record_handoff", "Record handoff receipt", T.WORK_HANDOFF_RECORDED, "Record a handoff receipt when you cannot continue your assigned task: what is actually done against the done criteria, an optional partial-evidence reference, the exact next action, and why you are stopping. This never closes, completes or reassigns the work; the state and review gates stay with the room. haltAll=true also stops all your further work mutations until a steer/decide member clears the exact halt.", {
    doneSummary: { ...text, description: "What is actually done against the definition of done; partial is expected, state it exactly." },
    evidenceUrl: { ...text, description: "Optional HTTPS reference without embedded credentials; not fetched. Requires evidenceVersion when present." },
    evidenceVersion: { ...text, description: "Version of the partial evidence; required with evidenceUrl." },
    nextAction: { ...text, description: "The exact next action for whoever picks this up." },
    limitReason: { ...text, description: "Why you cannot continue (limit hit, missing permission, context exhausted)." },
    haltAll: { ...bool, description: "true halts all your further work mutations project-wide until the exact halt is cleared." }
  }, ["doneSummary", "nextAction", "limitReason"]],
  ["clear_halt", "Clear a member halt", T.WORK_HALT_CLEARED, "Clear one exact recorded halt-all after triage. Requires steer or decide; the halted member cannot clear its own halt. Names the exact halt event inspected.", {
    memberId: id, haltEventId: id, note: { ...text, maxLength: 512, description: "Optional triage note." }
  }, ["memberId", "haltEventId"]]
];

const actions = new Map(definitions.map(([name, title, type, description, properties, required = Object.keys(properties)]) => {
  const fields = type === T.WORK_PROPOSED ? { requestId: common.requestId, workItemId: id } : type === T.WORK_HALT_CLEARED ? { requestId: common.requestId } : common;
  return ["room_" + name, { type, tool: { name: "room_" + name, title, description: description + retry,
    inputSchema: object({ ...fields, ...properties }, [...Object.keys(fields), ...required]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } } }];
}));
export const workTools = [...actions.values()].map(action => action.tool);
export const isWorkTool = name => actions.has(name);

// Validator for this finite descriptor vocabulary, not a general JSON Schema engine.
export function conforms(value, shape) {
  if (value === null) return Array.isArray(shape.type) && shape.type.includes("null");
  const type = Array.isArray(shape.type) ? shape.type.find(type => type !== "null") : shape.type;
  if (type === "object") return typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => Object.hasOwn(shape.properties, key))
    && shape.required.every(key => Object.hasOwn(value, key))
    && Object.entries(value).every(([key, value]) => conforms(value, shape.properties[key]));
  if (type === "array") return Array.isArray(value) && value.length >= (shape.minItems ?? 0) && value.length <= shape.maxItems && Array.from(value).every(item => conforms(item, shape.items));
  if (type === "integer") return Number.isSafeInteger(value) && value >= shape.minimum && value <= shape.maximum;
  if (type === "boolean") return typeof value === "boolean";
  return typeof value === "string" && (!shape.enum || shape.enum.includes(value)) && value.length >= (shape.minLength ?? 0)
    && value.length <= (shape.maxLength ?? Infinity) && (!shape.pattern || new RegExp(shape.pattern).test(value));
}
export function validWorkArguments(name, args) {
  if (!actions.has(name) || !conforms(args, actions.get(name).tool.inputSchema)) return false;
  try { if (actions.get(name).type === T.WORK_COMPLETED) reportedProducer(args); } catch { return false; }
  return true;
}
export function buildWorkCommand(name, args) {
  if (!validWorkArguments(name, args)) throw Object.assign(new Error("Invalid work action input"), { code: "invalid_work_action" });
  const { requestId, ...data } = structuredClone(args), command = { id: requestId, type: actions.get(name).type, data };
  if (name === "room_submit_text_result") data.evidenceKind = "room_text";
  if (Buffer.byteLength(JSON.stringify(command)) > 16384) throw Object.assign(new Error("Work action exceeds the command limit"), { code: "work_action_too_large" });
  return command;
}
export function confirmsAgentCommand(receipt, command, { roomId, memberId }) {
  const entry = receipt?.event;
  let data = command.data;
  try {
    if (command.type === T.MESSAGE_POSTED && replyPostMode(data)) data = { ...data, requestPolicyVersion: REPLY_POLICY_VERSION };
  } catch { return false; }
  return Number.isSafeInteger(receipt?.sequence) && receipt.sequence > 0 && typeof receipt.duplicate === "boolean"
    && validId(entry?.id) && entry.type === command.type && entry.roomId === roomId && entry.actorId === memberId
    && entry.idempotencyKey === createHash("sha256").update(`${memberId}:${command.id}`).digest("hex")
    && entry.causationId === (command.causationId ?? null) && typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at))
    && isDeepStrictEqual(entry.data, data);
}
export async function submitWorkAction(client, identity, name, args, { signal } = {}) {
  if (!validId(identity?.roomId) || !validId(identity?.memberId)) throw new Error("Pinned agent identity required");
  const command = buildWorkCommand(name, args), receipt = await client.command(command, { signal });
  if (!confirmsAgentCommand(receipt, command, identity)) return { status: "unconfirmed", requestId: command.id,
    message: "Outcome unknown. Retain and retry the exact original input; do not create a replacement requestId." };
  return { contractVersion: 1, status: "recorded", requestId: command.id, workItemId: command.data.workItemId,
    action: name, sequence: receipt.sequence, eventId: receipt.event.id, duplicate: receipt.duplicate,
    appliedRevision: command.type === T.WORK_PROPOSED ? 0 : command.data.expectedRevision === undefined ? null : command.data.expectedRevision + 1,
    currentStateVerified: false, next: command.type === T.WORK_HALT_CLEARED
    ? { tool: "room_read_board", arguments: {} }
    : { tool: "room_read_work", arguments: { workItemId: command.data.workItemId } },
    ...(command.data.evidenceKind === "room_text" ? { result: { completionEventId: receipt.event.id, evidenceVersion: command.data.evidenceVersion,
      read: { tool: "room_read_result", arguments: { workItemId: command.data.workItemId, completionEventId: receipt.event.id } } } } : {}),
    message: "This original operation was recorded. Read current work before another action; this receipt does not prove current ownership, review or human approval." };
}

const refusals = {
  idempotency_conflict: "This requestId belongs to different input. Recover the original instead of replacing its ID blindly.",
  claim_conflict: "Another work item reserves overlapping scope. Read the room's work and coordinate release; do not start the conflicting work.",
  invalid_claim_scope: "Use explicit repository/ref and relative paths, folder/**, or **. Review the scope before a new deliberate attempt.",
  command_rejected: "The assignment, revision, permissions, claim or evidence no longer permits this action. Read current work; never silently rebase an approval or review.",
  invalid_cause: "The referenced causal event is unavailable in this room. Review the original input.",
  pilot_limit: "Room capacity was reached. Ask the owner to review capacity; do not replace the original operation blindly."
};
export function workActionRefusal(cause) {
  const ax = agentErrorAx({ httpStatus: cause?.status ?? 0, code: cause?.code, message: cause?.message });
  if (["invalid_work_action", "work_action_too_large"].includes(cause?.code)) return { type: "work_input_refused", code: cause.code,
    outcome: "this_attempt_not_sent", message: "Input was not sent. Use the listed fields and reduce text/checks to fit the command limit. If this ID had an earlier uncertain attempt, reconcile its original input before changing it.",
    status: ax.status, reason: ax.reason, hint: ax.hint, next: ax.next };
  if (![409, 422].includes(cause?.status) || !Object.hasOwn(refusals, cause.code)) return null;
  return { type: "work_refused", code: cause.code, outcome: "this_attempt_refused", message: refusals[cause.code],
    status: ax.status, reason: ax.reason, hint: ax.hint, next: ax.next };
}
