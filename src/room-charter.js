// Shared context, never an authorization policy or an execution request.
export const CHARTER_TYPE = "room.charter_updated";
export const CHARTER_FIELDS = Object.freeze({ purpose: "Purpose", outputs: "Expected output", boundaries: "Boundaries", escalation: "When to ask for help" });
export const CHARTER_LIMIT = 1000;
const keys = Object.keys(CHARTER_FIELDS);
const id = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) && !["constructor", "prototype", "__proto__"].includes(value);
const canonical = value => value && typeof value === "object" ? JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))) : JSON.stringify(value);
const check = (condition, message = "Invalid room instructions") => { if (!condition) throw new Error(message); };

export function validateCharterData(data) {
  check(data && typeof data === "object" && !Array.isArray(data)
    && Object.keys(data).length === keys.length + 1 && Object.keys(data).every(key => [...keys, "expectedRevision"].includes(key)));
  check(Number.isSafeInteger(data.expectedRevision) && data.expectedRevision >= 0 && data.expectedRevision < Number.MAX_SAFE_INTEGER);
  for (const key of keys) check(data[key] === null || typeof data[key] === "string" && data[key].length <= CHARTER_LIMIT && data[key].trim().length > 0 && data[key].isWellFormed());
  check(data.purpose !== null || keys.every(key => data[key] === null), "Add a purpose, or clear every field");
  return data;
}

export function charterFromEvent(incoming, prior = null) {
  validateCharterData(incoming.data);
  check(incoming.type === CHARTER_TYPE && id(incoming.id) && id(incoming.actorId)
    && typeof incoming.at === "string" && Number.isFinite(Date.parse(incoming.at)));
  check(incoming.data.expectedRevision === (prior?.revision ?? 0), "Stale room instructions revision");
  return { revision: incoming.data.expectedRevision + 1, eventId: incoming.id, updatedById: incoming.actorId, updatedAt: incoming.at,
    ...Object.fromEntries(keys.map(key => [key, incoming.data[key]])) };
}

export function validateCharter(charter) {
  if (charter === null) return null;
  check(charter && typeof charter === "object" && !Array.isArray(charter)
    && Object.keys(charter).sort().join(" ") === [...keys, "revision", "eventId", "updatedById", "updatedAt"].sort().join(" "));
  const data = { expectedRevision: charter.revision - 1, ...Object.fromEntries(keys.map(key => [key, charter[key]])) };
  const recreated = charterFromEvent({ type: CHARTER_TYPE, id: charter.eventId, actorId: charter.updatedById, at: charter.updatedAt, data }, { revision: data.expectedRevision });
  check(canonical(recreated) === canonical(charter));
  return recreated;
}

export function charterContext(room) {
  // Undefined remains an absent projection for legacy replay, not a backfill.
  const charter = validateCharter(room?.charter ?? null);
  return { authority: "context_only", revision: charter?.revision ?? 0, eventId: charter?.eventId ?? null, charter };
}

export function validateCharterContext(value) {
  check(value && Object.keys(value).sort().join(" ") === "authority charter eventId revision" && value.authority === "context_only" && value.charter !== undefined);
  const checked = charterContext({ charter: value.charter });
  check(value.revision === checked.revision && value.eventId === checked.eventId);
  return checked;
}

export function validateCharterRead(value, roomId, revision) {
  check(value?.contractVersion === 1 && value.roomId === roomId && Number.isSafeInteger(value.evaluatedThrough) && value.evaluatedThrough >= 0
    && Number.isSafeInteger(value.currentRevision) && value.currentRevision >= 0 && value.currentRevision <= value.evaluatedThrough
    && (value.currentRevision === 0 ? value.currentEventId === null : id(value.currentEventId)));
  validateCharterContext({ authority: value.authority, revision: value.revision, eventId: value.eventId, charter: value.charter });
  check(value.revision <= value.currentRevision && (revision === undefined ? value.revision === value.currentRevision : value.revision === revision)
    && (value.revision !== value.currentRevision || value.eventId === value.currentEventId));
  return value;
}

export async function confirmsCharter(receipt, command, roomId, actorId) {
  const e = receipt?.event;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${actorId}:${command.id}`));
  const commandKey = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return Number.isSafeInteger(receipt?.sequence) && receipt.sequence > 0 && typeof receipt.duplicate === "boolean"
    && id(e?.id) && id(e?.idempotencyKey) && e.type === CHARTER_TYPE && e.roomId === roomId && e.actorId === actorId
    && e.idempotencyKey === commandKey
    && typeof e.at === "string" && Number.isFinite(Date.parse(e.at)) && (e.causationId ?? null) === (command.causationId ?? null)
    && canonical(e.data) === canonical(command.data);
}

// Check the entire retained history, including domain state hidden by an old
// checkpoint. Do not replay unrelated legacy work under today's work rules.
export function auditCharters(state, history, checkpoint = null) {
  let current = null, atCheckpoint = null, ownerId = null, owner = null;
  for (const row of history) {
    const e = typeof row.body === "string" ? JSON.parse(row.body) : row.event;
    if (e.type === "room.created") {
      check(ownerId === null && id(e.data.ownerId) && e.actorId === e.data.ownerId && e.roomId === state.room.id && e.data.roomId === e.roomId);
      ownerId = e.data.ownerId;
    }
    if (e.type === "member.added" && e.data.memberId === ownerId) {
      check(owner === null && e.actorId === ownerId && e.data.kind === "human" && e.roomId === state.room.id);
      owner = { kind: e.data.kind, active: true };
    }
    if (e.type === "member.access_changed" && e.data.memberId === ownerId) { check(owner && typeof e.data.active === "boolean"); owner.active = e.data.active; }
    if (e.type === CHARTER_TYPE) {
      check(e.roomId === state.room.id && e.actorId === ownerId && owner?.kind === "human" && owner.active === true, "Invalid room instructions author");
      current = charterFromEvent(e, current);
    }
    if (checkpoint && row.sequence <= checkpoint.sequence) atCheckpoint = current;
  }
  check(ownerId === state.room.ownerId && canonical(state.room.charter ?? null) === canonical(current), "Room instructions require reconciliation");
  if (checkpoint) check(canonical(JSON.parse(checkpoint.projection).room?.charter ?? null) === canonical(atCheckpoint), "Checkpoint instructions require reconciliation");
  return current;
}
