// PRIV-2: history visibility.
//
// A member under "since_join" reads messages and events from their own join
// onward. The join point is the member's latest move to active: the LATEST
// member.added / member.joined_via_invitation, or a member.access_changed
// that reactivates a removed member (#1523): a guest who
// is removed and later reactivated must not read messages posted during the
// removal gap. The event's sequence bounds event-log reads, and its timestamp
// bounds reads over the message projection, which carries createdAt but no
// sequence. Members who read everything get a null floor, so their reads take
// no extra work.

import { randomUUID } from "node:crypto";
import { EVENT_TYPES as T, historyVisibility, memberHistoryVisibility } from "../src/events.js";


// Invite copy for link guests and guest-agent members. Without an owner
// choice, every room (v1 or older) hides earlier messages from those guests.
// "since_join" hides them for every non-owner member. Only an explicit "all"
// includes earlier messages.
export function guestReadsHistoryFromJoin(room) {
  const setting = historyVisibility({ room });
  return setting.value === "since_join" || (setting.value === null && setting.guestsSinceJoin);
}

export function guestHistoryAccessLead(room) {
  return guestReadsHistoryFromJoin(room)
    ? "Read messages posted after you join"
    : "Read the room and its history";
}

const JOIN_TYPES = [T.MEMBER_ADDED, T.MEMBER_JOINED_VIA_INVITATION];

// Pure leaves shared by the full history audit and durable recovery census.
export function advanceHistoryActivation(previous,entry) {
 let nowActive;
 if(JOIN_TYPES.includes(entry.type))nowActive=true;
 else if(entry.active===1||entry.active===true)nowActive=true;
 else if(entry.active===0||entry.active===false)nowActive=false;
 else return previous;
 return {active:nowActive,row:nowActive&&!previous.active?entry:previous.row};
}
export function historyJoinPoint(row,headSequence) {
 if(!row||!Number.isSafeInteger(row.sequence)||typeof row.at!=='string')return {sequence:(Number.isSafeInteger(headSequence)?headSequence:0)+1,at:'9999-12-31T23:59:59.999Z',found:false};
 return {sequence:row.sequence,at:row.at,found:true};
}
export function historyExclusionIds(entry) {
 return [entry.id,entry.messageId].flatMap(id=>typeof id==='string'?[id,`${id}:channel`]:[]);
}

// V2 activation tuple: initialization/full audit may enumerate history; serving
// reads and invitation writes use the protected addressed tuple instead.
export function historyActivationTuple(db,roomId,memberId,headSequence) {
 const rows=db.prepare(`SELECT sequence,json_extract(body,'$.at') at,json_extract(body,'$.type') type,
   json_extract(body,'$.data.active') active FROM events WHERE room_id=?
   AND json_extract(body,'$.data.memberId')=? AND json_extract(body,'$.type') IN (?,?,?) ORDER BY sequence`)
   .all(roomId,memberId,...JOIN_TYPES,T.MEMBER_ACCESS_CHANGED);
 let activation={active:false,row:null};for(const row of rows)activation=advanceHistoryActivation(activation,row);
 return historyActivationValue(historyJoinPoint(activation.row,headSequence));
}
export function historyActivationValue({sequence,at,found}) {
 if(found===false)throw Error('Missing qualified member activation source');
 return {version:2,sequence,at,tieBreak:'source-sequence'};
}
function atOrAfterActivation(at,id,floor,sequenceFor) {
 const instant=Date.parse(at),joined=Date.parse(floor.at);
 if(!Number.isFinite(instant)||!Number.isFinite(joined))return false;
 return instant>joined || instant===joined&&sequenceFor(id)>=floor.sequence;
}

