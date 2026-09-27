// Moderation (issue #6 E4): report a message to the room owner; mute a member
// for yourself.
//
// Reports are append-only records in their own table, not room events: every
// member replays the room event log (events, stream, export), so a report in
// the log could never be "visible to the owner only". A report holds the
// message id, the reporter, a short reason and a time; it names no one else
// and copies no message body (the owner reads the message from the room).
// Only the room owner can list reports; the reporter sees only their own
// receipt. Nothing here leaves the room or spends anything.
//
// Mute is a per-member preference recorded on the muter's own member record
// by the member.mute_set event (src/events.js). This module composes it with
// derived feeds: `mutedEvent` says whether a viewer's feed should skip an
// event because they muted its actor.
import { randomUUID } from "node:crypto";
import { validId, isMutedBy } from "../src/events.js";
import { ServiceError } from "./store.mjs";
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const reportLimits = Object.freeze({ reasonLength: 280, perReporterPerHour: 20, perRoom: 5000 });

export const moderationSchema = `
  CREATE TABLE IF NOT EXISTS message_reports (
    room_id TEXT NOT NULL REFERENCES rooms(id), report_id TEXT NOT NULL, message_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL, author_id TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(room_id,report_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS message_reports_once ON message_reports(room_id,reporter_id,message_id);
  CREATE TRIGGER IF NOT EXISTS message_reports_no_update BEFORE UPDATE ON message_reports BEGIN SELECT RAISE(ABORT,'message reports are immutable'); END;
`;

// Pure: should a feed derived for `viewerId` skip this event? True when the
// viewer muted the event's actor. Deleted or unknown members are never muted.
export function mutedEvent(state, viewerId, event) {
  return isMutedBy(state, viewerId, event?.actorId);
}

// Pure: should a read derived for `viewerId` skip this message? True when the
// viewer muted its author. Room search calls it for every kind so the server
// answer matches the browser's `isMutedBy` filter (backlog 11); work items
// have no author and are never filtered.
export function mutedMessage(state, viewerId, message) {
  return isMutedBy(state, viewerId, message?.authorId);
}

const receipt = row => ({ id: row.report_id, messageId: row.message_id, reason: row.reason, createdAt: row.created_at });

export class Moderation {
  constructor(store) { this.store = store; this.db = store.db; }
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = moderationSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|UNIQUE INDEX|INDEX|TRIGGER) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Message report schema requires operator reconciliation");
    }
    return true;
  }
  viewer(auth, roomId) {
    return {
      roomId, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null,
      viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null, evaluatedAt: this.store.now()
    };
  }
  // Any active member may report a message they did not write. One report per
  // (reporter, message): repeating it returns the first receipt as a duplicate.
  report(token, roomId, request, binding = null) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      // Filing a report is a write: the read-only autonomy tier applies even
      // though reports never pass through store.command() (issue #997).
      enforceAutonomyTierForAction({
        db: this.store.db, roomId, state: this.store.room(roomId).state, actor: auth.member,
        action: "moderation_report", fail,
      });
      if (!request || Array.isArray(request) || typeof request !== "object" || Object.keys(request).length !== 2
        || !Object.hasOwn(request, "messageId") || !Object.hasOwn(request, "reason")) fail(422, "invalid_report", "Supply one message id and a short reason");
      if (!validId(request.messageId)) fail(422, "invalid_report", "Supply one message id and a short reason");
      const reason = typeof request.reason === "string" ? request.reason.trim() : "";
      if (!reason) fail(422, "invalid_report", "Say briefly why you are reporting this message");
      if (reason.length > reportLimits.reasonLength || /[\p{Cc}]/u.test(reason.replace(/[\n\t]/g, ""))) fail(422, "invalid_report", `Keep the reason to ${reportLimits.reasonLength} characters of plain text`);
      const room = this.store.room(roomId);
      const message = room.state.messages.find(m => m.id === request.messageId);
      if (!message) fail(404, "message_not_found", "That message is not in this room");
      if (message.authorId === auth.member.id) fail(422, "invalid_report", "You cannot report your own message; delete it instead");
      const prior = this.db.prepare("SELECT * FROM message_reports WHERE room_id=? AND reporter_id=? AND message_id=?").get(roomId, auth.member.id, request.messageId);
      if (prior) return { ...this.viewer(auth, roomId), report: receipt(prior), duplicate: true };
      const now = this.store.now();
      const recent = this.db.prepare("SELECT count(*) n FROM message_reports WHERE room_id=? AND reporter_id=? AND created_at>?").get(roomId, auth.member.id, now - 3600000).n;
      if (recent >= reportLimits.perReporterPerHour) fail(429, "report_limit", "You have sent many reports in the last hour. The owner has them; try again later.");
      const total = this.db.prepare("SELECT count(*) n FROM message_reports WHERE room_id=?").get(roomId).n;
      if (total >= reportLimits.perRoom) fail(409, "pilot_limit", "Report capacity reached for this room; nothing was saved");
      const row = { room_id: roomId, report_id: randomUUID(), message_id: request.messageId, reporter_id: auth.member.id, author_id: message.authorId, reason, created_at: now };
      this.db.prepare("INSERT INTO message_reports VALUES(?,?,?,?,?,?,?)").run(row.room_id, row.report_id, row.message_id, row.reporter_id, row.author_id, row.reason, row.created_at);
      return { ...this.viewer(auth, roomId), report: receipt(row), duplicate: false };
    });
  }
  // Owner only. The reporter's identity is part of the record the owner sees;
  // no other member ever receives it (no route, event or export carries it).
  list(token, roomId, binding = null) {
    return this.store.readTransaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      const room = this.store.room(roomId);
      // #643: owner-by-id — the owner capability follows the owner identity,
      // not the member kind; an agent owner may review reports. Owner-only.
      if (auth.member.id !== room.state.room.ownerId) fail(403, "owner_required", "Only the room owner can read reports");
      const messages = new Map(room.state.messages.map(m => [m.id, m]));
      const reports = this.db.prepare("SELECT * FROM message_reports WHERE room_id=? ORDER BY created_at DESC, report_id").all(roomId).map(row => {
        const message = messages.get(row.message_id);
        return {
          ...receipt(row), reporterId: row.reporter_id, authorId: row.author_id,
          message: message ? { authorId: message.authorId, body: message.deletedAt ? null : message.body, createdAt: message.createdAt, deletedAt: message.deletedAt ?? null } : null
        };
      });
      return { ...this.viewer(auth, roomId), reports };
    });
  }
}
