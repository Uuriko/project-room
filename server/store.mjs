import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { applyEvent, emptyRoomState, event, EVENT_TYPES as T, validId } from "../src/events.js";

export class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const hash = text => createHash("sha256").update(text).digest("hex");
const key = () => randomBytes(32).toString("base64url");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}` : JSON.stringify(value);
const compact = state => ({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });
const work = "workItemId expectedRevision";
const shapes = {
  [T.MEMBER_ADDED]: "memberId displayName kind permissions accountableHumanId",
  [T.MEMBER_ACCESS_CHANGED]: "memberId expectedMemberRevision permissions active",
  [T.MESSAGE_POSTED]: "messageId body workItemId replyToId toMemberId",
  [T.WORK_PROPOSED]: "workItemId title definitionOfDone accountableMemberId verifierMemberId independentVerificationRequired ownerDecisionRequired humanDecisionMakerId mode sourceMessageId",
  [T.WORK_ACCEPTED]: work,
  [T.WORK_STARTED]: `${work} resolvedBlocker`,
  [T.WORK_BLOCKED]: `${work} reason nextAction`,
  [T.WORK_BLOCKER_RESOLVED]: `${work} resolution`,
  [T.WORK_COMPLETED]: `${work} summary evidenceUrl evidenceVersion nextAction checksClaimed`,
  [T.WORK_SUPERSEDED]: `${work} supersededByWorkItemId reason`,
  [T.CLAIM_ACQUIRED]: `${work} repository ref paths expiresAt`,
  [T.CLAIM_RELEASED]: work,
  [T.VERIFICATION_RECORDED]: `${work} result completionEventId evidenceVersion summary nextAction`,
  [T.OWNER_DECISION_RECORDED]: `${work} decision completionEventId evidenceVersion reason`
};

export function validateCommand(command) {
  if (!command || Array.isArray(command) || typeof command !== "object" || Object.keys(command).some(k => !["id", "type", "data", "causationId"].includes(k))) fail(422, "invalid_command", "Supply only id, type, data, and optional causationId");
  if (!validId(command.id) || !Object.hasOwn(shapes, command.type)) fail(422, "invalid_command", "Invalid command id or type");
  if (command.causationId != null && !validId(command.causationId)) fail(422, "invalid_command", "Invalid causationId");
  if (!command.data || Array.isArray(command.data) || typeof command.data !== "object") fail(422, "invalid_command", "Data must be an object");
  const allowed = shapes[command.type].split(" ");
  for (const [name, value] of Object.entries(command.data)) {
    if (!allowed.includes(name)) fail(422, "invalid_command", `Unexpected field: ${name}`);
    if (value === null) continue;
    const type = ["expectedRevision", "expectedMemberRevision"].includes(name) ? "number" : ["active", "independentVerificationRequired", "ownerDecisionRequired"].includes(name) ? "boolean" : ["permissions", "paths", "checksClaimed"].includes(name) ? "array" : "string";
    if (type === "array" ? !Array.isArray(value) : typeof value !== type) fail(422, "invalid_command", `Invalid field: ${name}`);
  }
  if (Buffer.byteLength(JSON.stringify(command)) > 16384) fail(413, "too_large", "Command is too large");
}

export class RoomStore {
  constructor(filename, { now = () => Date.now() } = {}) {
    this.now = now;
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;");
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version > 1) throw new Error("Database schema is newer than this service");
    if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE rooms (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, projection TEXT NOT NULL);
      CREATE TABLE events (room_id TEXT NOT NULL REFERENCES rooms(id), sequence INTEGER NOT NULL, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY(room_id, sequence));
      CREATE TABLE commands (room_id TEXT NOT NULL REFERENCES rooms(id), actor_id TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(room_id, actor_id, id), FOREIGN KEY(room_id, sequence) REFERENCES events(room_id, sequence));
      CREATE TABLE credentials (hash TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('access','session')), parent_hash TEXT REFERENCES credentials(hash), expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX credential_member ON credentials(room_id, member_id);
      CREATE TABLE cursors (room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(room_id, member_id));
      PRAGMA user_version=1; COMMIT;`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  room(roomId) {
    const row = this.db.prepare("SELECT * FROM rooms WHERE id=?").get(roomId);
    if (!row) fail(404, "room_not_found", "Room not found");
    return { sequence: row.sequence, state: JSON.parse(row.projection) };
  }
  // Administrative bootstrap, never exposed over HTTP. Historical demo events are test fixtures only.
  initialize(events) {
    return this.transaction(() => {
      const state = events.reduce(applyEvent, emptyRoomState());
      this.db.prepare("INSERT INTO rooms VALUES(?,?,?)").run(state.room.id, events.length, JSON.stringify(compact(state)));
      const insert = this.db.prepare("INSERT INTO events VALUES(?,?,?,?)");
      events.forEach((e, i) => insert.run(state.room.id, i + 1, e.id, JSON.stringify(e)));
      return state.room.id;
    });
  }
  issueAccessKey(roomId, memberId, lifetimeMs = 7 * 86400000) {
    return this.transaction(() => {
      const members = this.room(roomId).state.members;
      const member = validId(memberId) && Object.hasOwn(members, memberId) && members[memberId];
      if (!member || member.active === false) fail(403, "access_denied", "Active member required");
      if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > 30 * 86400000) fail(422, "invalid_expiry", "Access keys expire within 30 days");
      this.db.prepare("UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id=?").run(roomId, memberId);
      return this.insertCredential(roomId, memberId, "access", null, this.now() + lifetimeMs);
    });
  }
  insertCredential(roomId, memberId, kind, parent, expiresAt) {
    const count = this.db.prepare("SELECT count(*) AS n FROM credentials WHERE room_id=?").get(roomId).n;
    if (count >= 5000) fail(409, "pilot_limit", "Credential retention limit reached; administrator maintenance required");
    const token = key();
    this.db.prepare("INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at) VALUES(?,?,?,?,?,?)").run(hash(token), roomId, memberId, kind, parent, expiresAt);
    return token;
  }
  authenticate(token, roomId) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, "unauthenticated", "Sign in with an active room key");
    const row = this.db.prepare("SELECT c.*, p.revoked AS parent_revoked, p.expires_at AS parent_expiry FROM credentials c LEFT JOIN credentials p ON p.hash=c.parent_hash WHERE c.hash=?").get(hash(token));
    if (!row || row.revoked || row.expires_at <= this.now() || (row.parent_hash && (row.parent_revoked !== 0 || row.parent_expiry <= this.now()))) fail(401, "unauthenticated", "Session or key expired or revoked");
    if (roomId && row.room_id !== roomId) fail(403, "access_denied", "This credential does not grant access to that room");
    const members = this.room(row.room_id).state.members;
    const member = Object.hasOwn(members, row.member_id) && members[row.member_id];
    if (!member || member.active === false) fail(403, "access_denied", "Room membership is inactive");
    return { member, roomId: row.room_id, credentialHash: row.hash, kind: row.kind, expiresAt: row.expires_at, csrf: row.kind === "session" ? hash(`csrf:${token}`) : null };
  }
  createSession(accessKey) {
    return this.transaction(() => {
      const auth = this.authenticate(accessKey);
      if (auth.kind !== "access" || auth.member.kind !== "human") fail(403, "access_denied", "Browser sessions require a human access key");
      const token = this.insertCredential(auth.roomId, auth.member.id, "session", auth.credentialHash, Math.min(auth.expiresAt, this.now() + 8 * 3600000));
      return { token, session: this.authenticate(token) };
    });
  }
  revoke(token) { this.db.prepare("UPDATE credentials SET revoked=1 WHERE hash=?").run(hash(token)); }
  snapshot(token, roomId) {
    // One read transaction keeps sequence, projection, and audit tail at the same commit.
    return this.transaction(() => {
      const auth = this.authenticate(token, roomId);
      const room = this.room(roomId);
      const rows = this.db.prepare("SELECT body FROM events WHERE room_id=? ORDER BY sequence DESC LIMIT 100").all(roomId);
      const cursor = this.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get(roomId, auth.member.id)?.sequence ?? 0;
      return { ...room, state: { ...room.state, eventLog: rows.reverse().map(r => JSON.parse(r.body)) }, cursor, viewerId: auth.member.id };
    });
  }
  eventsAfter(token, roomId, after = 0, limit = 100) {
    this.authenticate(token, roomId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(422, "invalid_cursor", "Invalid event cursor or limit");
    const sequence = this.room(roomId).sequence;
    if (after > sequence) fail(409, "cursor_ahead", "Cursor exceeds room history; fetch a fresh snapshot");
    const events = this.db.prepare("SELECT sequence,body FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(roomId, after, limit).map(r => ({ sequence: r.sequence, event: JSON.parse(r.body) }));
    const next = events.at(-1)?.sequence ?? after;
    return { events, next, hasMore: next < sequence };
  }
  markCaughtUp(token, roomId, sequence) {
    return this.transaction(() => {
      const auth = this.authenticate(token, roomId);
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > this.room(roomId).sequence) fail(422, "invalid_cursor", "Invalid caught-up cursor");
      this.db.prepare("INSERT INTO cursors VALUES(?,?,?) ON CONFLICT(room_id,member_id) DO UPDATE SET sequence=max(cursors.sequence,excluded.sequence)").run(roomId, auth.member.id, sequence);
      return { cursor: this.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get(roomId, auth.member.id).sequence };
    });
  }
  command(token, roomId, command) {
    validateCommand(command);
    return this.transaction(() => {
      const auth = this.authenticate(token, roomId);
      const fingerprint = hash(canonical(command));
      const prior = this.db.prepare("SELECT c.fingerprint,e.sequence,e.body FROM commands c JOIN events e ON e.room_id=c.room_id AND e.sequence=c.sequence WHERE c.room_id=? AND c.actor_id=? AND c.id=?").get(roomId, auth.member.id, command.id);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail(409, "idempotency_conflict", "Command ID already used for different content");
        return { sequence: prior.sequence, event: JSON.parse(prior.body), duplicate: true };
      }
      if (command.causationId && !this.db.prepare("SELECT 1 FROM events WHERE room_id=? AND id=?").get(roomId, command.causationId)) fail(422, "invalid_cause", "Causation event must exist in this room");
      const room = this.room(roomId);
      if (room.sequence >= 10000 || (command.type === T.MEMBER_ADDED && Object.keys(room.state.members).length >= 100) || (command.type === T.WORK_PROPOSED && Object.keys(room.state.workItems).length >= 500)) fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
      const incoming = event({ type: command.type, roomId, actorId: auth.member.id, at: new Date(this.now()).toISOString(), idempotencyKey: hash(`${auth.member.id}:${command.id}`), causationId: command.causationId, data: command.data });
      let state;
      try { state = compact(applyEvent(room.state, incoming)); }
      catch (error) { fail(/Stale|already exists|Invalid transition/.test(error.message) ? 409 : 422, "command_rejected", error.message); }
      const projection = JSON.stringify(state);
      if (Buffer.byteLength(projection) > 4 * 1024 * 1024) fail(409, "pilot_limit", "Room projection limit reached; no data was changed");
      const sequence = room.sequence + 1;
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
      this.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?)").run(roomId, auth.member.id, command.id, fingerprint, sequence);
      this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
      if (command.type === T.MEMBER_ACCESS_CHANGED && command.data.active === false) this.db.prepare("UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id=?").run(roomId, command.data.memberId);
      return { sequence, event: incoming, duplicate: false };
    });
  }
}
