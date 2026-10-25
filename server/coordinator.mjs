// One optional coordinator per room. The owner names them with the existing
// assistant configure action (coordinatorMemberId). That agent may assign an
// open claim or ask another agent for help. Stop, by the coordinator or a
// room administrator, halts asks that have not been applied.
//
// room-assistant.mjs is left unchanged: open pulls already edit it. This
// module wraps RoomAssistant.apply when the server graph loads it.
import { canAdministerRoom } from "../src/room-administration.js";
import { ownMember, validId } from "../src/events.js";
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";
import { fileLeaseConflictBody, fileLeaseConflicts } from "./claim-coordination.mjs";
import { RoomAssistant } from "./room-assistant.mjs";
import { emitWorkClaimEvent, enqueueClaimWake } from "./work-claim-events.mjs";
import { ACTIVE_CLAIM_STATES, isTerminalClaimState, reassignWork } from "./work-claims.mjs";

export const COORDINATOR_MAX_HOPS = 4;
export const COORDINATOR_ACTIONS_PER_HOUR = 30;
const HOUR_MS = 3_600_000;
const MAX_STORED_ACTIONS = 100;
const ASSIGN_NOTE_MAX = 4000;
const ASK_NOTE_MAX = 500;
const CLAIM_ID_MAX = 256;

const fail = (code, message, status = 409) => { throw Object.assign(new Error(message), { code, status }); };
let installed = false;

export function installCoordinator() {
  if (installed) return;
  installed = true;
  const original = RoomAssistant.prototype.apply;
  RoomAssistant.prototype.apply = function applyWithCoordinator(roomId, input, authorize, postToken = null) {
    const action = input && !Array.isArray(input) ? input.action : undefined;
    if (action === "assign" || action === "ask" || action === "stop") return perform(this, roomId, input, authorize);
    if (action !== "configure") return original.call(this, roomId, input, authorize, postToken);
    return preserveOnConfigure(this, original, roomId, input, authorize, postToken);
  };
}

function preserveOnConfigure(assistant, original, roomId, input, authorize, postToken) {
  const before = readConfig(assistant, roomId);
  const response = original.call(assistant, roomId, input, authorize, postToken);
  const actions = Array.isArray(before.coordinatorActions) ? before.coordinatorActions : [];
  if (!actions.length) return response;
  const after = readConfig(assistant, roomId);
  // A retry of this configure replays the stored receipt and does not wipe
  // the row. A fresh configure replaces the row; put the action log back
  // without the stop latch. A different coordinator halts asks still pending.
  if (Array.isArray(after.coordinatorActions)) return response;
  const memberChanged = before.coordinatorMemberId !== after.coordinatorMemberId;
  const now = assistant.store.now();
  const kept = memberChanged
    ? actions.map(entry => entry?.status === "pending" ? { ...entry, status: "halted", haltedAt: now } : entry)
    : actions;
  writeConfig(assistant, roomId, { ...after, coordinatorActions: kept, stoppedAt: undefined });
  return response;
}

