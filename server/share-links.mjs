import { createHash, randomBytes, randomUUID } from "node:crypto";
import { applyEvent, validId, INVITATION_ROLE_POLICY_VERSION } from "../src/events.js";
import { invitationJoinedEvent } from "./invitation-evidence.mjs";
import { canonicalInvitationData } from "./invitation-journal.mjs";
import { ServiceError } from "./store.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const unavailable = () => fail(410, "link_unavailable", "This link has expired, been cancelled, or reached its join limit. Ask for a new link.");
export const shareLinkSchema = `
  CREATE TABLE IF NOT EXISTS share_links (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
    room_id TEXT NOT NULL REFERENCES rooms(id), issuer_account_id TEXT NOT NULL REFERENCES accounts(id),
    issuer_member_id TEXT NOT NULL, issuer_auth_epoch INTEGER NOT NULL, issuer_member_revision INTEGER NOT NULL,
    request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL CHECK(expires_at>created_at), max_joins INTEGER NOT NULL CHECK(max_joins BETWEEN 1 AND 25),
    revoked_at INTEGER, revoked_by_member_id TEXT,
    CHECK((revoked_at IS NULL AND revoked_by_member_id IS NULL) OR (revoked_at IS NOT NULL AND revoked_by_member_id IS NOT NULL)),
    UNIQUE(room_id,issuer_account_id,request_id)
  );
  CREATE INDEX IF NOT EXISTS share_links_room ON share_links(room_id,created_at);
  CREATE TABLE IF NOT EXISTS share_link_joins (
    link_id TEXT NOT NULL REFERENCES share_links(id), invitation_id TEXT NOT NULL UNIQUE REFERENCES membership_invitations(id),
    slot_hash TEXT NOT NULL REFERENCES account_session_slots(hash), redemption_id TEXT NOT NULL,
    session_revision INTEGER NOT NULL, fingerprint TEXT NOT NULL,
    PRIMARY KEY(link_id,slot_hash,redemption_id)
  );
  CREATE TRIGGER IF NOT EXISTS share_link_scope_immutable BEFORE UPDATE OF id,token_hash,room_id,issuer_account_id,issuer_member_id,issuer_auth_epoch,issuer_member_revision,request_id,fingerprint,created_at,expires_at,max_joins ON share_links BEGIN SELECT RAISE(ABORT,'link scope is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS share_link_revocation_final BEFORE UPDATE ON share_links WHEN OLD.revoked_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'link cancellation is final'); END;
  CREATE TRIGGER IF NOT EXISTS share_links_no_delete BEFORE DELETE ON share_links BEGIN SELECT RAISE(ABORT,'link history is retained'); END;
  CREATE TRIGGER IF NOT EXISTS share_link_joins_no_update BEFORE UPDATE ON share_link_joins BEGIN SELECT RAISE(ABORT,'join history is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS share_link_joins_no_delete BEFORE DELETE ON share_link_joins BEGIN SELECT RAISE(ABORT,'join history is retained'); END;
`;

