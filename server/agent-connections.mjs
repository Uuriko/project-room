import { createHash } from "node:crypto";
import { EVENT_TYPES as T, validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const access = Object.freeze({ chat: [], contribute: ["accept_work", "complete_work"], review: ["verify"] });
// Standing permission profiles shared by owner sponsorship and agent invite
// codes. Names map server-side to fixed permission sets, so a request can
// never widen authority by renaming or editing a profile.
export const agentAccessProfiles = access;
const tables = `
CREATE TABLE agent_connections (
  room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>0), status TEXT NOT NULL CHECK(status IN ('issued','disconnected')),
  credential_hash TEXT NOT NULL REFERENCES credentials(hash), expires_at INTEGER NOT NULL,
  sponsor_account_id TEXT NOT NULL REFERENCES accounts(id), sponsor_member_id TEXT NOT NULL,
  sponsor_auth_epoch INTEGER NOT NULL, sponsor_member_revision INTEGER NOT NULL, member_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(room_id,member_id)
);
CREATE TABLE agent_connection_operations (
  room_id TEXT NOT NULL, member_id TEXT NOT NULL, generation INTEGER NOT NULL,
  actor_account_id TEXT NOT NULL REFERENCES accounts(id), request_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)), fingerprint TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  PRIMARY KEY(room_id,actor_account_id,request_id), UNIQUE(room_id,member_id,generation),
  FOREIGN KEY(room_id,member_id) REFERENCES agent_connections(room_id,member_id)
);`;
const guards = [
  ["agent_connection_scope_immutable", "BEFORE UPDATE OF room_id,member_id,created_at ON agent_connections", "connection identity is immutable"],
  ["agent_connection_final", "BEFORE UPDATE ON agent_connections WHEN OLD.status='disconnected'", "disconnection is final"],
  ["agent_connections_no_delete", "BEFORE DELETE ON agent_connections", "connection history is retained"],
  ["agent_connection_operations_no_update", "BEFORE UPDATE ON agent_connection_operations", "connection history is immutable"],
  ["agent_connection_operations_no_delete", "BEFORE DELETE ON agent_connection_operations", "connection history is retained"]
].map(([name, clause, message]) => ({ name, sql: `CREATE TRIGGER ${name} ${clause} BEGIN SELECT RAISE(ABORT,'${message}'); END` }));
export const agentConnectionSchema = tables + guards.map(({ sql }) => sql + ";").join("\n");

// Explicit owner grants only. Enrollment never runs a provider or verifies a
// vendor identity. Creation accepts a digest, never the client's private key.
export class AgentConnections {
  constructor(store) { this.store = store; this.db = store.db; }
  row(roomId, memberId) { return this.db.prepare("SELECT * FROM agent_connections WHERE room_id=? AND member_id=?").get(roomId, memberId); }
  owner(token, roomId, binding) {
    const auth = this.store.authenticate(token, roomId, binding);
    if (!auth.account || auth.kind !== "session" || auth.member.kind !== "human"
      || auth.member.id !== this.store.room(roomId).state.room.ownerId || !auth.member.permissions.includes("manage_members")) {
      fail(403, "owner_required", "Only the signed-in room owner can manage agent connections");
    }
    return auth;
  }
  authority(row) {
    const room = this.store.roomAuthority(row.room_id);
    const sponsor = room.members[row.sponsor_member_id], member = room.members[row.member_id];
    const account = this.db.prepare("SELECT active,auth_epoch FROM accounts WHERE id=?").get(row.sponsor_account_id);
    const binding = this.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(row.room_id, row.sponsor_member_id);
    if (!sponsor || sponsor.kind !== "human" || sponsor.active === false || sponsor.id !== room.ownerId
      || sponsor.revision !== row.sponsor_member_revision || !sponsor.permissions.includes("manage_members")
      || account?.active !== 1 || account.auth_epoch !== row.sponsor_auth_epoch || binding?.account_id !== row.sponsor_account_id
      || !member || member.kind !== "agent" || member.active === false || member.revision !== row.member_revision) return false;
    this.store.verifyInvitedMembership(row.room_id, sponsor);
    return true;
  }
  view(row) {
    const member = this.store.room(row.room_id).state.members[row.member_id];
    const credential = this.db.prepare("SELECT revoked FROM credentials WHERE hash=?").get(row.credential_hash);
    const status = row.status === "disconnected" ? "disconnected" : row.expires_at <= this.store.now() ? "expired"
      : !this.authority(row) ? "access_changed" : credential?.revoked !== 0 ? "revoked" : "key_issued";
    const first = this.db.prepare(`SELECT e.body AS body FROM commands c JOIN events e ON e.room_id=c.room_id AND e.sequence=c.sequence
      WHERE c.room_id=? AND c.actor_id=? ORDER BY c.sequence LIMIT 1`).get(row.room_id, row.member_id);
    let firstActionAt = null;
    if (first) {
      try {
        const at = JSON.parse(first.body)?.at;
        if (typeof at === "string" && !Number.isNaN(Date.parse(at))) firstActionAt = at;
      } catch { /* retained history stays unreadable here; the list still renders */ }
    }
    return { roomId: row.room_id, memberId: row.member_id, displayName: member.displayName, generation: row.generation,
      memberRevision: member.revision, permissions: member.permissions, expiresAt: row.expires_at, status, firstActionAt };
  }
  assertCredential(credential) {
    const row = this.row(credential.room_id, credential.member_id);
    if (row && (row.status !== "issued" || row.credential_hash !== credential.hash || credential.kind !== "access"
      || credential.parent_hash !== null || !this.authority(row))) fail(401, "unauthenticated", "Agent access ended; ask the owner to reconnect");
  }
  revokeMember(roomId, memberId) {
    this.db.prepare(`UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id IN
      (SELECT member_id FROM agent_connections WHERE room_id=? AND (member_id=? OR sponsor_member_id=?))`).run(roomId, roomId, memberId, memberId);
  }
  revokeAccount(accountId) {
    this.db.prepare("UPDATE credentials SET revoked=1 WHERE hash IN (SELECT credential_hash FROM agent_connections WHERE sponsor_account_id=?)").run(accountId);
  }
  list(token, roomId, binding) {
    return this.store.readTransaction(() => {
      this.owner(token, roomId, binding);
      return { connections: this.db.prepare("SELECT * FROM agent_connections WHERE room_id=? ORDER BY created_at,member_id").all(roomId).map(row => this.view(row)) };
    });
  }
  validate(details) {
    if (!details || Array.isArray(details) || typeof details !== "object") fail(422, "invalid_connection", "Invalid connection request");
    const { action, requestId, memberId, expectedOwnerRevision, expectedGeneration, expectedMemberRevision, displayName, access: preset, keyHash, expiresAt } = details;
    const common = ["action", "requestId", "memberId", "expectedOwnerRevision"];
    const fields = action === "create" ? [...common, "displayName", "access", "keyHash", "expiresAt"]
      : [...common, "expectedGeneration", "expectedMemberRevision", ...(action === "rotate" ? ["keyHash", "expiresAt"] : [])];
    if (!["create", "rotate", "disconnect"].includes(action) || Object.keys(details).some(k => !fields.includes(k))
      || !validId(requestId) || !validId(memberId) || !integer(expectedOwnerRevision)
      || (action !== "create" && (!integer(expectedGeneration) || expectedGeneration < 1 || !integer(expectedMemberRevision)))
      || (action !== "disconnect" && (typeof keyHash !== "string" || !/^[0-9a-f]{64}$/.test(keyHash) || !integer(expiresAt)))
      || (action === "create" && (typeof displayName !== "string" || !displayName.trim() || displayName.length > 80
        || /[\u0000-\u001f\u007f]/.test(displayName) || typeof preset !== "string" || !Object.hasOwn(access, preset)))) fail(422, "invalid_connection", "Choose a name, access and expiry");
    // A fixed field order makes request identity independent of JSON key order.
    return Object.fromEntries(fields.map(k => [k, details[k]]));
  }
  apply(token, roomId, details, binding) {
    const request = this.validate(details), requestJSON = JSON.stringify(request), fingerprint = hash(requestJSON);
    return this.store.transaction(() => {
      const auth = this.owner(token, roomId, binding);
      const { action, requestId, memberId, expectedOwnerRevision, expectedGeneration, expectedMemberRevision, keyHash, expiresAt } = request;
      const prior = this.db.prepare("SELECT * FROM agent_connection_operations WHERE room_id=? AND actor_account_id=? AND request_id=?").get(roomId, auth.account.id, requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail(409, "idempotency_conflict", "This request was used for different settings");
        return { receipt: JSON.parse(prior.receipt_json), connection: this.view(this.row(roomId, prior.member_id)), duplicate: true };
      }
      let now = this.store.now();
      const before = this.row(roomId, memberId);
      if (expectedOwnerRevision !== auth.member.revision) fail(409, "stale_member_revision", "Your room access changed; refresh first");
      if (action !== "disconnect" && (expiresAt <= now || expiresAt > now + 30 * 86400000 + 3600000)) fail(422, "invalid_expiry", "Choose an expiry within 30 days");
      if (action === "create" ? Boolean(before || this.store.room(roomId).state.members[memberId])
        : !before || before.status === "disconnected" || before.generation !== expectedGeneration
          || this.store.room(roomId).state.members[memberId]?.revision !== expectedMemberRevision) fail(409, "connection_changed", "This connection changed; refresh first");
      if (action === "rotate" && this.store.room(roomId).state.members[memberId].active === false) fail(409, "connection_changed", "This membership ended; create a new connection");
      if (action !== "disconnect" && this.db.prepare("SELECT count(*) n FROM agent_connection_operations WHERE room_id=?").get(roomId).n >= 1000) fail(409, "pilot_limit", "Connection history limit reached");
      if (action !== "disconnect") {
        if (this.db.prepare("SELECT count(*) n FROM credentials WHERE room_id=?").get(roomId).n >= 5000) fail(409, "pilot_limit", "Credential retention limit reached");
        for (const [table, column] of [["credentials", "hash"], ["account_credentials", "hash"], ["account_session_slots", "hash"], ["membership_invitations", "token_hash"], ["share_links", "token_hash"]]) {
          if (this.db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=?`).get(keyHash)) fail(409, "token_conflict", "Generate a new key");
        }
      }
      let membership = null;
      if (action === "create") membership = this.store.command(token, roomId, { id: `agent-${hash(`${auth.account.id}:${requestId}`).slice(0, 40)}`, type: T.MEMBER_ADDED,
        data: { memberId, displayName: request.displayName.trim(), kind: "agent", permissions: access[request.access], accountableHumanId: auth.member.id } }, binding);
      if (action === "disconnect" && this.store.room(roomId).state.members[memberId].active !== false) membership = this.store.command(token, roomId, { id: `agent-${hash(`${auth.account.id}:${requestId}`).slice(0, 40)}`, type: T.MEMBER_ACCESS_CHANGED,
        data: { memberId, expectedMemberRevision, active: false, permissions: this.store.room(roomId).state.members[memberId].permissions } }, binding);
      const member = this.store.room(roomId).state.members[memberId];
      if (membership) now = Date.parse(membership.event.at);
      if (action !== "disconnect" && member.permissions.some(permission => ["manage_members", "decide", "write_external"].includes(permission))) fail(409, "unsupported_agent_scope", "This agent scope needs a separate reviewed connection");
      this.db.prepare("UPDATE credentials SET revoked=1 WHERE room_id=? AND member_id=?").run(roomId, memberId);
      if (action !== "disconnect") this.db.prepare("INSERT INTO credentials(hash,room_id,member_id,kind,parent_hash,expires_at,account_id,account_auth_epoch) VALUES(?,?,?,'access',NULL,?,NULL,NULL)").run(keyHash, roomId, memberId, expiresAt);
      const row = { room_id: roomId, member_id: memberId, generation: (before?.generation ?? 0) + 1,
        status: action === "disconnect" ? "disconnected" : "issued", credential_hash: keyHash ?? before.credential_hash, expires_at: expiresAt ?? before.expires_at,
        sponsor_account_id: auth.account.id, sponsor_member_id: auth.member.id, sponsor_auth_epoch: auth.account.authEpoch,
        sponsor_member_revision: auth.member.revision, member_revision: member.revision, created_at: before?.created_at ?? now, updated_at: now };
      if (before) this.db.prepare(`UPDATE agent_connections SET ${Object.keys(row).filter(k => !["room_id", "member_id", "created_at"].includes(k)).map(k => k + "=?").join(",")} WHERE room_id=? AND member_id=?`)
        .run(...Object.entries(row).filter(([k]) => !["room_id", "member_id", "created_at"].includes(k)).map(([, v]) => v), roomId, memberId);
      else this.db.prepare(`INSERT INTO agent_connections(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
      const receipt = { version: 1, action, requestId, roomId, memberId, generation: row.generation, status: row.status,
        expiresAt: row.expires_at, at: now, membershipEventId: membership?.event.id ?? null, membershipSequence: membership?.sequence ?? null };
      this.db.prepare("INSERT INTO agent_connection_operations VALUES(?,?,?,?,?,?,?,?,?)").run(roomId, memberId, row.generation, auth.account.id, requestId, requestJSON, fingerprint, JSON.stringify(receipt), JSON.stringify(row));
      return { receipt, connection: this.view(row), duplicate: false };
    });
  }
  verify() {
    try { this.verifyHistory(); }
    catch { fail(503, "connection_integrity_error", "Agent connection history requires reconciliation"); }
  }
  verifyHistory() {
    const invalid = () => fail(503, "connection_integrity_error", "Agent connection history requires reconciliation");
    for (const sql of tables.split(";").map(sql => sql.trim()).filter(Boolean)) {
      const name = /^CREATE TABLE (\w+)/.exec(sql)[1];
      if (this.db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'").get(name)?.sql !== sql) invalid();
    }
    for (const { name, sql } of guards) if (this.db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='trigger'").get(name)?.sql !== sql) invalid();
    for (const row of this.db.prepare("SELECT * FROM agent_connections").all()) {
      const operations = this.db.prepare("SELECT * FROM agent_connection_operations WHERE room_id=? AND member_id=? ORDER BY generation").all(row.room_id, row.member_id);
      if (operations.length !== row.generation || !operations.length) invalid();
      let previous = null;
      for (const [index, operation] of operations.entries()) {
        const request = JSON.parse(operation.request_json), receipt = JSON.parse(operation.receipt_json), state = JSON.parse(operation.state_json);
        if (JSON.stringify(this.validate(request)) !== operation.request_json || hash(operation.request_json) !== operation.fingerprint
          || operation.generation !== index + 1 || state.generation !== operation.generation || receipt.generation !== operation.generation
          || request.memberId !== row.member_id || receipt.memberId !== row.member_id || state.member_id !== row.member_id
          || receipt.roomId !== row.room_id || state.room_id !== row.room_id || receipt.requestId !== operation.request_id
          || request.requestId !== operation.request_id || receipt.action !== request.action || receipt.version !== 1
          || state.sponsor_account_id !== operation.actor_account_id || state.sponsor_member_revision !== request.expectedOwnerRevision
          || receipt.at !== state.updated_at || receipt.expiresAt !== state.expires_at || receipt.status !== state.status
          || (index === 0 ? request.action !== "create" || state.created_at !== state.updated_at
            : request.action === "create" || previous.status === "disconnected" || request.expectedGeneration !== previous.generation
              || state.created_at !== previous.created_at)) invalid();
        const room = this.store.room(row.room_id).state, sponsor = room.members[state.sponsor_member_id];
        const account = this.db.prepare("SELECT * FROM accounts WHERE id=?").get(state.sponsor_account_id);
        const binding = this.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(row.room_id, state.sponsor_member_id);
        if (Object.keys(state).sort().join() !== Object.keys(row).sort().join()
          || Object.keys(receipt).sort().join() !== "version,action,requestId,roomId,memberId,generation,status,expiresAt,at,membershipEventId,membershipSequence".split(",").sort().join()
          || ![state.created_at, state.updated_at, state.expires_at, state.sponsor_auth_epoch, state.sponsor_member_revision, state.member_revision].every(integer)
          || state.status !== (request.action === "disconnect" ? "disconnected" : "issued")
          || state.sponsor_member_id !== room.room.ownerId || sponsor?.kind !== "human" || sponsor.revision < state.sponsor_member_revision
          || !account || account.auth_epoch < state.sponsor_auth_epoch || binding?.account_id !== state.sponsor_account_id) invalid();
        const credential = this.db.prepare("SELECT * FROM credentials WHERE hash=?").get(state.credential_hash);
        if (!credential || credential.room_id !== row.room_id || credential.member_id !== row.member_id || credential.kind !== "access"
          || credential.parent_hash !== null || credential.account_id !== null || credential.account_auth_epoch !== null || credential.expires_at !== state.expires_at
          || (request.action !== "disconnect" && (request.keyHash !== state.credential_hash || request.expiresAt !== state.expires_at))
          || (request.action === "disconnect" && (credential.revoked !== 1 || state.credential_hash !== previous.credential_hash))) invalid();
        if (request.action === "rotate" || request.action === "disconnect" && receipt.membershipEventId === null) {
          if (receipt.membershipEventId !== null || receipt.membershipSequence !== null || state.member_revision !== request.expectedMemberRevision) invalid();
          if (request.action === "disconnect" && !this.db.prepare(`SELECT 1 FROM events WHERE room_id=? AND json_extract(body,'$.type')=?
            AND json_extract(body,'$.data.memberId')=? AND json_extract(body,'$.data.expectedMemberRevision')=? AND json_extract(body,'$.data.active')=0`)
            .get(row.room_id, T.MEMBER_ACCESS_CHANGED, row.member_id, state.member_revision - 1)) invalid();
        } else {
          const linked = this.db.prepare("SELECT * FROM events WHERE room_id=? AND id=?").get(row.room_id, receipt.membershipEventId);
          const event = linked && JSON.parse(linked.body);
          if (!event || linked.sequence !== receipt.membershipSequence || event.actorId !== state.sponsor_member_id || event.data.memberId !== row.member_id
            || Date.parse(event.at) !== receipt.at || event.type !== (request.action === "create" ? T.MEMBER_ADDED : T.MEMBER_ACCESS_CHANGED)
            || (request.action === "create" ? event.data.kind !== "agent" || event.data.accountableHumanId !== state.sponsor_member_id
              || event.data.displayName !== request.displayName.trim() || JSON.stringify(event.data.permissions) !== JSON.stringify(access[request.access]) || state.member_revision !== 0
              : event.data.active !== false || event.data.expectedMemberRevision !== request.expectedMemberRevision || state.member_revision !== request.expectedMemberRevision + 1)) invalid();
        }
        if (previous && previous.credential_hash !== state.credential_hash && this.db.prepare("SELECT revoked FROM credentials WHERE hash=?").get(previous.credential_hash)?.revoked !== 1) invalid();
        previous = state;
      }
      if (Object.keys(row).some(k => row[k] !== previous[k])) invalid();
      const member = this.store.room(row.room_id).state.members[row.member_id];
      if (!member || member.kind !== "agent" || member.revision < row.member_revision) invalid();
    }
  }
}
