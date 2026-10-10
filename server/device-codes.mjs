// HS2 1b — device-code agent connect (fixwave GUILD B1).
//
// A headless agent that cannot paste a secret enrolls like this:
//   1. The agent (holding its identity's pri_ secret) calls POST
//      /api/device-codes and gets a short ABCD-EFGH code plus an
//      /approve/<code> URL. It prints the link + code — never a secret.
//   2. The agent polls GET /api/device-codes/<code>/status.
//   3. A human opens the link on their phone, checks that the code on the
//      page matches what the agent displayed (anti-phishing: an attacker
//      who swaps the link cannot make the page show the agent's code),
//      and taps Approve (or Deny).
//   4. Approval binds the identity into the room under the approver's
//      authority, through the reviewed identities.link() path. The code is
//      consumed atomically: one approval, no replays.
//
// Security properties mirror the identity link-code flow (RC-2026-09-24-210):
// the raw code is returned once and only its SHA-256 hash is stored; codes
// are 40 bits from a 30-symbol unambiguous alphabet with a 10-minute TTL;
// every failure to guess a code reads as 404 device_code_not_found so there
// is no oracle; status transitions are conditional on the row still being
// pending, so a concurrent approve/deny that lands first wins.
import { createHash, randomBytes } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { PERMISSIONS } from "../src/events.js";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const hash = value => createHash("sha256").update(value).digest("hex");

export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
// ABCD-EFGH shape: unambiguous Crockford-ish alphabet — no 0/O, 1/I/L, U.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const DEVICE_CODE_RE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const MAX_OUTSTANDING_DEVICE_CODES = 10;
const MAX_PERMISSIONS = 12;

export const deviceCodeSchema = `
  CREATE TABLE IF NOT EXISTS device_codes (
    code_hash TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)),
    status TEXT NOT NULL CHECK(status IN ('pending','approved','denied')) DEFAULT 'pending',
    approved_by_member_id TEXT,
    approved_at INTEGER,
    member_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS device_codes_identity ON device_codes(identity_id, expires_at);
  CREATE INDEX IF NOT EXISTS device_codes_room ON device_codes(room_id, expires_at);
`;

export function ensureDeviceCodeSchema(db) {
  db.exec(deviceCodeSchema);
}

const normalizeCode = code => {
  const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (!DEVICE_CODE_RE.test(normalized)) fail(404, "device_code_not_found", "No such device code");
  return normalized;
};

