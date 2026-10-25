// One status line per member, upserted in place. This is the presence.status_set
// command: it never appends a room event and never writes message.posted.
// Older writers have no path to the table, so it stays outside the writer fence.
import { ownMember, validId } from "../src/events.js";
import { ServiceError } from "./service-error.mjs";

export const STATUS_LINE_MAX = 140;

export const memberStatusLineSchema = `
  CREATE TABLE IF NOT EXISTS room_member_status (
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(room_id, member_id)
  );
`;

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export function statusLinesEnabled(env = globalThis.process?.env ?? {}) {
  const value = env.ROOM_STATUS_LINES;
  return value === "1" || value === "true";
}

// Empty text clears the row. A newline is refused so the line stays one line.
export function normalizeStatusLine(text) {
  if (typeof text !== "string") fail(422, "invalid_status_line", "Status line must be text.");
  if (text.includes("\n") || text.includes("\r")) fail(422, "invalid_status_line", "Status line must be one line.");
  const line = text.trim();
  if (line.length > STATUS_LINE_MAX) fail(422, "invalid_status_line", "Status line must be 140 characters or fewer.");
  return line;
}

export class MemberStatusLines {
  constructor(store) { this.store = store; this.db = store.db; }

  set(roomId, memberId, text) {
    return this.store.transaction(() => {
      if (!validId(roomId) || !validId(memberId)) fail(422, "invalid_status_line", "Status line must name a member.");
      const member = ownMember(this.store.room(roomId).state.members, memberId);
      if (!member || member.active === false) fail(403, "access_denied", "Active member required");
      const line = normalizeStatusLine(text);
      if (!line) {
        this.db.prepare("DELETE FROM room_member_status WHERE room_id=? AND member_id=?").run(roomId, memberId);
        return { command: "presence.status_set", text: "" };
      }
      this.db.prepare(`INSERT INTO room_member_status (room_id, member_id, text, updated_at)
        VALUES (?,?,?,?)
        ON CONFLICT(room_id, member_id) DO UPDATE SET text=excluded.text, updated_at=excluded.updated_at`)
        .run(roomId, memberId, line, this.store.now());
      return { command: "presence.status_set", text: line };
    });
  }

  // Display names come from the live roster. A missing, inactive, or unnamed
  // member is omitted so the header never shows a member id.
  list(roomId) {
    return this.store.readTransaction(() => {
      const members = this.store.room(roomId).state.members ?? {};
      const lines = [];
      for (const row of this.db.prepare("SELECT member_id, text FROM room_member_status WHERE room_id=?").all(roomId)) {
        const member = ownMember(members, row.member_id);
        const displayName = typeof member?.displayName === "string" ? member.displayName.trim() : "";
        if (!member || member.active === false || !displayName || !row.text) continue;
        lines.push({ displayName, text: row.text });
      }
      lines.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.text.localeCompare(b.text));
      return lines;
    });
  }
}