// Returns null (no limit) or { sequence, at, sameInstant } for the member's
// join event. Timestamps have millisecond precision, so `sameInstant` lists
// the ids of messages and events that share the join's millisecond but come
// before it in the log; they stay hidden. A since_join member whose join
// event cannot be found reads nothing older than the room head (fail closed).
export function historyFloor(db, state, roomId, memberId, headSequence = null) {
  if (memberHistoryVisibility(state, memberId) !== "since_join") return null;
  // The reducer refuses a second member.added for a known id, so a removed
  // member comes back through member.access_changed { active: true }. The
  // floor is the member's most recent move from absent-or-inactive to active,
  // whichever event made it; role/permission edits while active do not move it.
  const rows = db.prepare(
    `SELECT sequence, json_extract(body,'$.at') AS at, json_extract(body,'$.type') AS type,
            json_extract(body,'$.data.active') AS active FROM events
     WHERE room_id=? AND json_extract(body,'$.type') IN (${[...JOIN_TYPES, T.MEMBER_ACCESS_CHANGED].map(() => "?").join(",")})
       AND json_extract(body,'$.data.memberId')=?
     ORDER BY sequence`
  ).all(roomId, ...JOIN_TYPES, T.MEMBER_ACCESS_CHANGED, memberId);
  let activation={active:false,row:null};
  for(const entry of rows)activation=advanceHistoryActivation(activation,entry);
  const row=historyJoinPoint(activation.row,headSequence);
  if(!row.found)return {sequence:row.sequence,at:row.at,sameInstant:new Set()};
  const sameInstant = new Set();
  const earlier = db.prepare(
    `SELECT json_extract(body,'$.id') AS id, json_extract(body,'$.data.messageId') AS messageId FROM events
     WHERE room_id=? AND sequence<? AND json_extract(body,'$.at')=?`
  ).all(roomId, row.sequence, row.at);
  for(const entry of earlier)for(const id of historyExclusionIds(entry))sameInstant.add(id);
  return { sequence: row.sequence, at: row.at, sameInstant };
}

// Projection messages: visible when created after the join point.
export function messageInHistory(message, floor) {
  if (!floor) return true;
  const createdAt = message?.createdAt;
  if(floor.version===2)return typeof createdAt==='string'&&atOrAfterActivation(createdAt,message.id,floor,floor.messageSequence);
  if (typeof createdAt !== "string" || createdAt < floor.at) return false;
  return createdAt > floor.at || !floor.sameInstant?.has(message.id);
}

// QA4 Q4-SEC-1: one predicate for summary surfaces (orient, activation pack)
// that read projection messages directly instead of through the store's
// filtered reads. A targeted message (data.toMemberId, a DM) is visible only to
// its author and its addressee; the room owner is not exempt (RC-2026-09-19-070).
// The PRIV-2 floor applies on top. `floor` comes from store.historyFloor().
export function messageVisibleToViewer(message, viewerId, floor) {
  if (!message || message.body == null || message.deletedAt) return false;
  if (message.toMemberId && message.authorId !== viewerId && message.toMemberId !== viewerId) return false;
  return messageInHistory(message, floor);
}

// The floor for a summary read. Fails closed: if the floor cannot be read,
// the viewer sees no message text rather than all of it.
export function summaryHistoryFloor(store, roomId, viewerId, headSequence = null) {
  // A store that cannot report a floor (a mock, a custom adapter) is the same
  // "cannot be read" case as a floor that throws: deny all message text.
  const denyAll = () => ({ sequence: Number.MAX_SAFE_INTEGER, at: "9999-12-31T23:59:59.999Z", sameInstant: new Set() });
  if (typeof store?.historyFloor !== "function") return denyAll();
  try { return store.historyFloor(roomId, viewerId, headSequence); }
  catch { return denyAll(); }
}

// Later events can carry an earlier message's text or reference it (edits,
// reactions, pins). They follow the message: hidden when it is hidden.
function targetsHiddenMessage(event, floor, messagesById) {
  if (!messagesById || event?.type === T.MESSAGE_POSTED) return false;
  const messageId = event?.data?.messageId ?? event?.data?.requestMessageId;
  if (typeof messageId !== "string") return false;
  const message = messagesById.get(messageId);
  return Boolean(message) && !messageInHistory(message, floor);
}

export function indexMessages(messages) {
  return new Map((messages ?? []).filter(m => m && typeof m.id === "string").map(m => [m.id, m]));
}

// Event-log rows ({ sequence, event }): visible from the join event onward.
export function rowInHistory(row, floor, messagesById = null) {
  if (!floor) return true;
  return Number.isSafeInteger(row?.sequence) && row.sequence >= floor.sequence
    && !targetsHiddenMessage(row.event, floor, messagesById);
}

