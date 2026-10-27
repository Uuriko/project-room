import { createHash, randomUUID } from "node:crypto";
import { EVENT_TYPES as T, isRoomArchived, memberCan, validId } from "../src/events.js";
import { isUnpublished } from "./legal-store.mjs";
import { AccessRequests } from "./access-requests.mjs";
import { enforceAutonomyTierForAction } from "./autonomy-tiers.mjs";

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const JOIN_REQUEST_TTL_MS = 7 * 86400000;


// Account identifiers stay private to this table. Notifications use the opaque
// request ID; approval binds a human member without minting an agent identity.
export class AccountJoinRequests {
  constructor(store) { this.store = store; this.db = store.db; }
  view(row, available = undefined) {
    return { requestId: row.request_id, roomId: row.room_id, displayName: row.display_name,
      note: row.note, status: row.status === "pending" ? (row.expires_at <= this.store.now() ? "expired" : (available ?? this.isAvailable(row.room_id)) ? "pending" : "unavailable") : row.status,
      revision: row.revision, createdAt: row.created_at, expiresAt: row.expires_at,
      decidedAt: row.decided_at, memberId: row.member_id, kind: "human_join", requestedPermissions: [] };
  }
  isAvailable(roomId) {
    const row = this.db.prepare("SELECT d.discoverable,r.archived_at FROM rooms r JOIN room_directory_settings d ON d.room_id=r.id WHERE r.id=?").get(roomId);
    return row?.discoverable === 1 && !row.archived_at && !isUnpublished(this.db, "room", roomId);
  }
  available(roomId) {
    if (!this.isAvailable(roomId)) fail(404, "join_unavailable", "This room is not accepting public requests. Use an invitation.");
    return this.store.room(roomId);
  }
  admin(token, roomId, binding, write = false) {
    const auth = this.store.authenticate(token, roomId, binding);
    const scope = write ? "rooms:write" : "rooms:read";
    if (auth.kind === "api-key" && !(auth.apiKeyScopes ?? []).some(s => s === scope || s === "rooms:*")) fail(403, "insufficient_scope", `API key lacks ${scope}`);
    if (!memberCan(this.store.roomAuthority(roomId), auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration required");
    return auth;
  }
  visibility(token, roomId, binding, input = null) {
    return this.store.transaction(() => {
      const auth = this.admin(token, roomId, binding, input !== null);
      const room = this.store.room(roomId);
      if (room.state.room.ownerId !== auth.member.id) fail(403, "owner_only", "Only the room owner can change visibility");
      const current = this.store.roomDirectory.status(roomId, auth.member.id);
      if (input === null) return { roomId, discoverable: current.discoverable };
      if (!input || Object.keys(input).some(k => !["discoverable", "expectedDiscoverable"].includes(k)) || typeof input.discoverable !== "boolean" || typeof input.expectedDiscoverable !== "boolean") fail(422, "invalid_visibility", "Visibility and its current value are required");
      if (isRoomArchived(room.state)) fail(409, "room_archived", "Archived room settings cannot change");
      if (current.discoverable !== input.expectedDiscoverable) fail(409, "visibility_changed", "Visibility changed. Refresh before saving.");
      enforceAutonomyTierForAction({ db: this.db, roomId, state: room.state, actor: auth.member, action: "access-request:approve", fail });
      return this.store.roomDirectory.set(roomId, auth.member.id, input.discoverable);
    });
  }
  request(token, binding, input) {
    return this.store.transaction(() => {
      const auth = this.store.authenticateAccountSession(token, null, binding);
      const { roomId, requestId, displayName, note = "" } = input ?? {};
      if ((!validId(roomId) || roomId.length > 64) || (!idPattern.test(requestId ?? "") || !requestId.startsWith("humanjoin-")) || typeof displayName !== "string" || !displayName.trim() || displayName.length > 80 || typeof note !== "string" || note.length > 1000 || Object.keys(input).some(k => !["roomId", "requestId", "displayName", "note"].includes(k))) fail(422, "invalid_join_request", "Room, request ID and display name are required; note is at most 1000 characters");
      const fingerprint = createHash("sha256").update(JSON.stringify([roomId, displayName.trim(), note.trim()])).digest("hex");
      const prior = this.db.prepare("SELECT * FROM account_join_requests WHERE request_id=?").get(requestId);
      if (prior) {
        if (prior.account_id !== auth.account.id || prior.fingerprint !== fingerprint) fail(409, "idempotency_conflict", "Request ID is already in use");
        return this.view(prior);
      }
      if (this.db.prepare("SELECT 1 FROM access_requests WHERE request_id=?").get(requestId)) fail(409, "idempotency_conflict", "Request ID is already in use");
      this.available(roomId);
      if (this.db.prepare("SELECT 1 FROM member_accounts WHERE room_id=? AND account_id=?").get(roomId, auth.account.id)) fail(409, "membership_exists", "This account already has a room membership. Use the existing membership or ask for an invitation.");
      const now = this.store.now();
      if (this.db.prepare("SELECT 1 FROM account_join_requests WHERE room_id=? AND account_id=? AND status='pending' AND expires_at>? LIMIT 1").get(roomId, auth.account.id, now)) fail(409, "join_pending", "A request for this room is already pending");
      if (this.db.prepare("SELECT COUNT(*) AS n FROM account_join_requests WHERE account_id=? AND created_at>?").get(auth.account.id, now - 86400000).n >= 10) fail(429, "rate_limited", "Wait before requesting more rooms");
      this.db.prepare("INSERT INTO account_join_requests(request_id,room_id,account_id,fingerprint,display_name,note,status,created_at,expires_at) VALUES(?,?,?,?,?,?,'pending',?,?)").run(requestId, roomId, auth.account.id, fingerprint, displayName.trim(), note.trim(), now, now + JOIN_REQUEST_TTL_MS);
      new AccessRequests(this.store).emitAccessRequested(roomId, { requestId, identityId: `human-${requestId}`, displayName: displayName.trim(), requestedPermissions: [], note: note.trim() || null, at: now });
      return this.view(this.db.prepare("SELECT * FROM account_join_requests WHERE request_id=?").get(requestId));
    });
  }
  listOwn(token, binding) {
    const auth = this.store.authenticateAccountSession(token, null, binding);
    return { requests: this.db.prepare("SELECT * FROM account_join_requests WHERE account_id=? ORDER BY created_at DESC,request_id LIMIT 100").all(auth.account.id).map(row => this.view(row)) };
  }
  list(token, roomId, binding, { after = null } = {}) {
    this.admin(token, roomId, binding);
    let cursor = null;
    if (after !== null) {
      if (typeof after !== "string" || after.length > 384) fail(422, "invalid_join_cursor", "Invalid request cursor");
      try { cursor = JSON.parse(Buffer.from(after, "base64url").toString()); } catch { fail(422, "invalid_join_cursor", "Invalid request cursor"); }
      if (!Array.isArray(cursor) || cursor.length !== 2 || !Number.isSafeInteger(cursor[0]) || !idPattern.test(cursor[1] ?? "")) fail(422, "invalid_join_cursor", "Invalid request cursor");
    }
    const rows = this.db.prepare("SELECT * FROM account_join_requests WHERE room_id=? AND status='pending' AND expires_at>?" + (cursor ? " AND (created_at>? OR (created_at=? AND request_id>?))" : "") + " ORDER BY created_at,request_id LIMIT 101").all(roomId, this.store.now(), ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []));
    const page = rows.slice(0, 100), last = page.at(-1);
    const available = this.isAvailable(roomId);
    return { roomId, requests: page.map(row => this.view(row, available)), nextCursor: rows.length > 100 ? Buffer.from(JSON.stringify([last.created_at, last.request_id])).toString("base64url") : null };
  }
  cancel(token, binding, requestId, expectedRevision) {
    return this.store.transaction(() => {
      const auth = this.store.authenticateAccountSession(token, null, binding);
      const row = this.db.prepare("SELECT * FROM account_join_requests WHERE request_id=? AND account_id=?").get(requestId, auth.account.id);
      if (!row) fail(404, "join_request_not_found", "Request not found");
      if (row.status === "cancelled" && row.revision === expectedRevision + 1) return this.view(row);
      this.pending(row, expectedRevision);
      this.db.prepare("UPDATE account_join_requests SET status='cancelled',revision=revision+1,decided_at=? WHERE request_id=?").run(this.store.now(), requestId);
      return this.view(this.db.prepare("SELECT * FROM account_join_requests WHERE request_id=?").get(requestId));
    });
  }
  pending(row, revision) {
    if (!Number.isSafeInteger(revision) || revision !== row.revision || (row.status !== "pending" || row.expires_at <= this.store.now())) fail(409, "join_request_changed", "Request changed. Refresh before deciding.");
  }
  decide(token, roomId, binding, requestId, { decision, expectedRevision } = {}) {
    return this.store.transaction(() => {
      const auth = this.admin(token, roomId, binding, true);
      const row = this.db.prepare("SELECT * FROM account_join_requests WHERE request_id=? AND room_id=?").get(requestId, roomId);
      if (!row) fail(404, "join_request_not_found", "Request not found");
      if (!["approve", "deny"].includes(decision)) fail(422, "invalid_join_decision", "Choose approve or deny");
      enforceAutonomyTierForAction({ db: this.db, roomId, state: this.store.room(roomId).state, actor: auth.member, action: "access-request:approve", fail });
      const status = decision === "approve" ? "approved" : "denied";
      if (row.status === status && row.revision === expectedRevision + 1) return this.view(row);
      this.pending(row, expectedRevision);
      if (decision === "approve") this.available(roomId);
      let memberId = null;
      if (decision === "approve") {
        const account = this.store.account(row.account_id);
        if (!account?.active) fail(409, "requester_unavailable", "The requester account is no longer active");
        if (this.db.prepare("SELECT 1 FROM member_accounts WHERE room_id=? AND account_id=?").get(roomId, row.account_id)) fail(409, "membership_exists", "The account membership changed. Refresh before deciding.");
        memberId = `human-${randomUUID()}`;
        this.store.command(token, roomId, { id: `human-join-${requestId}`, type: T.MEMBER_ADDED,
          data: { memberId, displayName: row.display_name, kind: "human", permissions: [] } }, binding);
        this.store.ensureHumanAccountBinding(roomId, memberId, row.account_id, `join-request:${requestId}`);
      }
      this.db.prepare("UPDATE account_join_requests SET status=?,revision=revision+1,decided_at=?,decided_by=?,member_id=? WHERE request_id=?").run(status, this.store.now(), auth.member.id, memberId, requestId);
      return this.view(this.db.prepare("SELECT * FROM account_join_requests WHERE request_id=?").get(requestId));
    });
  }
}