function mintCode() {
  // 8 symbols from the 30-symbol alphabet via rejection sampling: bytes
  // below 240 reduce mod 30 uniformly, so there is no modulo bias.
  let out = "";
  while (out.length < 8) {
    const buf = randomBytes(16);
    for (const byte of buf) {
      if (out.length === 8) break;
      if (byte < 240) out += CODE_ALPHABET[byte % 30];
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

const rowView = (row, now) => ({
  code: row.code,
  status: row.status === "pending" && row.expiresAt <= now ? "expired" : row.status,
  identityId: row.identityId,
  roomId: row.roomId,
  displayName: row.displayName,
  permissions: JSON.parse(row.permissionsJson),
  expiresAt: row.expiresAt,
  approvedAt: row.approvedAt,
  memberId: row.memberId,
});

export class DeviceCodes {
  constructor(store) { this.store = store; this.db = store.db; }

  lookup(normalized) {
    const row = this.db.prepare(`SELECT code_hash AS codeHash, identity_id AS identityId, room_id AS roomId,
        display_name AS displayName, permissions_json AS permissionsJson, status,
        approved_by_member_id AS approvedByMemberId, approved_at AS approvedAt, member_id AS memberId,
        created_at AS createdAt, expires_at AS expiresAt, consumed_at AS consumedAt
      FROM device_codes WHERE code_hash=?`).get(hash(normalized));
    if (!row) fail(404, "device_code_not_found", "No such device code");
    return { ...row, code: normalized };
  }

  // The agent proves holder possession of its identity secret (the route
  // authenticates it before calling); the issue IS the holder's consent to
  // enroll this identity into the room, pending a human's approval.
  issue({ identityId, roomId, displayName, permissions }) {
    const identity = this.store.identities.get(identityId);
    if (!identity) fail(404, "identity_not_found", "No such agent identity");
    const revoked = this.db.prepare("SELECT revoked_at AS revokedAt FROM agent_identities WHERE identity_id=?").get(identityId);
    if (revoked?.revokedAt !== null) fail(409, "identity_revoked", "This identity is revoked");
    this.store.room(roomId); // 404 room_not_found for unknown rooms
    const perms = permissions ?? ["accept_work", "complete_work"];
    if (!Array.isArray(perms) || perms.length === 0 || perms.length > MAX_PERMISSIONS
      || perms.some(p => typeof p !== "string" || !PERMISSIONS.includes(p))) {
      fail(422, "invalid_permissions", "permissions must be a non-empty array of known room permissions");
    }
    const name = displayName?.trim() || identity.displayName;
    if (typeof name !== "string" || name.length === 0 || name.length > 80) {
      fail(422, "invalid_display_name", "displayName must be text of at most 80 characters");
    }
    return this.store.transaction(() => {
      const now = this.store.now();
      this.db.prepare("DELETE FROM device_codes WHERE expires_at <= ?").run(now);
      const outstanding = this.db.prepare(
        "SELECT count(*) AS n FROM device_codes WHERE identity_id=? AND status='pending'").get(identityId).n;
      if (outstanding >= MAX_OUTSTANDING_DEVICE_CODES) {
        fail(429, "too_many_device_codes", "Too many outstanding device codes; use one or let it expire");
      }
      let code = mintCode();
      // 40-bit space: retry on the (astronomical) hash collision.
      for (let attempts = 0; this.db.prepare("SELECT 1 FROM device_codes WHERE code_hash=?").get(hash(code)); attempts++) {
        if (attempts > 5) fail(500, "device_code_collision", "Could not mint a unique device code");
        code = mintCode();
      }
      this.db.prepare(`INSERT INTO device_codes(code_hash,identity_id,room_id,display_name,permissions_json,
          status,created_at,expires_at) VALUES(?,? ,?,?,?,'pending',?,?)`)
        .run(hash(code), identityId, roomId, name, JSON.stringify([...perms]), now, now + DEVICE_CODE_TTL_MS);
      return { code, identityId, roomId, displayName: name, permissions: [...perms], expiresAt: now + DEVICE_CODE_TTL_MS };
    });
  }

  // The agent's poll. The code itself is the capability; a wrong code is 404.
  // Never consumes: only approve()/deny() consume.
  status(code) {
    const normalized = normalizeCode(code);
    const row = this.lookup(normalized);
    return rowView(row, this.store.now());
  }

  assertApprover(token, roomId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!this.store.delegation.canAdministerMembership(authority, auth, roomId)) {
      fail(403, "access_denied", "Membership administration grant required");
    }
    return auth;
  }

  // The human's approval. Binds the identity into the room through the
  // reviewed identities.link() path under the approver's authority, and
  // consumes the code in the same transaction: approval and bind are one
  // atomic step, so a code can never approve without binding or bind twice.
  approve(token, code, expectedSessionBinding = null) {
    const normalized = normalizeCode(code);
    return this.store.transaction(() => {
      const now = this.store.now();
      const row = this.lookup(normalized);
      if (row.status !== "pending") fail(409, "device_code_consumed", "This device code was already used");
      if (row.expiresAt <= now) fail(410, "device_code_expired", "This device code has expired; have the agent issue a new one");
      const auth = this.assertApprover(token, row.roomId, expectedSessionBinding);
      const linked = this.store.identities.link(token, row.roomId, {
        identityId: row.identityId, memberId: row.identityId,
        displayName: row.displayName, permissions: JSON.parse(row.permissionsJson),
      }, expectedSessionBinding);
      const changed = this.db.prepare(`UPDATE device_codes SET status='approved',
          approved_by_member_id=?, approved_at=?, member_id=?, consumed_at=?
        WHERE code_hash=? AND status='pending'`)
        .run(auth.member.id, now, linked.memberId, now, hash(normalized));
      if (changed.changes !== 1) fail(409, "device_code_consumed", "This device code was already used");
      return { code: normalized, status: "approved", identityId: row.identityId,
        roomId: row.roomId, memberId: linked.memberId, approvedBy: auth.member.id, approvedAt: now };
    });
  }

  // The human's refusal. Consumes the code; the identity is never bound.
  deny(token, code, expectedSessionBinding = null) {
    const normalized = normalizeCode(code);
    return this.store.transaction(() => {
      const now = this.store.now();
      const row = this.lookup(normalized);
      if (row.status !== "pending") fail(409, "device_code_consumed", "This device code was already used");
      if (row.expiresAt <= now) fail(410, "device_code_expired", "This device code has expired");
      const auth = this.assertApprover(token, row.roomId, expectedSessionBinding);
      const changed = this.db.prepare(`UPDATE device_codes SET status='denied',
          approved_by_member_id=?, approved_at=?, consumed_at=?
        WHERE code_hash=? AND status='pending'`)
        .run(auth.member.id, now, now, hash(normalized));
      if (changed.changes !== 1) fail(409, "device_code_consumed", "This device code was already used");
      return { code: normalized, status: "denied", identityId: row.identityId, roomId: row.roomId, deniedBy: auth.member.id };
    });
  }
}