// Reusable links delegate only the existing, immutable guest invitation policy.
// Each redemption creates an ordinary audited account-bound invitation and its
// acceptance in ONE transaction. Existing targeted invitations stay unchanged.
export class ShareLinks {
  constructor(store) { this.store = store; this.db = store.db; }
  administrator(token, roomId, binding) {
    const auth = this.store.authenticate(token, roomId, binding);
    if (!auth.account || auth.member.kind !== "human" || !auth.member.permissions.includes("manage_members")) {
      fail(403, "access_denied", "Only a human room administrator can manage invitation links");
    }
    return auth;
  }
  count(row) { return this.db.prepare("SELECT count(*) n FROM share_link_joins WHERE link_id=?").get(row.id).n; }
  authority(row) {
    const account = this.db.prepare("SELECT active,auth_epoch FROM accounts WHERE id=?").get(row.issuer_account_id);
    const binding = this.db.prepare("SELECT account_id FROM member_accounts WHERE room_id=? AND member_id=?").get(row.room_id, row.issuer_member_id);
    const member = this.store.room(row.room_id).state.members[row.issuer_member_id];
    return account?.active === 1 && account.auth_epoch === row.issuer_auth_epoch && binding?.account_id === row.issuer_account_id
      && member?.active !== false && member?.revision === row.issuer_member_revision && member?.permissions.includes("manage_members");
  }
  view(row) {
    const joins = this.count(row);
    const status = row.revoked_at !== null ? "cancelled" : row.expires_at <= this.store.now() ? "expired"
      : !this.authority(row) ? "authority_changed" : joins >= row.max_joins ? "full" : "active";
    return { id: row.id, roomId: row.room_id, role: "guest", permissions: [], createdAt: row.created_at,
      expiresAt: row.expires_at, maxJoins: row.max_joins, joins, remainingJoins: Math.max(0, row.max_joins - joins), status };
  }
  find(token) {
    if (typeof token !== "string" || !tokenPattern.test(token)) unavailable();
    const row = this.db.prepare("SELECT * FROM share_links WHERE token_hash=?").get(hash(token));
    if (!row) unavailable();
    return row;
  }
  preview(token) {
    return this.store.readTransaction(() => {
      const row = this.find(token), link = this.view(row);
      if (link.status !== "active") unavailable();
      return { link, room: { id: row.room_id, title: this.store.room(row.room_id).state.room.title },
        access: "Read the room and its history, post messages, and react. No membership administration or work approvals.",
        identity: "Names are self-chosen, not verified. New guest sessions last up to 8 hours in this browser." };
    });
  }
  list(token, roomId, binding) {
    return this.store.readTransaction(() => {
      this.administrator(token, roomId, binding);
      return { links: this.db.prepare("SELECT * FROM share_links WHERE room_id=? ORDER BY created_at DESC,id DESC").all(roomId).map(row => this.view(row)) };
    });
  }
  create(token, roomId, details, binding) {
    const { requestId, linkToken, expiresAt, maxJoins, expectedMemberRevision } = details;
    if (!validId(requestId) || typeof linkToken !== "string" || !tokenPattern.test(linkToken)
      || !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(maxJoins) || maxJoins < 1 || maxJoins > 25
      || !Number.isSafeInteger(expectedMemberRevision) || expectedMemberRevision < 0) {
      fail(422, "invalid_link", "Choose a join limit between 1 and 25 and a current room membership");
    }
    return this.store.transaction(() => {
      const auth = this.administrator(token, roomId, binding), tokenHash = hash(linkToken);
      const fingerprint = hash(JSON.stringify([tokenHash, expiresAt, maxJoins, expectedMemberRevision]));
      const prior = this.db.prepare("SELECT * FROM share_links WHERE room_id=? AND issuer_account_id=? AND request_id=?").get(roomId, auth.account.id, requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) fail(409, "idempotency_conflict", "This request was already used for different link settings");
        return { link: this.view(prior), duplicate: true };
      }
      const now = this.store.now();
      if (expiresAt <= now || expiresAt > now + 7 * 86400000) fail(422, "invalid_expiry", "Choose an expiry within seven days");
      if (expectedMemberRevision !== auth.member.revision) fail(409, "stale_member_revision", "Your room permissions changed; refresh before creating a link");
      if (this.db.prepare("SELECT count(*) n FROM share_links WHERE room_id=?").get(roomId).n >= 200) fail(409, "pilot_limit", "Room link retention limit reached");
      for (const table of ["credentials", "account_credentials", "account_session_slots"]) {
        if (this.db.prepare(`SELECT 1 FROM ${table} WHERE hash=?`).get(tokenHash)) fail(409, "token_conflict", "Generate a new link");
      }
      for (const table of ["membership_invitations", "share_links"]) {
        if (this.db.prepare(`SELECT 1 FROM ${table} WHERE token_hash=?`).get(tokenHash)) fail(409, "token_conflict", "Generate a new link");
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO share_links(id,token_hash,room_id,issuer_account_id,issuer_member_id,issuer_auth_epoch,issuer_member_revision,request_id,fingerprint,created_at,expires_at,max_joins)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, tokenHash, roomId, auth.account.id, auth.member.id, auth.account.authEpoch, auth.member.revision, requestId, fingerprint, now, expiresAt, maxJoins);
      return { link: this.view(this.db.prepare("SELECT * FROM share_links WHERE id=?").get(id)), duplicate: false };
    });
  }
  cancel(token, roomId, id, binding) {
    if (!validId(id)) unavailable();
    return this.store.transaction(() => {
      const auth = this.administrator(token, roomId, binding);
      const row = this.db.prepare("SELECT * FROM share_links WHERE id=? AND room_id=?").get(id, roomId);
      if (!row) unavailable();
      if (row.revoked_at === null) this.db.prepare("UPDATE share_links SET revoked_at=?,revoked_by_member_id=? WHERE id=? AND revoked_at IS NULL").run(this.store.now(), auth.member.id, id);
      return { link: this.view(this.db.prepare("SELECT * FROM share_links WHERE id=?").get(id)) };
    });
  }
  join(slotToken, linkToken, { displayName, redemptionId, expectedSessionRevision, expectedSessionBinding, revokeRoomToken = null }) {
    if (typeof displayName !== "string" || !displayName.trim() || displayName.length > 80 || /[\u0000-\u001f\u007f]/.test(displayName)
      || typeof redemptionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(redemptionId)
      || !Number.isSafeInteger(expectedSessionRevision)) fail(422, "invalid_join", "Enter a name of 1–80 characters and try joining again");
    return this.store.transaction(() => {
      const slot = this.store.accountSessionSlot(slotToken);
      if (slot.sessionRevision !== expectedSessionRevision || slot.sessionBinding !== expectedSessionBinding) fail(409, "session_binding_changed", "Your browser identity changed. Review the invitation again.");
      const row = this.find(linkToken), fingerprint = hash(displayName.trim());
      let auth = null;
      try { auth = this.store.authenticateAccountSession(slotToken); }
      catch (error) { if (error.status !== 401) throw error; }
      const prior = this.db.prepare("SELECT j.*,i.intended_account_id FROM share_link_joins j JOIN membership_invitations i ON i.id=j.invitation_id WHERE j.link_id=? AND j.slot_hash=? AND j.redemption_id=?")
        .get(row.id, slot.credentialHash, redemptionId);
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.session_revision !== slot.sessionRevision || prior.intended_account_id !== auth?.account.id) fail(409, "join_changed", "This join belongs to an earlier browser identity or name");
        this.verifyJoin(prior);
        return this.result(slotToken, row.room_id, true);
      }
      if (this.view(row).status !== "active") unavailable();
      if (!auth && revokeRoomToken) {
        let existingRoom = null;
        try { existingRoom = this.store.authenticate(revokeRoomToken, row.room_id, null, { allowAccountSession: false }); }
        catch (error) { if (![401, 403].includes(error.status)) throw error; }
        if (existingRoom?.kind === "session" && existingRoom.member.kind === "human") {
          return { roomId: row.room_id, duplicate: true, roomMode: true, session: this.store.sessionOwnership(existingRoom) };
        }
      }
      if (auth && this.db.prepare("SELECT 1 FROM member_accounts WHERE room_id=? AND account_id=?").get(row.room_id, auth.account.id)) {
        return this.result(slotToken, row.room_id, true); // Never recreate a removed membership.
      }
      const room = this.store.room(row.room_id), now = this.store.now();
      if (room.sequence >= 10000 || Object.keys(room.state.members).length >= 100) fail(409, "pilot_limit", "This room is full; ask its owner for help");
      if (!auth) {
        // An expired/revoked prior identity needs an explicit sign-out before a
        // fresh guest can be created. A link is never recovery for another account.
        if (this.db.prepare("SELECT account_id FROM account_session_slots WHERE hash=?").get(slot.credentialHash).account_id !== null) {
          fail(409, "guest_session_ended", "Your previous browser identity expired. Sign out before joining as a new guest.");
        }
        const account = this.store.createAccount(`guest-${randomUUID()}`, "share-link-guest");
        const accessKey = this.store.insertAccountCredential(account.id, now + 8 * 3600000);
        auth = this.store.loginAccountSession(slotToken, accessKey, expectedSessionRevision, { revokeRoomToken });
      }
      const invitationId = randomUUID(), memberId = `guest-${randomUUID()}`;
      const privateTokenHash = hash(randomBytes(32).toString("base64url"));
      const issueFingerprint = hash(canonicalInvitationData({ roomId: row.room_id, requestId: `link-${invitationId}`, tokenHash: privateTokenHash,
        intendedAccountId: auth.account.id, intendedMemberId: memberId, displayName: displayName.trim(), role: "guest", permissions: [],
        expiresAt: row.expires_at, expectedIssuerMemberRevision: row.issuer_member_revision }));
      // Scope is copied from the link, never supplied by the joining browser.
      this.db.prepare(`INSERT INTO membership_invitations(id,token_hash,room_id,intended_account_id,intended_member_id,intended_display_name,intended_role,intended_permissions_json,role_policy_version,
        issuer_account_id,issuer_member_id,issuer_account_auth_epoch,issuer_member_revision,issue_request_id,issue_fingerprint,revision,status,created_at,expires_at)
        VALUES(?,?,?,?,?,?,'guest','[]',?,?,?,?,?,?,?,0,'pending',?,?)`).run(invitationId, privateTokenHash, row.room_id, auth.account.id, memberId, displayName.trim(), INVITATION_ROLE_POLICY_VERSION,
          row.issuer_account_id, row.issuer_member_id, row.issuer_auth_epoch, row.issuer_member_revision, `link-${invitationId}`, issueFingerprint, now, row.expires_at);
      // Revision zero is the legacy audit envelope's neutral value for this
      // delegated issuance, NOT evidence of an interactive issuer account login.
      // The private share_link_joins record identifies the actual authority source.
      this.db.prepare(`INSERT INTO membership_invitation_events(invitation_id,sequence,type,actor_account_id,actor_member_id,actor_auth_epoch,actor_session_revision,invitation_revision,at,room_event_id,reason)
        VALUES(?,1,'issued',?,?,?,0,0,?,NULL,NULL)`).run(invitationId, row.issuer_account_id, row.issuer_member_id, row.issuer_auth_epoch, now);
      let record = this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(invitationId);
      this.store.appendInvitationJournal(record, "issued");
      const incoming = invitationJoinedEvent({ ...record, joined_event_id: randomUUID(), accepted_at: now, redemption_id: redemptionId });
      const state = { ...applyEvent(room.state, incoming), eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
      const projection = JSON.stringify(state), sequence = room.sequence + 1;
      if (Buffer.byteLength(projection) > 4 * 1024 * 1024) fail(409, "pilot_limit", "This room has reached its storage limit");
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(row.room_id, sequence, incoming.id, JSON.stringify(incoming));
      this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, row.room_id);
      this.db.prepare("INSERT INTO member_accounts(room_id,member_id,account_id,origin) VALUES(?,?,?,?)").run(row.room_id, memberId, auth.account.id, `invitation:${invitationId}`);
      this.db.prepare("UPDATE membership_invitations SET revision=1,status='accepted',accepted_at=?,accepted_by_account_id=?,redemption_id=?,joined_event_id=? WHERE id=?").run(now, auth.account.id, redemptionId, incoming.id, invitationId);
      this.db.prepare(`INSERT INTO membership_invitation_events(invitation_id,sequence,type,actor_account_id,actor_member_id,actor_auth_epoch,actor_session_revision,invitation_revision,at,room_event_id,reason)
        VALUES(?,2,'accepted',?,?,?,?,1,?,?,NULL)`).run(invitationId, auth.account.id, memberId, auth.account.authEpoch, auth.sessionRevision, now, incoming.id);
      record = this.db.prepare("SELECT * FROM membership_invitations WHERE id=?").get(invitationId);
      this.store.appendInvitationJournal(record, "accepted");
      this.db.prepare("INSERT INTO share_link_joins VALUES(?,?,?,?,?,?)").run(row.id, invitationId, slot.credentialHash, redemptionId, auth.sessionRevision, fingerprint);
      this.verifyJoin({ link_id: row.id, invitation_id: invitationId, fingerprint });
      return this.result(slotToken, row.room_id, false);
    });
  }
  result(slotToken, roomId, duplicate) {
    const auth = this.store.authenticateAccountSession(slotToken, roomId);
    return { roomId, duplicate, session: this.store.sessionOwnership(auth) };
  }
  verifyJoin(join) {
    const link = this.db.prepare("SELECT * FROM share_links WHERE id=?").get(join.link_id);
    const { record } = this.store.verifyInvitationRecord(join.invitation_id);
    if (!link || record.status !== "accepted" || record.room_id !== link.room_id || record.issuer_account_id !== link.issuer_account_id
      || record.issuer_member_id !== link.issuer_member_id || record.issuer_account_auth_epoch !== link.issuer_auth_epoch
      || record.issuer_member_revision !== link.issuer_member_revision || record.intended_role !== "guest" || record.intended_permissions_json !== "[]"
      || record.expires_at !== link.expires_at || record.accepted_at < link.created_at || record.accepted_at >= link.expires_at
      || (link.revoked_at !== null && record.accepted_at > link.revoked_at) || join.fingerprint !== hash(record.intended_display_name)) {
      fail(503, "link_integrity_error", "Invitation link history requires operator reconciliation");
    }
  }
  verify() {
    for (const row of this.db.prepare("SELECT * FROM share_links").all()) {
      if (this.count(row) > row.max_joins) fail(503, "link_integrity_error", "Invitation link usage requires operator reconciliation");
    }
    for (const join of this.db.prepare("SELECT * FROM share_link_joins").all()) this.verifyJoin(join);
  }
}
