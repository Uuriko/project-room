import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { EVENT_TYPES as T, validId } from "../src/events.js";
import { replyPostMode, REPLY_POLICY_VERSION, ANSWER_CREDENTIALS } from "../src/reply-requests.js";
import { reportedProducer } from "../src/work-packet.js";
import { agentErrorAx } from "../src/agent-error.mjs";
import { withDerivedRequestId } from "./request-id.mjs";

const id = { type: "string", minLength: 1, maxLength: 128, pattern: "^(?!(?:constructor|prototype|__proto__)$)[A-Za-z0-9][A-Za-z0-9_.:-]*$" };
const text = { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S" };
const bool = { type: "boolean" }, revision = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const common = { requestId: { ...id, description: "Optional stable business operation ID. Omit on the first call and the service derives one from the tool, room, actor and input; keep the returned ID and ALL input unchanged after an uncertain result, cancellation or reconnect." },
  workItemId: id, expectedRevision: { ...revision, description: "Optional exact work revision you inspected. Omit to use the current revision; a conflict means the work changed before this attempt was recorded." } };
const retry = " Preserve the exact input across retries. A saved receipt confirms this operation, not current ownership or approval; read the task again for its current next step.";
const attempt = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Optional exact finished successful session attempt of this work. Must belong to you and match producerId. Its declared metadata is snapshotted, not independently verified; omission means unknown." };
const externalProducer = { ...text, maxLength: 160, description: "Optional reported outside person, team or AI credit. Use only with producerId=null (or omitted for external evidence). Does not create membership, verify identity or establish reviewer independence." };
// RC-2026-09-19-063: fact / inference / proposal marks on a result. A
// passage of the result is labeled as observed fact, derived inference, or
// suggested action. Optional; unmarked results stay unmarked, never guessed.
const resultSegments = { type: "array", maxItems: 20, description: "Optional 1–20 marked passages: kind is fact (observed), inference (derived), or proposal (suggested, non-authoritative). The room stores the marks as written; it never guesses them.",
  items: object({ kind: { type: "string", enum: ["fact", "inference", "proposal"] },
    text: { ...text, maxLength: 2000 } }, ["kind", "text"]) };
const definitions = [
  ["submit_text_result", "Save room text as result", T.WORK_COMPLETED, "Submit one immutable work-linked Room message as your assigned result. Preview it with room_read_result first. Pins its post event, exact UTF-8 SHA-256 and previous completion (explicit null for first). Same completion/claim gates as external evidence. Posting, producer attribution, review and human approval remain separate.", {
    summary: text, nextAction: text, evidenceMessageId: id, evidenceMessageEventId: id,
    evidenceVersion: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    previousCompletionEventId: { ...id, type: ["string", "null"] }, producerId: { ...id, type: ["string", "null"] },
    externalProducer, attempt, segments: resultSegments,
    checksClaimed: { type: "array", maxItems: 64, items: { ...text, maxLength: 512 } }
  }, ["summary", "nextAction", "evidenceMessageId", "evidenceMessageEventId", "evidenceVersion", "previousCompletionEventId", "producerId"]],
  ["propose_work", "Propose work", T.WORK_PROPOSED, "Propose a new assigned task. Requires steer permission; ordinary enrolled agents do not receive it. This neither accepts nor starts work.", {
    title: text, definitionOfDone: text, accountableMemberId: id, dependsOn: { type: "array", maxItems: 16, items: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" }, description: "Existing same-room Board claim IDs, not message/session IDs. Every prerequisite must be done before claiming or starting. Read dependencies on room_read_work; acceptance rechecks existence." }, mode: { type: "string", enum: ["read", "write"] },
    independentVerificationRequired: bool, ownerDecisionRequired: bool, verifierMemberId: id, humanDecisionMakerId: id, sourceMessageId: id
  }, ["title", "definitionOfDone", "accountableMemberId", "mode", "independentVerificationRequired", "ownerDecisionRequired"]],
  ["accept_work", "Accept assignment", T.WORK_ACCEPTED, "Accept your assigned proposed task. Requires accept_work. Does not grant outside access or start a runtime.", {}],
  ["start_work", "Record work started", T.WORK_STARTED, "Record that you are starting your assigned task. Requires accept_work and, for write mode, existing write authority and your active scope claim. Does not run code or tools. Starting blocked work requires resolvedBlocker.", { resolvedBlocker: text }, []],
  ["block_work", "Report blocker", T.WORK_BLOCKED, "Report a blocker or reopen your completed task for rework. Requires assigned accept_work. Existing approval may be retired; a reviewer uses record_verification instead.", { reason: text, nextAction: text }],
  ["resolve_blocker", "Resolve blocker", T.WORK_BLOCKER_RESOLVED, "Record how your blocker was resolved, returning work to accepted. Requires assigned accept_work. Does not restart work or renew a claim.", { resolution: text }],
  ["record_completion", "Submit result", T.WORK_COMPLETED, "Record your assigned task's result and evidence reference. Requires complete_work; write mode also requires current write authority and your active claim. Producer attribution is an explicit assertion, never inferred. Evidence is not fetched. This is not verification or human approval.", {
    summary: text, evidenceUrl: { ...text, description: "HTTPS reference without embedded credentials; not fetched or independently verified by Room." }, evidenceVersion: text, nextAction: text,
    producerId: { ...id, type: ["string", "null"], description: "Explicit reported producer. Omit or use null when unknown; do not guess." },
    externalProducer, attempt, segments: resultSegments, signedEvidence: { type: "object", description: "Signed external evidence (room-signed-evidence/1) bound to the signer's room identity key. Required for external completions." },
    checksClaimed: { type: "array", maxItems: 64, items: { ...text, maxLength: 512 } }
  }, ["summary", "evidenceUrl", "evidenceVersion", "nextAction"]],
  ["record_verification", "Record evidence review", T.VERIFICATION_RECORDED, "Record your own check of the exact completion event and evidence version inspected. Requires designated verify authority; independent review cannot be by its producer. Historical findings do not approve newer evidence. Never substitute the latest receipt automatically.", {
    result: { type: "string", enum: ["pass", "fail"] }, completionEventId: id, evidenceVersion: text, summary: text, nextAction: text
  }, ["result", "completionEventId", "evidenceVersion", "summary"]],
  ["acquire_claim", "Reserve work scope", T.CLAIM_ACQUIRED, "Reserve a declared repository/ref/path scope for your assigned write-mode task and record the same claim on the work-claims board. Requires a contribute, review, or collaborate profile (or the room owner). write_external is not granted by the claim and is still required to finish write-mode work. Optional pullRequests are several GitHub pull links; the board settles only when every link is merged or closed. Optional blocks label a region of a path so two claims on one file can differ; a path with no label stays exclusive for the whole file.", {
    repository: text, ref: text, paths: { type: "array", minItems: 1, maxItems: 64, items: { ...text, maxLength: 512 } },
    expiresAt: { ...text, description: "Explicit ISO timestamp. The service checks that it is in the future; no automatic renewal." },
    pullRequests: { type: "array", maxItems: 16, items: { ...text, maxLength: 300 } },
    blocks: { type: "array", maxItems: 64, items: object({ path: { ...text, maxLength: 512 }, block: { ...text, maxLength: 80 }, region: { ...text, maxLength: 80 } }, ["path"]) }
  }, ["repository", "ref", "paths", "expiresAt"]],
  ["release_claim", "Release work scope", T.CLAIM_RELEASED, "Release an active claim you hold (or manage with manage_claims), including the matching work-claims board row. Does not stop an outside worker. A duplicate receipt does not describe the current reservation.", {}],
  ["renew_claim", "Renew work scope", T.CLAIM_RENEWED, "Extend the lease on an active claim you hold and on its work-claims board row. A heartbeat is enough: progressMessageId is optional evidence, not a required chat post. When present it must be your public message newer than the current lease start. Refused on leaseless claims and on lapsed leases (claim again instead).", {
    progressMessageId: { ...id, description: "Optional. Your public progress message in this room, posted after the current lease window began." },
    expiresAt: { ...text, description: "New explicit ISO expiry timestamp. The service checks that it is in the future." }
  }, ["expiresAt"]],
  ["supersede_work", "Replace work", T.WORK_SUPERSEDED, "Replace work with an already-existing work item. Requires steer, not granted by enrollment presets. Retires the original work's active reservation/approval; does not transfer them to its replacement. Also links the two cards on the work-claims board.", { supersededByWorkItemId: id, reason: text }],
  ["record_handoff", "Record handoff receipt", T.WORK_HANDOFF_RECORDED, "Record a handoff receipt when you cannot continue your assigned task: what is actually done against the done criteria, an optional partial-evidence reference, the exact next action, and why you are stopping. This never closes, completes or reassigns the work; the state and review gates stay with the room. The work-claims board gains a successor card that depends on this claim. haltAll=true also stops all your further work mutations until a steer/decide member clears the exact halt.", {
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

export const HANDOFF_ALIASES = Object.freeze({ done: "doneSummary", next: "nextAction", reason: "limitReason" });

const actions = new Map(definitions.map(([name, title, type, description, properties, required = Object.keys(properties)]) => {
  const fields = type === T.WORK_PROPOSED ? { requestId: common.requestId, workItemId: id } : type === T.WORK_HALT_CLEARED ? { requestId: common.requestId } : common;
  const aliases = name === "record_handoff" ? {
    done: { ...text, description: "Alias for doneSummary." },
    next: { ...text, description: "Alias for nextAction." },
    reason: { ...text, description: "Alias for limitReason." }
  } : {};
  const handoffCanonical = new Set(Object.values(HANDOFF_ALIASES));
  const requiredFields = [...new Set([...Object.keys(fields), ...required])]
    .filter(field => field !== "requestId" && (field !== "expectedRevision" || !Object.hasOwn(fields, "expectedRevision"))
      && (name !== "record_handoff" || !handoffCanonical.has(field)));
  return ["room_" + name, { type, tool: { name: "room_" + name, title, description: description + retry,
    inputSchema: object({ ...fields, ...aliases, ...properties }, requiredFields),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } } }];
}));
// Consolidated front door for the four legacy claim/handoff names. `room_claim`
// keeps the three operations exact: take delegates to acquire_claim, renew to
// renew_claim and release to release_claim. `room_handoff` delegates to the
// existing record_handoff command (a receipt back to the Board, never a
// transfer of authority). The old names stay callable for one compatibility
// window and report their successor in the response.
const acquire = actions.get("room_acquire_claim").tool.inputSchema.properties;
const renew = actions.get("room_renew_claim").tool.inputSchema.properties;
const claimTool = {
  name: "room_claim",
  title: "Claim, renew, or release work",
  description: "Claim work with one tool. action=take reserves a declared repository/ref/path scope for your assigned write-mode task (same rules and permissions as room_acquire_claim); action=renew extends the lease with a new explicit expiresAt (same rules as room_renew_claim); action=release gives the scope back (same rules as room_release_claim). Taking requires repository, ref, paths and expiresAt. Omit requestId and expectedRevision on the first call; retry the exact same input; a saved receipt does not prove current ownership." + retry,
  inputSchema: {
    ...object({
      requestId: common.requestId,
      workItemId: id,
      expectedRevision: common.expectedRevision,
      action: { type: "string", enum: ["take", "renew", "release"],
        description: "take=acquire with repository/ref/paths/expiresAt; renew=extend with expiresAt; release=give the scope back." },
      repository: acquire.repository,
      ref: acquire.ref,
      paths: acquire.paths,
      expiresAt: acquire.expiresAt,
      pullRequests: acquire.pullRequests,
      blocks: acquire.blocks,
      progressMessageId: renew.progressMessageId
    }, ["workItemId", "action"]),
    allOf: [
      { if: { properties: { action: { const: "take" } }, required: ["action"] },
        then: { required: ["repository", "ref", "paths", "expiresAt"] } },
      { if: { properties: { action: { const: "renew" } }, required: ["action"] },
        then: { required: ["expiresAt"] } }
    ]
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
};
const handoffTool = {
  ...actions.get("room_record_handoff").tool,
  name: "room_handoff",
  title: "Hand off work",
  description: "Hand assigned work back to the Board when you cannot finish it: state what is actually done against the definition of done, the exact next action, and why you are stopping. This records the handoff receipt and opens Board triage; it never closes, completes or reassigns the work, and review/approval gates stay with the room. Use haltAll=true only to stop all your further work mutations until a steer/decide member clears the exact halt." + retry
};
const canonicalActions = new Map([
  ["room_claim", { tool: claimTool, kind: "claim" }],
  ["room_handoff", { tool: handoffTool, to: "room_record_handoff" }]
]);
const claimDelegates = Object.freeze({
  take: "room_acquire_claim",
  renew: "room_renew_claim",
  release: "room_release_claim"
});
const DEPRECATED_WORK_TOOLS = Object.freeze({
  room_acquire_claim: { successor: "room_claim", action: "take" },
  room_renew_claim: { successor: "room_claim", action: "renew" },
  room_release_claim: { successor: "room_claim", action: "release" },
  room_record_handoff: { successor: "room_handoff", action: null }
});
export const workTools = [...actions.values()].map(action => action.tool).concat(claimTool, handoffTool);
export const isWorkTool = name => actions.has(name) || canonicalActions.has(name);

function validCanonicalWorkArguments(name, args) {
  const canonical = canonicalActions.get(name);
  if (!canonical || !conforms(args, canonical.tool.inputSchema)) return false;
  if (canonical.kind === "claim") {
    const { action, ...rest } = args;
    return Object.hasOwn(claimDelegates, action) && validWorkArguments(claimDelegates[action], rest);
  }
  return validWorkArguments(canonical.to, args);
}

export function normalizeHandoffArguments(name, args) {
  if (name === "room_handoff") return normalizeHandoffArguments("room_record_handoff", args);
  if (name !== "room_record_handoff" || !args || typeof args !== "object" || Array.isArray(args)) return { args };
  const value = { ...args };
  for (const [alias, canonical] of Object.entries(HANDOFF_ALIASES)) {
    if (!Object.hasOwn(value, alias)) continue;
    if (Object.hasOwn(value, canonical)) return { error: `${alias} and ${canonical} cannot both be supplied` };
    value[canonical] = value[alias];
    delete value[alias];
  }
  return { args: value };
}

export function workUsesExpectedRevision(name) {
  if (canonicalActions.has(name)) return true;
  return actions.get(name)?.tool.inputSchema.properties.expectedRevision !== undefined;
}

// Validator for this finite descriptor vocabulary, not a general JSON Schema engine.
export function conforms(value, shape) {
  if (value === null) return Array.isArray(shape.type) && shape.type.includes("null");
  const type = Array.isArray(shape.type) ? shape.type.find(type => type !== "null") : shape.type;
  if (type === "object") {
    if (typeof value !== "object" || Array.isArray(value)) return false;
    if (!shape.properties) return true;
    return Object.keys(value).every(key => Object.hasOwn(shape.properties, key))
      && shape.required.every(key => Object.hasOwn(value, key))
      && Object.entries(value).every(([key, value]) => conforms(value, shape.properties[key]));
  }
  if (type === "array") return Array.isArray(value) && value.length >= (shape.minItems ?? 0) && value.length <= shape.maxItems && Array.from(value).every(item => conforms(item, shape.items));
  if (type === "integer") return Number.isSafeInteger(value) && value >= shape.minimum && value <= shape.maximum;
  if (type === "boolean") return typeof value === "boolean";
  return typeof value === "string" && (!shape.enum || shape.enum.includes(value)) && value.length >= (shape.minLength ?? 0)
    && value.length <= (shape.maxLength ?? Infinity) && (!shape.pattern || new RegExp(shape.pattern).test(value));
}
export function validWorkArguments(name, args) {
  if (canonicalActions.has(name)) return validCanonicalWorkArguments(name, args);
  if (!actions.has(name)) return false;
  const normalized = normalizeHandoffArguments(name, args);
  if (normalized.error || !conforms(normalized.args, actions.get(name).tool.inputSchema)) return false;
  if (name === "room_record_handoff" && !["doneSummary", "nextAction", "limitReason"].every(key =>
    typeof normalized.args[key] === "string" && normalized.args[key].length > 0)) return false;
  try { if (actions.get(name).type === T.WORK_COMPLETED) reportedProducer(normalized.args); } catch { return false; }
  return true;
}
export function buildWorkCommand(name, args, identity = null, options = {}) {
  const { expectedRevision } = options;
  if (canonicalActions.has(name)) {
    if (!validCanonicalWorkArguments(name, args)) throw Object.assign(new Error("Invalid work action input"), { code: "invalid_work_action" });
    if (name === "room_handoff") return buildWorkCommand("room_record_handoff", args, identity, options);
    const { action, ...rest } = args;
    return buildWorkCommand(claimDelegates[action], rest, identity, options);
  }
  if (!actions.has(name)) throw Object.assign(new Error("Invalid work action input"), { code: "invalid_work_action" });
  const normalized = normalizeHandoffArguments(name, args);
  if (normalized.error) throw Object.assign(new Error(`Invalid work action input: ${normalized.error}`), { code: "invalid_work_action" });
  let prepared = withDerivedRequestId(name, normalized.args, identity);
  if (expectedRevision !== undefined && workUsesExpectedRevision(name) && prepared && typeof prepared === "object"
      && prepared.expectedRevision === undefined && Object.hasOwn(prepared, "workItemId")) {
    prepared = { ...prepared, expectedRevision };
  }
  if (prepared && !validId(prepared.requestId))
    throw Object.assign(new Error(`${name} requires requestId: supply one stable id per operation, or use an MCP connection that can derive and return one`), { code: "missing_request_id" });
  if (!validWorkArguments(name, prepared)) throw Object.assign(new Error("Invalid work action input"), { code: "invalid_work_action" });
  const requestId = prepared.requestId;
  const { requestId: _requestId, ...data } = structuredClone(prepared), command = { id: requestId, type: actions.get(name).type, data };
  if (name === "room_submit_text_result") data.evidenceKind = "room_text";
  if (Buffer.byteLength(JSON.stringify(command)) > 16384) throw Object.assign(new Error("Work action exceeds the command limit"), { code: "work_action_too_large" });
  return command;
}
export function confirmsAgentCommand(receipt, command, { roomId, memberId }) {
  const entry = receipt?.event;
  let data = command.data;
  try {
    const mode = command.type === T.MESSAGE_POSTED ? replyPostMode(data) : null;
    if (mode) data = { ...data, requestPolicyVersion: REPLY_POLICY_VERSION };
    // The server stamps which credential answered; it is never in the command.
    if (mode === "respond" && ANSWER_CREDENTIALS.includes(entry?.data?.answerCredential)) data = { ...data, answerCredential: entry.data.answerCredential };
  } catch { return false; }
  return Number.isSafeInteger(receipt?.sequence) && receipt.sequence > 0 && typeof receipt.duplicate === "boolean"
    && validId(entry?.id) && entry.type === command.type && entry.roomId === roomId && entry.actorId === memberId
    && entry.idempotencyKey === createHash("sha256").update(`${memberId}:${command.id}`).digest("hex")
    && entry.causationId === (command.causationId ?? null) && typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at))
    && isDeepStrictEqual(entry.data, data);
}
export function recordedWorkAction(name, command, receipt) {
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
export function withWorkDeprecation(name, recorded) {
  const deprecated = DEPRECATED_WORK_TOOLS[name];
  return deprecated ? { ...recorded, deprecated: { successor: deprecated.successor, action: deprecated.action,
    message: deprecated.action
      ? `Use ${deprecated.successor} with action="${deprecated.action}".`
      : `Use ${deprecated.successor}.` }, successor: deprecated.successor } : recorded;
}
export async function submitWorkAction(client, identity, name, args, { signal } = {}) {
  if (!validId(identity?.roomId) || !validId(identity?.memberId)) throw new Error("Pinned agent identity required");
  let expectedRevision;
  if (workUsesExpectedRevision(name) && args && typeof args === "object" && !Array.isArray(args)
      && args.expectedRevision === undefined && validId(args.workItemId)) {
    const context = await client.workContext(args.workItemId, { signal });
    if (!Number.isSafeInteger(context?.work?.revision)) throw Object.assign(new Error("Current work revision unavailable"), { code: "invalid_work_action" });
    expectedRevision = context.work.revision;
  }
  const command = buildWorkCommand(name, args, identity, { expectedRevision }), receipt = await client.command(command, { signal });
  if (!confirmsAgentCommand(receipt, command, identity)) return { status: "unconfirmed", requestId: command.id,
    message: "Outcome unknown. Retain and retry the exact original input; do not create a replacement requestId." };
  return withWorkDeprecation(name, recordedWorkAction(name, command, receipt));
}

const refusals = {
  idempotency_conflict: "This requestId belongs to different input. Recover the original instead of replacing its ID blindly.",
  claim_conflict: "Another work item reserves overlapping scope. Read the room's work and coordinate release; do not start the conflicting work.",
  invalid_claim_scope: "Use explicit repository/ref and relative paths, folder/**, or **. Review the scope before a new deliberate attempt.",
  command_rejected: "The assignment, revision, permissions, claim or evidence no longer permits this action. Read current work; never silently rebase an approval or review.",
  missing_signed_evidence: "Unsigned external evidence is rejected. Post the result as a room message linked to the work, then complete with evidenceKind room_text (room_submit_text_result): evidenceMessageId, evidenceMessageEventId, previousCompletionEventId, producerId, and evidenceVersion sha256 of that exact body. Omit evidenceUrl. External HTTPS still requires signedEvidence.",
  invalid_cause: "The referenced causal event is unavailable in this room. Review the original input.",
  pilot_limit: "Room capacity was reached. Ask the owner to review capacity; do not replace the original operation blindly."
};
export function workActionRefusal(cause, { workItemId } = {}) {
  const ax = agentErrorAx({ httpStatus: cause?.status ?? 0, code: cause?.code, message: cause?.message, workItemId });
  if (["invalid_work_action", "work_action_too_large", "missing_request_id"].includes(cause?.code)) return { type: "work_input_refused", code: cause.code,
    outcome: "this_attempt_not_sent", message: "Input was not sent. Use the listed fields and reduce text/checks to fit the command limit. If this ID had an earlier uncertain attempt, reconcile its original input before changing it.",
    status: ax.status, reason: ax.reason, hint: ax.hint, next: ax.next };
  if (![409, 422].includes(cause?.status) || !Object.hasOwn(refusals, cause.code)) return null;
  return { type: "work_refused", code: cause.code, outcome: "this_attempt_refused", message: refusals[cause.code],
    status: ax.status, reason: ax.reason, hint: ax.hint, next: ax.next };
}
