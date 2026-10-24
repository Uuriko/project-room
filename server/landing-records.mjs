// Landing records: the room-native Record primitive (RECORD-PRIM).
//
// Spec: ~/workspace/migration-2026-10-21/mig-primitives.md, Primitive 3. A
// record is the landing gate as one typed room object:
//
//   Record { id, pr, headSha, baseSha, state, evidence[], flags[],
//            acceptingAuthority, createdBySeat, createdAt, landedAt?,
//            mergedSha?, treeSha? }   (+ a free-text note)
//
// LAND-READY is the creation state; LAND_RECORD is the `landed` transition
// carrying mergedSha/treeSha — the two prose message formats the fleet used
// to embed in room messages (and an external watcher parsed back out)
// collapse into one object with a lifecycle:
// state ∈ land-ready | landed | revoked | superseded.
//
// evidence[] replaces evidence prose with typed links: { kind, ref, label?,
// headSha? } with kind ∈ suite | ci | verdict | link. A `verdict` entry's
// ref is a Verdict object id (Primitive 6) stored as an opaque typed
// reference — never resolved here, so a record can cite a verdict before
// the Verdict object exists in the room and the citation cannot dangle.
//
// flags[] carries ruling-27-style priced flags as data: { flag,
// acceptingAuthority }. A record whose aggregate is not clean success
// cannot be created without naming its accepting authority — the rule the
// emit tool used to enforce, moved into the object: any flag present
// requires the record's acceptingAuthority, and each flag names its own
// (defaulting to the record's).
//
// Head-binding is structural, not polled prose. A land-ready record reads
// superseded — persisted lazily by every operation, sweep first, then act —
// when any of three in-room facts says its head moved:
//   1. the room's land queue (server/land-queue.mjs, refreshed from GitHub
//      on the scheduled tick) has observed a different head for the PR;
//   2. a replacement record for the same PR is created at a different head
//      (the fleet's RECORD-MOVED practice), which supersedes the prior
//      record in the same transaction and links both ways;
//   3. a member with landing authority calls the supersede verb naming the
//      new head (out-of-band detection, e.g. the landing-watch cron).
// Where none of these facts exists, no supersession is fabricated.
//
// Landing authority (land / revoke / supersede): the record's creator, the
// room owner, or a member holding the `decide` permission.
//
// No new identities and no new task engine (programme law): records bind
// to existing room members and cite existing work by reference only. A
// record schedules nothing and lands nothing — the seat lands against it.

import { randomUUID } from "node:crypto";
import { ServiceError } from "./service-error.mjs";
import { memberCan } from "../src/events.js";

export const LANDING_RECORD_STATES = Object.freeze(["land-ready", "landed", "revoked", "superseded"]);
export const EVIDENCE_KINDS = Object.freeze(["suite", "ci", "verdict", "link"]);
const MAX_EVIDENCE = 50;
const MAX_FLAGS = 50;
const MAX_HISTORY = 50;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

export class LandingRecordError extends ServiceError {
  constructor(status, code, message, detail = null) {
    super(status, code, message);
    if (detail) this.detail = detail;
  }
}

const invalid = message => new LandingRecordError(422, "invalid_landing_record", message);
const notFound = recordId => new LandingRecordError(404, "landing_record_not_found", `No landing record "${recordId}" in this room`);
const closed = record => new LandingRecordError(409, "landing_record_closed", `Landing record ${record.id} is ${record.state} and cannot change state`);

const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const cleanText = (value, label, max) => {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw invalid(`${label} must be a trimmed string of 1 to ${max} characters, without control characters`);
  }
  return value;
};
const shaOf = (value, label) => {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) throw invalid(`${label} must be a full 40-character lowercase hex SHA`);
  return value;
};

function prOf(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000_000) throw invalid("pr must be an integer from 1 to 100000000");
  return value;
}