function perform(assistant, roomId, input, authorize) {
  assertEnvelope(input);
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right))));
  return assistant.store.transaction(() => {
    assistant.init();
    const auth = authorize();
    const state = assistant.store.room(roomId).state;
    const actor = auth.member;
    if (typeof actor?.id === "string" && actor.id.startsWith("guest-agent-") || actor?.permissions?.some(permission => permission.startsWith("guest:")))
      fail("assistant_denied", "Guests cannot coordinate shared work", 403);
    if (state.room.archivedAt) fail("assistant_archived", "This room is archived");
    const config = assistant.config(roomId);
    const isAdmin = canAdministerRoom(state, actor.id) && actor.permissions?.includes("manage_members");
    if (input.action === "stop") {
      if (!isAdmin && actor.id !== config.coordinatorMemberId)
        fail("assistant_denied", "Only the room coordinator or a room administrator can stop coordinator actions.", 403);
    } else {
      const coordinator = ownMember(state.members, config.coordinatorMemberId);
      const connected = Boolean(coordinator?.active && coordinator.kind === "agent" && coordinator.permissions?.includes("accept_work"));
      if (!connected) fail("assistant_not_connected", "Name an active room agent as coordinator before assigning or asking.", 409);
      if (actor.id !== config.coordinatorMemberId)
        fail("assistant_denied", "Only the room coordinator can assign or ask. Read the assistant to see who it is.", 403);
      enforceAutonomyTierForAction({ db: assistant.store.db, roomId, state, actor, action: input.action === "assign" ? "assign work" : "ask another agent for help" });
    }
    const prior = assistant.store.db.prepare("SELECT input,result FROM room_assistant_ops WHERE room_id=? AND actor_id=? AND request_id=?").get(roomId, actor.id, input.requestId);
    if (prior) {
      if (prior.input !== canonical) fail("assistant_retry_conflict", "Retry ID already records different input");
      return JSON.parse(prior.result);
    }
    if (input.action !== "stop") {
      if (Number.isFinite(config.stoppedAt))
        fail("assistant_host_paused", "This coordinator is stopped. The room owner configures the assistant to clear the stop.", 409);
      if (assistant.store.wakeQueue?.pauseStatus?.(roomId, config.coordinatorMemberId))
        fail("assistant_host_paused", "This coordinator is paused", 409);
    }
    const now = assistant.store.now();
    const actions = Array.isArray(config.coordinatorActions) ? config.coordinatorActions : [];
    let result;
    if (input.action === "stop") result = stopActions(assistant, roomId, config, actions, actor, now);
    else result = input.action === "assign"
      ? assignClaim(assistant, roomId, state, config, actions, input, actor, now)
      : askAgent(assistant, roomId, state, config, actions, input, actor, now);
    const response = { contractVersion: 1, roomId, action: input.action, result };
    assistant.store.db.prepare("INSERT INTO room_assistant_ops VALUES(?,?,?,?,?)").run(roomId, actor.id, input.requestId, canonical, JSON.stringify(response));
    recordAudit(assistant, roomId, actor.id, now, input.action, result, input.requestId);
    return response;
  });
}

function assertEnvelope(input) {
  const fields = {
    assign: ["workClaimId", "targetMemberId", "expectedClaimedAt", "expectedHistoryLength", "note"],
    ask: ["workClaimId", "targetMemberId", "note"],
    stop: []
  };
  if (!input || Array.isArray(input) || !Object.hasOwn(fields, input.action) || !validId(input.requestId)
    || Object.keys(input).some(key => !["action", "requestId", ...fields[input.action]].includes(key)))
    fail("invalid_assistant_action", "Choose an assistant action and stable request ID", 422);
}

