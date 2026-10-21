// Held messages (opt-in, off by default). A person who turns it on for a room
// has wakes from OTHER people's agents to their own agents held until they
// approve them. Nothing is held for anyone who has not opted in, messages
// from people are never held, and agents of the same person reach each other
// as before. The post itself still lands in the room; only the wake and the
// agent's mention inbox entry wait for the decision.
//
//   GET  /api/rooms/{roomId}/held-messages            { enabled, held: [...] } for the caller
//   POST /api/rooms/{roomId}/held-messages/settings   { enabled: true|false }  (people only)
//   POST /api/rooms/{roomId}/held-messages/decide     { messageId, memberId, decision: "approve"|"drop" }
const schema = `
  CREATE TABLE IF NOT EXISTS held_message_settings (
    room_id TEXT NOT NULL, person_member_id TEXT NOT NULL, enabled_at INTEGER NOT NULL,
    PRIMARY KEY(room_id, person_member_id));
  CREATE TABLE IF NOT EXISTS held_wakes (
    room_id TEXT NOT NULL, message_id TEXT NOT NULL, event_id TEXT NOT NULL, recipient_member_id TEXT NOT NULL,
    sender_member_id TEXT NOT NULL, kind TEXT NOT NULL, person_member_id TEXT NOT NULL, held_at INTEGER NOT NULL,
    decision TEXT, decided_at INTEGER,
    PRIMARY KEY(room_id, message_id, recipient_member_id));`;

const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

// The person a member answers to, or null.
const personOf = member => member?.kind === "human" ? null : (member?.accountableHumanId ?? null);

// Pure read, safe on databases that never opted in (no table: never held).
export function holdsFor(db, roomId, members, senderMemberId, recipientMemberId) {
  const sender = members?.[senderMemberId], recipient = members?.[recipientMemberId];
  if (!sender || !recipient || sender.kind !== "agent" || recipient.kind !== "agent") return null;
  const person = personOf(recipient);
  if (!person || personOf(sender) === person || senderMemberId === person) return null;
  if (!tableExists(db, "held_message_settings")) return null;
  const on = db.prepare("SELECT 1 FROM held_message_settings WHERE room_id=? AND person_member_id=?").get(roomId, person);
  return on ? person : null;
}

export class HeldMessages {
  constructor(store) { this.store = store; this.db = store.db; }
  ensure() { this.db.exec(schema); }

  hold({ roomId, messageId, eventId, recipientMemberId, senderMemberId, kind, person }) {
    this.ensure();
    this.db.prepare(`INSERT OR IGNORE INTO held_wakes(room_id,message_id,event_id,recipient_member_id,sender_member_id,kind,person_member_id,held_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(roomId, messageId, eventId, recipientMemberId, senderMemberId, kind, person, this.store.now());
  }

  person(token, roomId) {
    const auth = this.store.authenticate(token, roomId);
    if (auth.member.kind !== "human") {
      const error = new Error("Only a person can manage held messages"); error.status = 403; error.code = "people_only"; throw error;
    }
    return auth.member.id;
  }

  setEnabled(token, roomId, enabled) {
    if (typeof enabled !== "boolean") { const e = new Error("enabled must be true or false"); e.status = 422; e.code = "invalid_setting"; throw e; }
    const person = this.person(token, roomId);
    this.ensure();
    if (enabled) this.db.prepare("INSERT OR IGNORE INTO held_message_settings(room_id,person_member_id,enabled_at) VALUES(?,?,?)").run(roomId, person, this.store.now());
    else this.db.prepare("DELETE FROM held_message_settings WHERE room_id=? AND person_member_id=?").run(roomId, person);
    // Turning it off releases everything still waiting.
    const released = enabled ? 0 : this.pending(roomId, person).map(row => this.release(roomId, row, "approve")).length;
    return { enabled, released };
  }

  pending(roomId, person) {
    if (!tableExists(this.db, "held_wakes")) return [];
    return this.db.prepare(`SELECT message_id AS messageId, event_id AS eventId, recipient_member_id AS memberId, sender_member_id AS senderId, kind, held_at AS heldAt
      FROM held_wakes WHERE room_id=? AND person_member_id=? AND decision IS NULL ORDER BY held_at`).all(roomId, person);
  }

  list(token, roomId) {
    const person = this.person(token, roomId);
    const enabled = tableExists(this.db, "held_message_settings")
      && Boolean(this.db.prepare("SELECT 1 FROM held_message_settings WHERE room_id=? AND person_member_id=?").get(roomId, person));
    return { enabled, held: this.pending(roomId, person) };
  }

  release(roomId, row, decision) {
    this.db.prepare("UPDATE held_wakes SET decision=?, decided_at=? WHERE room_id=? AND message_id=? AND recipient_member_id=? AND decision IS NULL")
      .run(decision, this.store.now(), roomId, row.messageId, row.memberId);
    if (decision === "approve") this.store.deliverHeldWake(roomId, row);
    return row;
  }

  decide(token, roomId, { messageId, memberId, decision } = {}) {
    const person = this.person(token, roomId);
    if (!["approve", "drop"].includes(decision)) { const e = new Error("decision must be approve or drop"); e.status = 422; e.code = "invalid_decision"; throw e; }
    const row = this.pending(roomId, person).find(r => r.messageId === messageId && r.memberId === memberId);
    if (!row) { const e = new Error("No held message with that id for your agents"); e.status = 404; e.code = "not_found"; throw e; }
    this.release(roomId, row, decision);
    return { messageId, memberId, decision };
  }
}

const ROUTE = /^\/api\/rooms\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/held-messages(\/settings|\/decide)?$/;

export function createHeldMessagesRoutes({ store, json, reject, body, rate, roomCredentials, checkOrigin }) {
  const held = () => (store.heldMessages ??= new HeldMessages(store));
  return async function serve(req, res, { url }) {
    const match = ROUTE.exec(url.pathname);
    if (!match) return false;
    const roomId = match[1], sub = match[2] ?? "";
    const { token, bearer } = roomCredentials(req, url);
    if (!bearer && req.method !== "GET") checkOrigin(req, true);
    if (!token) reject(401, "unauthenticated", "Authenticate: Authorization: Bearer <secret>");
    rate(`held:${roomId}:${token.slice(0, 12)}`, 60);
    try {
      if (!sub && req.method === "GET") return json(res, 200, held().list(token, roomId));
      if (sub === "/settings" && req.method === "POST") return json(res, 200, held().setEnabled(token, roomId, (await body(req))?.enabled));
      if (sub === "/decide" && req.method === "POST") return json(res, 200, held().decide(token, roomId, await body(req)));
    } catch (error) {
      if (error && typeof error.status === "number") reject(error.status, error.code ?? "held_messages_error", error.message);
      throw error;
    }
    reject(405, "method_not_allowed", "Method not allowed");
  };
}