function normalizeEvidence(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) throw invalid(`evidence must be an array of at most ${MAX_EVIDENCE} typed links`);
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw invalid(`evidence[${index}] must be an object`);
    for (const key of Object.keys(entry)) {
      if (!["kind", "ref", "label", "headSha"].includes(key)) throw invalid(`Unknown evidence field "${key}"`);
    }
    if (!EVIDENCE_KINDS.includes(entry.kind)) throw invalid(`evidence[${index}].kind must be one of: ${EVIDENCE_KINDS.join(", ")}`);
    const out = { kind: entry.kind, ref: cleanText(entry.ref, `evidence[${index}].ref`, 500) };
    if (entry.label !== undefined) out.label = cleanText(entry.label, `evidence[${index}].label`, 200);
    if (entry.headSha !== undefined) out.headSha = shaOf(entry.headSha, `evidence[${index}].headSha`);
    return out;
  });
}

function normalizeFlags(value, recordAuthority) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FLAGS) throw invalid(`flags must be an array of at most ${MAX_FLAGS} priced flags`);
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) throw invalid(`flags[${index}] must be an object`);
    for (const key of Object.keys(entry)) {
      if (!["flag", "acceptingAuthority"].includes(key)) throw invalid(`Unknown flag field "${key}"`);
    }
    const flag = cleanText(entry.flag, `flags[${index}].flag`, 500);
    const authority = entry.acceptingAuthority === undefined ? recordAuthority : cleanText(entry.acceptingAuthority, `flags[${index}].acceptingAuthority`, 200);
    if (!authority) throw invalid(`flags[${index}] names no acceptingAuthority and the record names none either`);
    return { flag, acceptingAuthority: authority };
  });
}

const iso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

export function serializeLandingRecord(record) {
  return {
    id: record.id,
    pr: record.pr,
    headSha: record.headSha,
    baseSha: record.baseSha,
    state: record.state,
    evidence: record.evidence ?? [],
    flags: record.flags ?? [],
    acceptingAuthority: record.acceptingAuthority ?? null,
    note: record.note ?? null,
    createdBySeat: { memberId: record.createdByMemberId, displayName: record.createdByDisplayName ?? null, kind: record.createdByKind ?? null },
    createdAt: iso(record.createdAt),
    landedAt: iso(record.landedAt),
    landedBy: record.landedByMemberId ?? null,
    mergedSha: record.mergedSha ?? null,
    treeSha: record.treeSha ?? null,
    revokedAt: iso(record.revokedAt),
    revokeReason: record.revokeReason ?? null,
    supersededBy: record.supersededBy ?? null,
    supersededByHeadSha: record.supersededByHeadSha ?? null,
    supersedes: record.supersedes ?? [],
    history: (record.history ?? []).map(entry => ({ ...entry, at: iso(entry.at) })),
  };
}

// Ops environment: { registry, member(roomId, memberId) -> {id,
// displayName, kind, active}|null, canDecide(roomId, memberId) -> bool,
// observedHead(roomId, pr) -> sha|null, now() -> ms }.
function sweepMoved(env, roomId, records) {
  for (const record of records) {
    if (record.state !== "land-ready") continue;
    const observed = env.observedHead(roomId, record.pr);
    if (observed && observed !== record.headSha) {
      record.state = "superseded";
      record.supersededByHeadSha = observed;
      record.history = [...(record.history ?? []), { at: env.now(), action: "superseded", by: null, via: "land-queue", headSha: observed }].slice(-MAX_HISTORY);
      env.registry.set(roomId, record);
    }
  }
}

function loadRoom(env, roomId) {
  const records = env.registry.list(roomId);
  sweepMoved(env, roomId, records);
  return records;
}

function requireMember(env, roomId, memberId) {
  const member = env.member(roomId, memberId);
  if (!member || member.active === false) {
    throw new LandingRecordError(403, "not_member", `Member "${memberId}" is not a member of room "${roomId}"`);
  }
  return member;
}

function requireAuthority(env, roomId, actorMemberId, record) {
  if (record.createdByMemberId === actorMemberId) return;
  if (env.canDecide(roomId, actorMemberId)) return;
  throw new LandingRecordError(403, "landing_record_not_authority",
    "Only the record's creator, the room owner, or a member with the decide permission can change this record's state");
}

