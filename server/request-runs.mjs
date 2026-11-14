import { validId, isRoomArchived } from "../src/events.js";
import { messageInHistory } from "./history-visibility.mjs";
import {isCurrentRoom,withCurrentReadContext,readCurrentHead,readCurrentRecord,readCurrentMessage,CURRENT_REQUEST_OPENING_PREDICATE} from './current-room-repository.mjs';

// Addressed protected dependencies only. The legacy full-state contract stays
// unchanged; normalized reads never reconstruct the room or its request map.
function currentRunContext(store, roomId, ids, viewerId, recipientOnly = false) {
  return withCurrentReadContext(store.db, roomId, b => {
    const head = readCurrentHead(store.db, roomId, b);
    const room = readCurrentRecord(store.db, roomId, 'metadata', 'room', b);
    const replyRequests = Object.create(null), members = Object.create(null);
    for (const id of ids) {
      const request = readCurrentRecord(store.db, roomId, 'replyRequests', id, b);
      if (!request) {
        if (!recipientOnly) fail('request_run_changed', 'Request selector lacks its protected request');
        continue;
      }
      // Deny unrelated selections before loading private opening context.
      if (recipientOnly && request.recipientId !== viewerId) continue;
      if (!recipientOnly && ![request.requesterId, request.recipientId].includes(viewerId)) fail('request_run_changed', 'Request party selectors require reconciliation');
      if (request.id !== id || !validId(request.openingEventId) || !validId(request.requesterId)
        || !validId(request.recipientId) || !['open','answered','declined','cancelled'].includes(request.status))
        fail('request_run_changed', 'Request proof requires reconciliation');
      // Bind request metadata to the independently protected opening message.
      const opening = readCurrentMessage(store.db, roomId, id, b);
      const event = opening && store.db.prepare(`SELECT id,json_extract(body,'$.actorId') AS requester,json_extract(body,'$.data.toMemberId') AS recipient,json_extract(body,'$.data.messageId') AS messageId,json_extract(body,'$.at') AS at FROM events WHERE room_id=? AND sequence=? AND ${CURRENT_REQUEST_OPENING_PREDICATE}`).get(roomId, opening.row.seq);
      if (!opening || event?.id !== request.openingEventId || event.requester !== request.requesterId || event.recipient !== request.recipientId || event.messageId !== id || event.at !== request.createdAt || opening.value.authorId !== request.requesterId
        || opening.value.toMemberId !== request.recipientId || opening.value.createdAt !== request.createdAt)
        fail('request_run_changed', 'Request opening requires reconciliation');
      replyRequests[id] = request;
      if (!Object.hasOwn(members, request.requesterId)) Object.defineProperty(members, request.requesterId, {value:readCurrentRecord(store.db, roomId, 'members', request.requesterId, b),enumerable:true});
    }
    return {state:{room,members,replyRequests}, sequence:head.sequence,
      floor:store.historyFloor(roomId, viewerId, head.sequence)};
  });
}