function assignClaim(assistant, roomId, state, config, actions, input, actor, now) {
  const workClaimId = claimId(input.workClaimId);
  const targetMemberId = memberId(input.targetMemberId, "Choose an active member who can take the work.");
  const note = noteOf(input.note, ASSIGN_NOTE_MAX);
  roundOf(input);
  const hop = reserveHop(actions, workClaimId, now);
  const registry = assistant.store.workClaims;
  const item = registry.get(roomId, workClaimId);
  if (!item) fail("work_claim_not_found", `No work claim "${workClaimId}" in this room`, 404);
  if (item.state !== "unclaimed") {
    fail("work_claim_conflict", `Work "${item.id}" is held by ${item.owner ?? "nobody"} — ask them to reassign or release it`, 409);
  }
  const dependencies = item.dependsOn ?? [];
  if (dependencies.length) {
    const board = registry.list(roomId);
    const done = new Set(board.filter(entry => entry && !entry.premiseFlag && !entry.supersededBy && entry.state === "done").map(entry => entry.id));
    const unmet = dependencies.filter(id => !done.has(id));
    if (unmet.length) {
      const stateOf = id => board.find(entry => entry?.id === id)?.state ?? "missing";
      fail("work_claim_dependencies_unmet",
        `Work "${item.id}" cannot be claimed yet — dependencies not done: ${unmet.map(id => `"${id}" (${stateOf(id)})`).join(", ")}. Finish those first, or ask the coordinator to reassign the dependency.`,
        409);
    }
  }
  const target = ownMember(state.members, targetMemberId);
  const canTake = Boolean(target?.active && (target.permissions?.includes("accept_work") || target.permissions?.includes("complete_work") || targetMemberId === state.room?.ownerId));
  if (!canTake) fail("invalid_assistant_action", "Choose an active member who can take the work.", 422);
  const roomConfig = registry.configFor(roomId);
  const held = registry.list(roomId).filter(entry => entry.owner === targetMemberId && ACTIVE_CLAIM_STATES.includes(entry.state)).length;
  if (held >= roomConfig.maxMemberOpenClaims) {
    fail("too_many_open_claims",
      `${targetMemberId} already holds ${roomConfig.maxMemberOpenClaims} open claims. Release or finish one before assigning another.`,
      409);
  }
  let reassigned;
  try {
    reassigned = reassignWork(item, actor.id, targetMemberId, {
      expectedClaimedAt: input.expectedClaimedAt,
      expectedHistoryLength: input.expectedHistoryLength,
      note, now, authority: true,
      room: { workClaims: registry.rawConfig(roomId) }
    });
  } catch (error) {
    if (error?.name === "ClaimError" && error.code === "work_claim_conflict")
      fail("work_claim_conflict", `${error.message} — re-read the claim and retry with the current round.`, 409);
    if (error?.name === "ClaimError") fail(error.code, error.message, 422);
    throw error;
  }
  const conflicts = fileLeaseConflicts(registry.list(roomId), reassigned);
  if (conflicts.length) fail("file_lease_conflict", fileLeaseConflictBody(reassigned, conflicts).error.message, 409);
  registry.set(roomId, reassigned);
  const receipt = emitWorkClaimEvent(assistant.store, roomId, {
    actorId: actor.id, item: reassigned, action: "reassigned", previousOwnerId: item.owner,
    atMs: now, attention: "assigned", attentionMemberId: targetMemberId
  });
  enqueueClaimWake(assistant.store, roomId, targetMemberId, `work-claim:${reassigned.id}:assigned:${receipt?.sequence ?? now}`,
    { reason: "assigned", actorId: actor.id });
  remember(assistant, roomId, config, actions, {
    id: input.requestId, kind: "assign", actorId: actor.id, workClaimId, targetMemberId,
    ...(note !== undefined ? { note } : {}), status: "applied", hop, createdAt: now
  });
  return {
    workClaimId, targetMemberId, status: "applied", hop,
    claim: { id: reassigned.id, state: reassigned.state, owner: reassigned.owner }
  };
}

function askAgent(assistant, roomId, state, config, actions, input, actor, now) {
  const workClaimId = claimId(input.workClaimId);
  const targetMemberId = memberId(input.targetMemberId, "Choose a different active agent with accept work.");
  const note = noteOf(input.note, ASK_NOTE_MAX);
  if (targetMemberId === actor.id) fail("assistant_denied", "Ask a different agent. The coordinator cannot ask itself.", 403);
  const hop = reserveHop(actions, workClaimId, now);
  const item = assistant.store.workClaims.get(roomId, workClaimId);
  if (!item) fail("work_claim_not_found", `No work claim "${workClaimId}" in this room`, 404);
  if (isTerminalClaimState(item.state))
    fail("work_claim_conflict", `Work "${item.id}" is ${item.state} and cannot be asked. Choose an open claim.`, 409);
  const target = ownMember(state.members, targetMemberId);
  if (!target?.active || target.kind !== "agent" || !target.permissions?.includes("accept_work"))
    fail("invalid_assistant_action", "Choose a different active agent with accept work.", 422);
  remember(assistant, roomId, config, actions, {
    id: input.requestId, kind: "ask", actorId: actor.id, workClaimId, targetMemberId,
    ...(note !== undefined ? { note } : {}), status: "pending", hop, createdAt: now
  });
  return { workClaimId, targetMemberId, status: "pending", hop };
}

function stopActions(assistant, roomId, config, actions, actor, now) {
  let halted = 0;
  const next = actions.map(entry => {
    if (entry?.status !== "pending") return entry;
    halted += 1;
    return { ...entry, status: "halted", haltedAt: now };
  });
  writeConfig(assistant, roomId, { ...config, coordinatorActions: next, stoppedAt: now });
  return { stoppedAt: now, halted, stoppedBy: actor.id };
}