// Bare events (snapshot eventLog entries carry no sequence): by timestamp,
// with the same-millisecond tie broken by log order.
export function eventInHistory(event, floor, messagesById = null) {
  if (!floor) return true;
  const at = event?.at;
  if(floor.version===2)return typeof at==='string'&&atOrAfterActivation(at,event.id,floor,floor.eventSequence)&&!targetsHiddenMessage(event,floor,messagesById);
  if (typeof at !== "string" || at < floor.at) return false;
  return (at > floor.at || !floor.sameInstant?.has(event.id)) && !targetsHiddenMessage(event, floor, messagesById);
}

// Existence privacy (F-S6c-3, register #45): a sequence-bearing surface a
// member reads (a reply-list evaluatedThrough, a needs-me cursor) must be
// derivable from events that member can see. The viewer's visible horizon
// is the sequence of their newest visible event at or below the room head:
// targeted message.posted events (data.toMemberId) are visible only to
// their sender and addressee, follow-up events (edits, deletes, reactions,
// pins) follow the message they target, and dm.consent_changed is visible
// only to its pair and the room owner (the dm-event-visibility rules).
// A hidden event at the head therefore pulls the horizon back to the last
// event the viewer could actually observe, instead of counting it.
const HORIZON_FOLLOW_UP_TYPES = [T.MESSAGE_EDITED, T.MESSAGE_DELETED, T.MESSAGE_REDACTED,
  T.POLL_VOTED, T.MESSAGE_PINNED, T.MESSAGE_UNPINNED];
export function visibleSequenceHorizon(db, roomId, viewerId, headSequence, isOwner = false) {
  if (!Number.isSafeInteger(headSequence) || headSequence <= 0) return 0;
  const row = db.prepare(
    `SELECT MAX(e.sequence) AS horizon FROM events e
     WHERE e.room_id=? AND e.sequence<=?
       AND NOT (
         (json_extract(e.body,'$.type')='message.posted'
           AND COALESCE(json_extract(e.body,'$.data.toMemberId'),'')<>''
           AND json_extract(e.body,'$.actorId')<>?
           AND json_extract(e.body,'$.data.toMemberId')<>?)
         OR (json_extract(e.body,'$.type') IN (${HORIZON_FOLLOW_UP_TYPES.map(() => "?").join(",")})
           AND EXISTS (SELECT 1 FROM events p WHERE p.room_id=e.room_id
             AND json_extract(p.body,'$.type')='message.posted'
             AND COALESCE(json_extract(p.body,'$.data.toMemberId'),'')<>''
             AND (json_extract(p.body,'$.data.messageId')=json_extract(e.body,'$.data.messageId')
               OR p.id=json_extract(e.body,'$.data.messageId'))
             AND json_extract(p.body,'$.actorId')<>?
             AND json_extract(p.body,'$.data.toMemberId')<>?))
         OR (json_extract(e.body,'$.type')='dm.consent_changed' AND ? = 0
           AND json_extract(e.body,'$.data.requesterId')<>?
           AND json_extract(e.body,'$.data.targetId')<>?)
       )`
  ).get(roomId, headSequence, viewerId, viewerId, ...HORIZON_FOLLOW_UP_TYPES,
    viewerId, viewerId, isOwner ? 1 : 0, viewerId, viewerId);
  return Number.isSafeInteger(row?.horizon) ? row.horizon : 0;
}

// Export authority: only the room owner exports, and every export of a live
// room appends room.exported (format only, no content) through the normal
// command path. An archived room records nothing new, so its exports leave
// no event; they stay owner-only.
export function requireExportOwner(store, roomId, memberId, fail) {
  if (memberId !== store.roomAuthority(roomId, {memberId}).ownerId) fail(403, "owner_required", "Only the room owner can export the room");
}

export function recordRoomExport(store, token, roomId, format, expectedSessionBinding = null) {
  if (store.roomArchivedForExport(roomId)) return null;
  return store.command(token, roomId, { id: randomUUID(), type: T.ROOM_EXPORTED, data: { format } }, expectedSessionBinding);
}