// This reservation never expires or transfers. A lost host may still be writing.
// Status is operational metadata, not a message or an answer-basis revision.
export const requestRunSchema = `
  CREATE TABLE IF NOT EXISTS request_runs (
    room_id TEXT NOT NULL, opening_id TEXT NOT NULL, request_id TEXT NOT NULL,
    member_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('working','result_ready','needs_attention','delivered')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(room_id,opening_id)
  );
  CREATE TRIGGER IF NOT EXISTS request_run_owner_immutable BEFORE UPDATE ON request_runs
  WHEN NEW.room_id != OLD.room_id OR NEW.opening_id != OLD.opening_id
    OR NEW.request_id != OLD.request_id OR NEW.member_id != OLD.member_id OR NEW.attempt_id != OLD.attempt_id
  BEGIN SELECT RAISE(ABORT,'Request execution ownership is permanent'); END;
`;
const fail = (code, message, status = 409) => { throw Object.assign(new Error(message), { code, status }); };
export class RequestRuns {
  constructor(store) { this.store = store; }
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = requestRunSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean).map(sql => ({ sql,
      actual: this.store.db.prepare("SELECT sql FROM sqlite_master WHERE name=?")
        .get(/^CREATE (?:TABLE|TRIGGER) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(row => row.actual === undefined)) return false;
    if (expected.some(row => normalize(row.sql) !== normalize(row.actual))) throw new Error("Request execution schema requires operator reconciliation");
    return true;
  }
  list(token, roomId, binding = null) {
    return this.store.readTransaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      const current = isCurrentRoom(this.store.db, roomId);
      const exists = this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='request_runs' AND type='table'").get();
      // v1 promises a complete map, not a first page. Refuse a larger source
      // before hydrating any records rather than returning a misleading subset.
      let context, rows;
      if (current) {
        const ids = new Set();
        // Cap each viewer-only indexed prefix before proof hydration. The
        // independent union detects a single source's omitted party selector.
        for (const role of ['requester','recipient']) {
          for (const row of this.store.db.prepare(`SELECT record_key AS id FROM current_room_records INDEXED BY current_request_party_${role}
            WHERE room_id=? AND domain='replyRequests' AND json_extract(payload,'$.${role}Id')=? ORDER BY record_key LIMIT 33`).all(roomId,auth.member.id)) ids.add(row.id);
          const path = role === 'requester' ? '$.actorId' : '$.data.toMemberId';
          for (const row of this.store.db.prepare(`SELECT json_extract(body,'$.data.messageId') AS id FROM events INDEXED BY current_request_opening_${role}
            WHERE room_id=? AND json_extract(body,'${path}')=? AND ${CURRENT_REQUEST_OPENING_PREDICATE} ORDER BY sequence LIMIT 33`).all(roomId,auth.member.id)) ids.add(row.id);
        }
        if (ids.size > 32) fail('request_runs_context_unavailable', 'Request run list exceeds bounded viewer-party v1 coverage; inspect selected requests and original attempts', 422);
        context = currentRunContext(this.store, roomId, [...ids], auth.member.id);
        rows = exists ? Object.values(context.state.replyRequests).flatMap(request => {
          const row = this.store.db.prepare('SELECT * FROM request_runs WHERE room_id=? AND opening_id=?').get(roomId,request.openingEventId);
          return row ? [row] : [];
        }) : [];
      } else {
        rows = !exists ? [] : this.store.db.prepare("SELECT * FROM request_runs WHERE room_id=?").all(roomId);
        context = this.store.room(roomId);
      }
      const state = context.state, floor = current ? context.floor : this.store.historyFloor(roomId, auth.member.id, context.sequence);
      const runs = {};
      for (const row of rows) {
        const request = state.replyRequests?.[row.request_id];
        if (!request || request.openingEventId !== row.opening_id
          || !messageInHistory({ id: request.id, createdAt: request.createdAt }, floor)
          || ![request.requesterId, request.recipientId].includes(auth.member.id)) continue;
        runs[row.request_id] = { state: row.state === "working" && this.store.now() - row.updated_at > 120000 ? "unknown" : row.state,
          updatedAt: row.updated_at };
      }
      return { contractVersion: 1, roomId, viewerId: auth.member.id, runs };
    });
  }
  apply(token, roomId, input, binding = null) {
    if (!input || Array.isArray(input) || Object.keys(input).some(k => !["requestMessageId", "attemptId", "action", "expectedRequestRevision", "contextEventId"].includes(k))
      || !validId(input.requestMessageId) || !validId(input.attemptId)
      || !["claim", "working", "result_ready", "needs_attention", "delivered"].includes(input.action))
      fail("invalid_request_run", "Choose one request, attempt and supported action", 422);
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      const current = isCurrentRoom(this.store.db, roomId);
      const context = current ? currentRunContext(this.store, roomId, [input.requestMessageId], auth.member.id, true) : this.store.room(roomId);
      const state = context.state;
      const request = state.replyRequests?.[input.requestMessageId];
      if (auth.member.kind !== "agent" || !request || request.recipientId !== auth.member.id)
        fail("request_run_denied", "Only the addressed agent may report its host", 403);
      const row = this.store.db.prepare("SELECT * FROM request_runs WHERE room_id=? AND opening_id=?").get(roomId, request.openingEventId);
      if (row && row.attempt_id !== input.attemptId) fail("request_run_owned", "Another host owns this request; reconcile that host");
      // G8 (T3-L10f-C3): the archived-room freeze at this module's write
      // entry, in the refuseArchivedWrite shape (409 room_archived). Only
      // claim/working checked archivedAt before, and with the wrong code;
      // result_ready, needs_attention and delivered updated request_runs
      // rows in archived rooms. request_runs writes are direct SQL and
      // never pass through a #5502 choke point (registry/escrow/credential/
      // collab/project-map/invite), so the guard lives here. Reads (list)
      // stay open.
      if (isRoomArchived(state)) fail("room_archived", "This room is archived: reading and export stay available, nothing new is recorded");
      if (input.action === "claim" || input.action === "working") {
        const floor = current ? context.floor : this.store.historyFloor(roomId, auth.member.id, context.sequence);
        if (!messageInHistory({ id: request.id, createdAt: request.createdAt }, floor))
          fail("request_run_changed", "Request is outside your visible history; reconcile the original attempt");
        this.store.dmConsents.requireDmAllowed(roomId, auth.member.id, request.requesterId);
        if (request.status !== "open" || state.members[request.requesterId]?.active !== true
          || this.store.wakeQueue.pauseStatus(roomId, auth.member.id)
          || request.revision !== input.expectedRequestRevision || request.contextEventId !== input.contextEventId)
          fail("request_run_changed", "Request changed, paused or closed; inspect the original attempt");
      }
      if (input.action === "delivered" && request.status !== "answered")
        fail("request_run_not_delivered", "The original request has no recorded answer");
      // Intermediate host reports are only meaningful while the request is
      // still open: a cancelled or declined (or already answered) request must
      // not be flipped to result_ready / needs_attention by a stale host.
      if ((input.action === "result_ready" || input.action === "needs_attention") && request.status !== "open")
        fail("request_run_changed", "Request changed, paused or closed; inspect the original attempt");
      if (input.action === "claim") {
        if (row) fail("request_run_owned", "This attempt is already reserved; its execution outcome must be reconciled");
        this.store.db.prepare("INSERT INTO request_runs VALUES(?,?,?,?,?,'working',?)").run(roomId, request.openingEventId, request.id, auth.member.id, input.attemptId, this.store.now());
      } else {
        if (!row) fail("request_run_missing", "Reserve the request before reporting its host");
        if (row.state === "delivered" && input.action !== "delivered"
          || row.state === "result_ready" && input.action === "working"
          || row.state === "needs_attention" && input.action === "working") fail("request_run_terminal", "An uncertain attempt cannot silently resume execution");
        this.store.db.prepare("UPDATE request_runs SET state=?,updated_at=? WHERE room_id=? AND opening_id=?").run(input.action, this.store.now(), roomId, request.openingEventId);
      }
      return { contractVersion: 1, roomId, viewerId: auth.member.id, requestMessageId: request.id, attemptId: input.attemptId,
        state: input.action === "claim" ? "working" : input.action };
    });
  }
}