function reserveHop(actions, workClaimId, now) {
  const onClaim = actions.filter(entry => entry && (entry.kind === "assign" || entry.kind === "ask") && entry.workClaimId === workClaimId);
  if (onClaim.length >= COORDINATOR_MAX_HOPS)
    fail("assistant_loop_cap", `This claim has used ${COORDINATOR_MAX_HOPS} coordinator hops. Stop the chain or choose another claim.`, 409);
  const recent = actions.filter(entry => entry && (entry.kind === "assign" || entry.kind === "ask") && Number.isFinite(entry.createdAt) && now - entry.createdAt < HOUR_MS);
  if (recent.length >= COORDINATOR_ACTIONS_PER_HOUR) {
    const oldest = recent.reduce((min, entry) => Math.min(min, entry.createdAt), now);
    fail("assistant_loop_cap", `The coordinator has used ${COORDINATOR_ACTIONS_PER_HOUR} assign or ask actions this hour. Wait until an hour after ${new Date(oldest).toISOString()} before another one.`, 409);
  }
  return onClaim.length + 1;
}

function remember(assistant, roomId, config, actions, entry) {
  writeConfig(assistant, roomId, { ...config, coordinatorActions: [...actions, entry].slice(-MAX_STORED_ACTIONS) });
}

function readConfig(assistant, roomId) {
  try { return assistant.config(roomId); }
  catch { return { name: "Room", coordinatorMemberId: null, revision: 0 }; }
}

function writeConfig(assistant, roomId, config) {
  const stored = {
    name: config.name,
    coordinatorMemberId: config.coordinatorMemberId,
    revision: config.revision
  };
  if (Array.isArray(config.coordinatorActions) && config.coordinatorActions.length) stored.coordinatorActions = config.coordinatorActions;
  if (Number.isFinite(config.stoppedAt)) stored.stoppedAt = config.stoppedAt;
  assistant.store.db.prepare("INSERT INTO room_assistant_config VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET value=excluded.value")
    .run(roomId, JSON.stringify(stored));
}

function claimId(value) {
  if (typeof value !== "string" || !value.isWellFormed() || value.length < 1 || value.length > CLAIM_ID_MAX || /[\u0000-\u001f\u007f]/.test(value))
    fail("invalid_assistant_action", "Choose a work claim id", 422);
  return value;
}

function memberId(value, message) {
  if (!validId(value)) fail("invalid_assistant_action", message, 422);
  return value;
}

function noteOf(value, max) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.isWellFormed() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    || /\bpri_[A-Za-z0-9_-]+|\bBearer\s+\S+/i.test(value))
    fail("invalid_assistant_action", `Note must be well-formed text of at most ${max} characters`, 422);
  return value;
}

function roundOf(input) {
  if (!Object.hasOwn(input, "expectedClaimedAt") || !Object.hasOwn(input, "expectedHistoryLength"))
    fail("invalid_assistant_action", "Send the claim round you read: expectedClaimedAt and expectedHistoryLength.", 422);
  const at = input.expectedClaimedAt;
  if (at !== null && (typeof at !== "string" || at.length > 100 || !Number.isFinite(Date.parse(at))))
    fail("invalid_assistant_action", "expectedClaimedAt must be the current claim time or null for an unclaimed item.", 422);
  if (!Number.isSafeInteger(input.expectedHistoryLength) || input.expectedHistoryLength < 0)
    fail("invalid_assistant_action", "expectedHistoryLength must be a non-negative integer.", 422);
}

// The per-agent audit table belongs to a later change. When it is already
// present and every extra column has a default, record one row. Detail is
// the action outcome only: no note text and no credentials.
function recordAudit(assistant, roomId, memberId, at, kind, result, requestId) {
  const columns = assistant.store.db.prepare("PRAGMA table_info(agent_audit_log)").all();
  if (!columns.length) return;
  const names = new Set(columns.map(column => column.name));
  for (const required of ["room_id", "member_id", "at", "action", "detail"]) if (!names.has(required)) return;
  const supplied = new Set(["room_id", "member_id", "at", "action", "detail"]);
  if (columns.some(column => column.notnull && column.dflt_value == null && !supplied.has(column.name))) return;
  const detail = {
    kind,
    ...(result.workClaimId ? { workClaimId: result.workClaimId } : {}),
    ...(result.targetMemberId ? { targetMemberId: result.targetMemberId } : {}),
    status: result.status ?? "halted",
    ...(Number.isSafeInteger(result.hop) ? { hop: result.hop } : {}),
    requestId
  };
  assistant.store.db.prepare("INSERT INTO agent_audit_log (room_id, member_id, at, action, detail) VALUES (?,?,?,?,?)")
    .run(roomId, memberId, at, `coordinator_${kind}`, JSON.stringify(detail));
}

installCoordinator();