export function createLandingRecord(env, roomId, creatorMemberId, input) {
  if (!isPlainObject(input)) throw invalid("record body must be an object");
  for (const key of Object.keys(input)) {
    if (!["pr", "headSha", "baseSha", "evidence", "flags", "acceptingAuthority", "note"].includes(key)) {
      throw invalid(`Unknown record field "${key}"`);
    }
  }
  const creator = requireMember(env, roomId, creatorMemberId);
  const pr = prOf(input.pr);
  const headSha = shaOf(input.headSha, "headSha");
  const baseSha = shaOf(input.baseSha, "baseSha");
  const evidence = normalizeEvidence(input.evidence);
  const note = input.note === undefined || input.note === null ? null : cleanText(input.note, "note", 2000);
  const hasFlags = Array.isArray(input.flags) && input.flags.length > 0;
  let acceptingAuthority = null;
  if (input.acceptingAuthority !== undefined && input.acceptingAuthority !== null) {
    acceptingAuthority = cleanText(input.acceptingAuthority, "acceptingAuthority", 200);
  }
  if (hasFlags && !acceptingAuthority) {
    throw invalid("a record carrying priced flags cannot be created without naming its acceptingAuthority");
  }
  const flags = normalizeFlags(input.flags, acceptingAuthority);
  return env.registry.transaction(() => {
    const now = env.now();
    const records = loadRoom(env, roomId);
    const live = records.filter(record => record.pr === pr && record.state === "land-ready");
    const sameHead = live.find(record => record.headSha === headSha);
    if (sameHead) {
      throw new LandingRecordError(409, "landing_record_exists",
        `PR #${pr} already has a land-ready record at head ${headSha} (record ${sameHead.id})`,
        { existing: serializeLandingRecord(sameHead) });
    }
    const record = {
      id: `lr_${randomUUID().replace(/-/g, "")}`,
      pr, headSha, baseSha,
      state: "land-ready",
      evidence, flags, acceptingAuthority, note,
      createdByMemberId: creatorMemberId,
      createdByDisplayName: creator.displayName ?? null,
      createdByKind: creator.kind ?? null,
      createdAt: now,
      landedAt: null, landedByMemberId: null, mergedSha: null, treeSha: null,
      revokedAt: null, revokeReason: null,
      supersededBy: null, supersededByHeadSha: null,
      supersedes: live.map(entry => entry.id),
      history: [{ at: now, action: "created", by: creatorMemberId }],
    };
    for (const prior of live) {
      prior.state = "superseded";
      prior.supersededBy = record.id;
      prior.supersededByHeadSha = headSha;
      prior.history = [...(prior.history ?? []), { at: now, action: "superseded", by: creatorMemberId, via: "replacement" }].slice(-MAX_HISTORY);
      env.registry.set(roomId, prior);
    }
    env.registry.set(roomId, record);
    return { roomId, record: serializeLandingRecord(record) };
  });
}

export function listLandingRecords(env, roomId, viewerMemberId, filter = {}) {
  requireMember(env, roomId, viewerMemberId);
  return env.registry.transaction(() => {
    const records = loadRoom(env, roomId);
    const state = filter.state ?? null;
    if (state !== null && !LANDING_RECORD_STATES.includes(state)) throw invalid(`state must be one of: ${LANDING_RECORD_STATES.join(", ")}`);
    const pr = filter.pr ?? null;
    if (pr !== null) prOf(pr);
    const mine = filter.mine === true;
    const listed = records
      .filter(record => (state === null || record.state === state)
        && (pr === null || record.pr === pr)
        && (!mine || record.createdByMemberId === viewerMemberId))
      .map(serializeLandingRecord);
    return { roomId, records: listed };
  });
}

export function getLandingRecord(env, roomId, viewerMemberId, recordId) {
  requireMember(env, roomId, viewerMemberId);
  return env.registry.transaction(() => {
    loadRoom(env, roomId);
    const record = env.registry.get(roomId, recordId);
    if (!record) throw notFound(recordId);
    return { roomId, record: serializeLandingRecord(record) };
  });
}