// Internal observation only: callers supply canonical requests already filtered
// for this viewer/history floor within the same read transaction. Never accept
// request records from HTTP input or use this observation as execution authority.
// Pickup may omit bodies, but its selected run ownership still depends on
// the exact protected canonical request opening. Reuse execution's proof rules.
export function validateSelectedRunOpenings(store,roomId,requests,viewerId){
  if(!isCurrentRoom(store.db,roomId))return;
  if(!validId(viewerId)||!Array.isArray(requests)||requests.length>4)fail('request_runs_context_unavailable','Selected pickup proof exceeds bounded v1 coverage; use the paged request reads',422);
  if(!requests.length)return;
  const context=currentRunContext(store,roomId,requests.map(request=>request.id),viewerId,true);
  for(const selected of requests){const current=context.state.replyRequests[selected.id];
    if(!current||['id','openingEventId','requesterId','recipientId','revision','status'].some(key=>selected[key]!==current[key]))fail('request_run_changed','Selected request opening requires reconciliation');
  }
}

export function observeSelectedRuns(store, roomId, requests) {
  if (!requests.length || !store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='request_runs' AND type='table'").get()) return {};
  // CROSS JOIN pins selected openings as the outer loop. An ordinary JOIN
  // can scan every run in the room before consulting the selected JSON array.
  const rows = store.db.prepare(`SELECT r.request_id,r.state,r.updated_at
    FROM json_each(?) selected CROSS JOIN request_runs r
    ON r.room_id=? AND r.opening_id=json_extract(selected.value,'$.openingEventId')
      AND r.request_id=json_extract(selected.value,'$.id')`).all(
    JSON.stringify(requests.map(({ id, openingEventId }) => ({ id, openingEventId }))), roomId);
  return Object.fromEntries(rows.map(row => [row.request_id, {
    state: row.state === 'working' && store.now() - row.updated_at > 120000 ? 'unknown' : row.state,
    updatedAt: row.updated_at
  }]));
}