function loadForTransition(env, roomId, actorMemberId, recordId) {
  requireMember(env, roomId, actorMemberId);
  loadRoom(env, roomId);
  const record = env.registry.get(roomId, recordId);
  if (!record) throw notFound(recordId);
  if (record.state !== "land-ready") throw closed(record);
  requireAuthority(env, roomId, actorMemberId, record);
  return record;
}

export function landLandingRecord(env, roomId, actorMemberId, recordId, input = {}) {
  if (!isPlainObject(input)) throw invalid("land body must be an object");
  for (const key of Object.keys(input)) {
    if (!["mergedSha", "treeSha"].includes(key)) throw invalid(`Unknown land field "${key}"`);
  }
  const mergedSha = shaOf(input.mergedSha, "mergedSha");
  const treeSha = input.treeSha === undefined || input.treeSha === null ? null : shaOf(input.treeSha, "treeSha");
  return env.registry.transaction(() => {
    const record = loadForTransition(env, roomId, actorMemberId, recordId);
    const now = env.now();
    record.state = "landed";
    record.landedAt = now;
    record.landedByMemberId = actorMemberId;
    record.mergedSha = mergedSha;
    record.treeSha = treeSha;
    record.history = [...(record.history ?? []), { at: now, action: "landed", by: actorMemberId }].slice(-MAX_HISTORY);
    env.registry.set(roomId, record);
    return { roomId, record: serializeLandingRecord(record) };
  });
}

export function revokeLandingRecord(env, roomId, actorMemberId, recordId, input = {}) {
  if (!isPlainObject(input)) throw invalid("revoke body must be an object");
  for (const key of Object.keys(input)) if (key !== "reason") throw invalid(`Unknown revoke field "${key}"`);
  const reason = input.reason === undefined || input.reason === null ? null : cleanText(input.reason, "reason", 500);
  return env.registry.transaction(() => {
    const record = loadForTransition(env, roomId, actorMemberId, recordId);
    const now = env.now();
    record.state = "revoked";
    record.revokedAt = now;
    record.revokeReason = reason;
    record.history = [...(record.history ?? []), { at: now, action: "revoked", by: actorMemberId }].slice(-MAX_HISTORY);
    env.registry.set(roomId, record);
    return { roomId, record: serializeLandingRecord(record) };
  });
}

export function supersedeLandingRecord(env, roomId, actorMemberId, recordId, input = {}) {
  if (!isPlainObject(input)) throw invalid("supersede body must be an object");
  for (const key of Object.keys(input)) {
    if (!["headSha", "note"].includes(key)) throw invalid(`Unknown supersede field "${key}"`);
  }
  const headSha = shaOf(input.headSha, "headSha");
  const note = input.note === undefined || input.note === null ? null : cleanText(input.note, "note", 500);
  return env.registry.transaction(() => {
    const record = loadForTransition(env, roomId, actorMemberId, recordId);
    if (headSha === record.headSha) throw invalid("headSha names the record's own head; the head has not moved");
    const now = env.now();
    record.state = "superseded";
    record.supersededByHeadSha = headSha;
    record.history = [...(record.history ?? []), { at: now, action: "superseded", by: actorMemberId, via: "verb", headSha, ...(note ? { note } : {}) }].slice(-MAX_HISTORY);
    env.registry.set(roomId, record);
    return { roomId, record: serializeLandingRecord(record) };
  });
}

// Build the ops environment from a RoomStore. observedHead reads the
// room's land-queue observation for the PR (store.landingRecordObservedHead:
// the freshest head the queue's GitHub refresh has stored), or null when
// the queue holds no observation for the PR.
export function landingRecordEnv(store) {
  return {
    registry: store.landingRecords,
    member: (roomId, memberId) => store.roomAuthority(roomId).members?.[memberId] ?? null,
    canDecide: (roomId, memberId) => {
      const authority = store.roomAuthority(roomId);
      if (authority.ownerId === memberId) return true;
      try { return memberCan(store.room(roomId).state, memberId, "decide"); }
      catch { return false; }
    },
    observedHead: (roomId, pr) => store.landingRecordObservedHead(roomId, pr),
    now: () => store.now(),
  };
}
