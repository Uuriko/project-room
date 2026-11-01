// Device-code pairing for agents that can fetch a URL, plus reconnect-by-key
// and owner merge of two agent members. The pairs table stores only scrypt
// hashes of every credential it handles: the user code, the device secret,
// the issued room token, the identity secret and a held device secret
// (T2-L10c-C1; the authoritative credential stores — credentials and
// agent_identities — are hash-only too). Rows written before that fix may
// still carry plaintext values and are dual-read: legacy plaintext is
// served and verified as before, while a stored hash is never itself a
// usable credential. An approved connection is delivered to the polling
// device from a process-local buffer held only for the replay window,
// never from the database; a restart inside that window ends the delivery
// and the agent re-pairs — unless a delivery key is configured
// (PAIR_DELIVERY_KEY, a base64 32-byte key held in the process
// environment, never in the database): then approval also persists an
// AES-256-GCM sealed copy of the delivery in pair_delivery_sealed,
// bound to the pair id as GCM AAD, and a post-restart poll recovers the
// connection from the sealed record. Without the key, or on any seal
// mismatch, recovery fails closed to expired_token exactly as before.
// Poll errors for a live pair are RFC 8628
// codes (authorization_pending, slow_down, access_denied, expired_token).
import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, randomUUID, scryptSync, timingSafeEqual, verify } from "node:crypto";
import { ServiceError, PILOT_LIMITS } from "./store.mjs";
import { agentAccessProfiles } from "./agent-connections.mjs";
import { isValidPublicKey } from "./agent-card-signing.mjs";
import { applyEventWithGrowth, growthCollector } from "../src/growth-emit.js";
import {
  DISPLAY_NAME_POLICY_VERSION, EVENT_TYPES as T, MEMBERSHIP_AUTHORITY_POLICY_VERSION,
  NEVER_GRANT, canInviteMembers, event, isRoomArchived, ownMember, validId
} from "../src/events.js";
import { assertNotReservedRoleName, checkAgentDisplayName } from "./display-name-guard.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const compactState = state => ({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });

export class PairPollError extends ServiceError {
  constructor(code) {
    super(400, code, code);
    this.rfc8628 = true;
  }
}

export const PAIR_TTL_MS = 10 * 60 * 1000;
export const PAIR_POLL_INTERVAL_MS = 3000;
export const PAIR_REPLAY_MS = 10 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_SALT = "project-room-pair-code-v1";
const DEVICE_SALT = "project-room-pair-device-v1";
const TOKEN_SALT = "project-room-pair-token-v1";
const IDENTITY_SALT = "project-room-pair-identity-v1";
const SCRYPT = { N: 16384, r: 8, p: 1 };
const MAX_PENDING_PER_ROOM = 5;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
const JOIN_MODES = Object.freeze(["approve", "closed", "auto:chat", "auto:contribute", "auto:review", "auto:collaborate"]);

export const pairingSchema = `
  CREATE TABLE IF NOT EXISTS pairs (
    pair_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    user_code_hash TEXT NOT NULL,
    user_code TEXT NOT NULL,
    device_secret_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    public_key TEXT,
    duplicate_member_id TEXT,
    member_id TEXT,
    identity_id TEXT,
    issued_token TEXT,
    identity_secret TEXT,
    hold_secret TEXT,
    starter_identity_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    approved_at INTEGER,
    replay_until INTEGER,
    last_poll_at INTEGER,
    decided_by TEXT
  );
  CREATE TABLE IF NOT EXISTS pair_delivery_sealed (
    pair_id TEXT PRIMARY KEY,
    sealed TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pairs_room_status ON pairs(room_id, status);
  CREATE INDEX IF NOT EXISTS pairs_code ON pairs(user_code_hash);
  CREATE TABLE IF NOT EXISTS pair_code_locks (
    room_id TEXT PRIMARY KEY,
    failures INTEGER NOT NULL,
    locked_until INTEGER
  );
  CREATE TABLE IF NOT EXISTS agent_member_keys (
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, public_key)
  );
  CREATE TABLE IF NOT EXISTS room_join_policy (
    room_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL
  );
`;

const digest = (value, salt) => scryptSync(String(value), salt, 32, SCRYPT);
const digestHex = (value, salt) => digest(value, salt).toString("hex");
const sameDigest = (value, salt, hex) => {
  if (typeof hex !== "string" || hex.length !== 64) return false;
  const got = digest(value, salt);
  const want = Buffer.from(hex, "hex");
  return want.length === got.length && timingSafeEqual(got, want);
};

const canonicalName = value => value.trim().replace(/\p{White_Space}+/gu, " ").toLowerCase();

// Sealed durable delivery (the durable pair-delivery semantics in
// W2-5517-SPEC.md, design Codex seq 25343). The key is read from the
// process environment on every use and is never written to the
// database; without a valid key, sealing is off and recovery is
// impossible, which is exactly the pre-existing buffer-only behaviour.
// The pair id is the GCM AAD, so a sealed record cannot be replayed
// onto a different pair.
const DELIVERY_KEY_ENV = "PAIR_DELIVERY_KEY";
const deliveryKey = () => {
  const raw = process.env[DELIVERY_KEY_ENV];
  if (typeof raw !== "string" || !raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
};

function sealDelivery(key, pairId, payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(pairId, "utf8"));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
}

function unsealDelivery(key, pairId, sealed) {
  try {
    if (typeof sealed !== "string" || !sealed.startsWith("v1.")) return null;
    const parts = sealed.slice(3).split(".");
    if (parts.length !== 3) return null;
    const [iv, tag, ct] = parts.map(part => Buffer.from(part, "base64"));
    if (iv.length !== 12 || tag.length !== 16 || ct.length === 0) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(pairId, "utf8"));
    decipher.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"));
    if (typeof payload?.token !== "string" || typeof payload?.replayUntil !== "number") return null;
    return payload;
  } catch {
    return null;
  }
}

// Dual-read shapes (T2-L10c-C1): a stored credential value is either a
// legacy plaintext value written before the hashes-only fix or a 64-hex
// scrypt digest written after it. The shapes never collide: room tokens
// are 43-char base64url, identity secrets carry a "pri_" prefix, and user
// codes are "XXXX-XXXX".
const HASH_HEX = /^[0-9a-f]{64}$/;
const CODE_FORMAT = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const isHashHex = value => typeof value === "string" && HASH_HEX.test(value);
const legacyCode = value => (typeof value === "string" && CODE_FORMAT.test(value) ? value : null);

export function pairProofBytes(roomId, displayName, publicKey) {
  return Buffer.from(`project-room-pair-v1\n${roomId}\n${String(displayName).trim()}\n${publicKey}`, "utf8");
}

function proofOk(roomId, displayName, publicKey, signature) {
  if (!isValidPublicKey(publicKey) || typeof signature !== "string") return false;
  const sig = Buffer.from(signature, "base64");
  if (sig.length !== 64 || sig.toString("base64") !== signature) return false;
  try {
    const raw = Buffer.from(publicKey, "base64");
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
    return verify(null, pairProofBytes(roomId, displayName, publicKey), key, sig);
  } catch {
    return false;
  }
}

function formatCode(raw) {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function normalizeCode(code) {
  const raw = typeof code === "string" ? code.trim().toUpperCase().replace(/-/g, "") : "";
  if (raw.length !== 8 || [...raw].some(ch => !CODE_ALPHABET.includes(ch))) return null;
  return raw;
}

function drawCode() {
  let raw = "";
  while (raw.length < 8) {
    const byte = randomBytes(1)[0];
    if (byte < CODE_ALPHABET.length * Math.floor(256 / CODE_ALPHABET.length)) raw += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return formatCode(raw);
}

export class Pairing {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.hits = new Map();
    // Approved connections awaiting poll delivery, held only in memory
    // for the replay window (see the header note). Never persisted.
    this.delivery = new Map();
  }

  #rememberDelivery(pairId, token, identitySecret, replayUntil) {
    const now = this.store.now();
    for (const [id, entry] of this.delivery) if (now > entry.replayUntil) this.delivery.delete(id);
    this.delivery.set(pairId, { token, identitySecret: identitySecret ?? null, replayUntil });
    // Durable sealed copy, only when a delivery key is configured; the
    // database then holds ciphertext keyed from outside itself.
    const key = deliveryKey();
    if (key) {
      try {
        const sealed = sealDelivery(key, pairId, { token, identitySecret: identitySecret ?? null, replayUntil });
        this.db.prepare("INSERT INTO pair_delivery_sealed(pair_id, sealed) VALUES(?,?) ON CONFLICT(pair_id) DO UPDATE SET sealed=excluded.sealed")
          .run(pairId, sealed);
      } catch {
        // A failed seal never breaks in-process delivery; it only
        // means this approval will not survive a restart.
      }
    }
  }

  // Post-restart recovery: unseal the durable copy for a hash row whose
  // process-local buffer is gone. Any mismatch — no key, no record,
  // bad tag, stale replay bound — returns null and the caller fails
  // closed to expired_token; there is no plaintext fallback.
  #recoverDelivery(row, now) {
    const key = deliveryKey();
    if (!key) return null;
    let record;
    try {
      record = this.db.prepare("SELECT sealed FROM pair_delivery_sealed WHERE pair_id=?").get(row.pair_id);
    } catch {
      return null;
    }
    if (!record) return null;
    const payload = unsealDelivery(key, row.pair_id, record.sealed);
    if (!payload || payload.replayUntil !== row.replay_until || now > payload.replayUntil) return null;
    const entry = { token: payload.token, identitySecret: payload.identitySecret ?? null, replayUntil: payload.replayUntil };
    this.delivery.set(row.pair_id, entry);
    return entry;
  }

  ensureSchema() {
    this.db.exec(pairingSchema);
  }

  #allow(address) {
    const now = this.store.now();
    const key = typeof address === "string" && address ? address : "unknown";
    const recent = (this.hits.get(key) ?? []).filter(at => now - at < 60_000);
    if (recent.length >= 10) fail(429, "rate_limited", "Too many pair requests");
    recent.push(now);
    this.hits.set(key, recent);
  }

  policy(roomId) {
    const row = this.db.prepare("SELECT mode, updated_at AS updatedAt, updated_by AS updatedBy FROM room_join_policy WHERE room_id=?").get(roomId);
    return row ?? { mode: "approve", updatedAt: null, updatedBy: null };
  }

  setPolicy(token, roomId, mode, binding = null) {
    if (!JOIN_MODES.includes(mode)) fail(422, "invalid_join_policy", "mode must be approve, closed, or auto:<profile>");
    const auth = this.#approver(token, roomId, binding);
    const now = this.store.now();
    this.db.prepare(`INSERT INTO room_join_policy(room_id, mode, updated_at, updated_by) VALUES(?,?,?,?)
      ON CONFLICT(room_id) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
      .run(roomId, mode, now, auth.member.id);
    return { roomId, mode, updatedAt: now, updatedBy: auth.member.id };
  }

  #approver(token, roomId, binding) {
    const auth = this.store.authenticate(token, roomId, binding);
    if (!canInviteMembers(this.store.room(roomId).state, auth.member.id)) fail(403, "access_denied", "invite_member required");
    return auth;
  }

  #ownerLevel(token, roomId, binding) {
    const auth = this.store.authenticate(token, roomId, binding);
    const state = this.store.room(roomId).state;
    const owner = auth.member.id === state.room.ownerId;
    const both = auth.member.permissions.includes("manage_members") && auth.member.permissions.includes("decide");
    if (!owner && !both) fail(403, "access_denied", "Owner-level membership required");
    return auth;
  }

  #roomOr404(roomId) {
    if (!validId(roomId)) fail(404, "not_found", "Room not found");
    const exists = this.db.prepare("SELECT 1 FROM rooms WHERE id=?").get(roomId);
    if (!exists) fail(404, "not_found", "Room not found");
    const room = this.store.room(roomId);
    if (isRoomArchived(room.state)) fail(409, "room_archived", "This room is archived");
    return room;
  }

  #activeKeyIdentity(publicKey) {
    if (!isValidPublicKey(publicKey)) return null;
    const now = this.store.now();
    return this.db.prepare(`SELECT identity_id AS identityId FROM agent_key_registry
      WHERE public_key=? AND revoked_at IS NULL AND valid_from<=? AND (valid_until IS NULL OR valid_until>?)
      ORDER BY registered_at LIMIT 1`).get(publicKey, now, now) ?? null;
  }

  // A key already bound to a member of this room, or to an identity that is.
  resolveKey(roomId, publicKey) {
    if (!publicKey) return null;
    const members = this.store.room(roomId).state.members ?? {};
    const follow = memberId => {
      let current = memberId;
      const seen = new Set();
      while (current && !seen.has(current)) {
        seen.add(current);
        const member = ownMember(members, current);
        if (!member) return null;
        if (member.mergedInto && ownMember(members, member.mergedInto)) current = member.mergedInto;
        else return member;
      }
      return null;
    };
    const bound = this.db.prepare("SELECT member_id AS memberId FROM agent_member_keys WHERE room_id=? AND public_key=?").get(roomId, publicKey);
    if (bound) {
      const member = follow(bound.memberId);
      if (member) return { memberId: member.id, identityId: member.identityId ?? null, active: member.active !== false };
    }
    const identity = this.#activeKeyIdentity(publicKey);
    if (!identity) return null;
    const link = this.db.prepare("SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identity.identityId);
    if (!link) return { memberId: null, identityId: identity.identityId, active: false };
    const member = follow(link.memberId);
    if (!member) return { memberId: null, identityId: identity.identityId, active: false };
    return { memberId: member.id, identityId: identity.identityId, active: member.active !== false };
  }

  #nameMatch(roomId, displayName, exceptId) {
    const name = canonicalName(displayName);
    for (const member of Object.values(this.store.room(roomId).state.members ?? {})) {
      if (!member || member.active === false || member.kind !== "agent" || member.id === exceptId) continue;
      if (canonicalName(member.displayName) === name) return member.id;
    }
    return null;
  }

  #bindKey(roomId, memberId, publicKey) {
    if (!publicKey || !isValidPublicKey(publicKey)) return;
    const existing = this.db.prepare("SELECT member_id AS memberId FROM agent_member_keys WHERE room_id=? AND public_key=?").get(roomId, publicKey);
    if (existing) {
      if (existing.memberId !== memberId) {
        this.db.prepare("UPDATE agent_member_keys SET member_id=? WHERE room_id=? AND public_key=?").run(memberId, roomId, publicKey);
      }
      return;
    }
    this.db.prepare("INSERT INTO agent_member_keys(room_id, member_id, public_key, created_at) VALUES(?,?,?,?)")
      .run(roomId, memberId, publicKey, this.store.now());
  }

  #append(roomId, incoming) {
    const room = this.store.room(roomId);
    if (room.sequence >= PILOT_LIMITS.eventsPerRoom) fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
    let state;
    try { state = compactState(applyEventWithGrowth(room.state, incoming, growthCollector).state); }
    catch (error) { fail(422, "invalid_event", error.message); }
    const projection = this.store.storedProjection(roomId, state);
    if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) fail(409, "pilot_limit", "Room projection limit reached; no data was changed. Ask the room owner to have older messages archived to free space.");
    const sequence = room.sequence + 1;
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
    this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
    return state;
  }

  #pairEvent(roomId, actorId, type, data) {
    return event({
      id: randomUUID(),
      idempotencyKey: createHash("sha256").update(`${type}:${data.pairId}:${data.status}`).digest("hex"),
      type, roomId, actorId,
      at: new Date(this.store.now()).toISOString(),
      data
    });
  }

  #issue(roomId, memberId) {
    return this.store.mintAccessKey(roomId, memberId);
  }

  #connection(roomId, memberId, token, extra = {}) {
    return {
      version: 1, roomId, memberId, token,
      ...(extra.identityId ? { identityId: extra.identityId } : {}),
      ...(extra.identitySecret ? { identitySecret: extra.identitySecret } : {}),
      ...(extra.duplicate ? { duplicate: true } : {}),
      ...(extra.reconnected ? { reconnected: true } : {})
    };
  }

  #reactivate(token, roomId, member, binding) {
    if (member.active !== false) return member;
    this.store.command(token, roomId, {
      id: randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
      data: {
        memberId: member.id, expectedMemberRevision: member.revision,
        permissions: [...member.permissions], active: true,
        authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION
      }
    }, binding);
    return ownMember(this.store.room(roomId).state.members, member.id);
  }

  start({ roomId, displayName, publicKey = null, keyProof = null, credential = null, address = null, origin = null, holdFor = null } = {}) {
    this.#allow(address);
    const name = typeof displayName === "string" ? displayName.trim() : "";
    if (!name || name.length > 80) fail(422, "invalid_pair", "displayName must be 1-80 characters");
    if (publicKey !== null && publicKey !== undefined && !isValidPublicKey(publicKey)) fail(422, "invalid_key", "publicKey must be a valid Ed25519 public key");
    this.#roomOr404(roomId);
    if (typeof credential === "string" && credential) {
      try {
        const auth = this.store.authenticate(credential, roomId);
        if (auth.member?.kind === "agent" && auth.member.active !== false) {
          const issued = this.#issue(roomId, auth.member.id);
          if (publicKey) this.#bindKey(roomId, auth.member.id, publicKey);
          return { reconnected: true, connection: this.#connection(roomId, auth.member.id, issued, { duplicate: true, reconnected: true, identityId: auth.member.identityId }) };
        }
      } catch (error) {
        if (!(error instanceof ServiceError) || error.status !== 401 && error.status !== 403) throw error;
      }
    }
    const proved = publicKey && proofOk(roomId, name, publicKey, keyProof);
    const keyHit = publicKey ? this.resolveKey(roomId, publicKey) : null;
    if (proved && keyHit?.memberId && keyHit.active) {
      const issued = this.#issue(roomId, keyHit.memberId);
      this.#bindKey(roomId, keyHit.memberId, publicKey);
      return { reconnected: true, connection: this.#connection(roomId, keyHit.memberId, issued, { duplicate: true, reconnected: true, identityId: keyHit.identityId }) };
    }
    const mode = this.policy(roomId).mode;
    if (mode === "closed") fail(403, "join_closed", "This room is not accepting agents");
    return this.store.transaction(() => {
      const pending = this.db.prepare("SELECT count(*) AS n FROM pairs WHERE room_id=? AND status='pending' AND expires_at>?").get(roomId, this.store.now()).n;
      if (pending >= MAX_PENDING_PER_ROOM) fail(409, "too_many_requests", "This room already has five agents waiting");
      const named = this.#nameMatch(roomId, name, keyHit?.memberId ?? null);
      const duplicateMemberId = (keyHit?.memberId && keyHit.active ? keyHit.memberId : null) || named;
      const raw = drawCode();
      const pairId = `pair${randomBytes(8).toString("hex")}`;
      const deviceSecret = randomBytes(32).toString("base64url");
      const now = this.store.now();
      // The user_code column is kept only so pre-fix rows stay readable;
      // new rows store the code's scrypt hash there (the same value as
      // user_code_hash), never the code itself (T2-L10c-C1).
      const codeHash = digestHex(raw.replace("-", ""), CODE_SALT);
      this.db.prepare(`INSERT INTO pairs(pair_id, room_id, display_name, user_code_hash, user_code, device_secret_hash, status,
        public_key, duplicate_member_id, created_at, expires_at) VALUES(?,?,?,?,?,?, 'pending', ?,?,?,?)`)
        .run(pairId, roomId, name, codeHash, codeHash, digestHex(deviceSecret, DEVICE_SALT),
          publicKey ?? null, duplicateMemberId, now, now + PAIR_TTL_MS);
      this.#append(roomId, this.#pairEvent(roomId, pairId, T.PAIR_REQUESTED, {
        pairId, displayName: name, userCode: raw, status: "pending",
        ...(duplicateMemberId ? { duplicateMemberId } : {})
      }));
      const profile = mode.startsWith("auto:") ? mode.slice(5) : null;
      const blocked = keyHit?.memberId && !keyHit.active;
      if (profile && !blocked) {
        const ownerId = this.store.room(roomId).state.room.ownerId;
        const admitted = this.#admit(pairId, { actorId: ownerId, profile, reconnect: Boolean(keyHit?.memberId || duplicateMemberId) });
        return { reconnected: Boolean(admitted.connection.reconnected), connection: { ...admitted.connection, ...(origin ? { origin } : {}) } };
      }
      if (holdFor) {
        // Hold only the device secret's scrypt digest (the same value as
        // device_secret_hash): pollHeld authorizes on the starter identity
        // match, so the raw secret never needs to sit in the row.
        this.db.prepare("UPDATE pairs SET hold_secret=?, starter_identity_id=? WHERE pair_id=?").run(digestHex(deviceSecret, DEVICE_SALT), holdFor, pairId);
      }
      return {
        pairId, userCode: raw, approveUrl: `/pair/${raw}`, pollUrl: `/api/pair/${pairId}`,
        expiresIn: Math.floor(PAIR_TTL_MS / 1000), interval: Math.floor(PAIR_POLL_INTERVAL_MS / 1000), deviceSecret
      };
    });
  }

  pollHeld(pairId, identityId, options = {}) {
    if (!validId(pairId) || typeof identityId !== "string" || !identityId) fail(404, "not_found", "Pair not found");
    const row = this.db.prepare("SELECT * FROM pairs WHERE pair_id=?").get(pairId);
    if (!row?.hold_secret || row.starter_identity_id !== identityId) fail(404, "not_found", "Pair not found");
    // Dual-read (T2-L10c-C1): a new row's hold_secret is the device secret's
    // digest — identical to device_secret_hash — so the starter-identity
    // match is the whole authorization and the poll proceeds with the
    // secret already proven. A legacy row holds the raw secret; present it
    // to poll, which verifies it against the stored digest as before.
    if (row.hold_secret === row.device_secret_hash) return this.#servePoll(row, options);
    return this.poll(pairId, row.hold_secret, options);
  }

  poll(pairId, deviceSecret, options = {}) {
    if (!validId(pairId)) fail(404, "not_found", "Pair not found");
    const row = this.db.prepare("SELECT * FROM pairs WHERE pair_id=?").get(pairId);
    if (!row) fail(404, "not_found", "Pair not found");
    if (!sameDigest(deviceSecret, DEVICE_SALT, row.device_secret_hash)) fail(401, "unauthenticated", "Pair secret required");
    return this.#servePoll(row, options);
  }

  // The poll state machine, entered once the caller is authorized (device
  // secret verified by poll, or starter identity matched by pollHeld).
  #servePoll(row, { origin = null } = {}) {
    const pairId = row.pair_id;
    const now = this.store.now();
    if (row.last_poll_at != null && now - row.last_poll_at < PAIR_POLL_INTERVAL_MS) throw new PairPollError("slow_down");
    const replay = row.status === "approved" && row.last_poll_at != null && row.approved_at != null && row.last_poll_at > row.approved_at;
    this.db.prepare("UPDATE pairs SET last_poll_at=? WHERE pair_id=?").run(now, pairId);
    if (row.status === "denied") throw new PairPollError("access_denied");
    if (row.status === "expired" || (row.status === "pending" && now >= row.expires_at)) {
      if (row.status === "pending") this.db.prepare("UPDATE pairs SET status='expired' WHERE pair_id=?").run(pairId);
      throw new PairPollError("expired_token");
    }
    if (row.status === "pending") throw new PairPollError("authorization_pending");
    if (row.status !== "approved" || !row.issued_token || now > row.replay_until) {
      this.delivery.delete(pairId);
      try {
        this.db.prepare("DELETE FROM pair_delivery_sealed WHERE pair_id=?").run(pairId);
      } catch {
        // Sealed-row cleanup is hygiene only; never mask the poll error.
      }
      throw new PairPollError("expired_token");
    }
    // Dual-read (T2-L10c-C1): a legacy row carries the live token and
    // identity secret in plaintext and is served from the row, as before.
    // A new row carries only their hashes; the connection is served from
    // the process-local delivery buffer filled at approval. A buffer miss
    // (a restart inside the replay window) ends the delivery — the agent
    // re-pairs — rather than recovering a credential from the database.
    let token;
    let identitySecret;
    if (isHashHex(row.issued_token)) {
      let held = this.delivery.get(pairId);
      if (!held || now > held.replayUntil) held = this.#recoverDelivery(row, now);
      if (!held || now > held.replayUntil) {
        this.delivery.delete(pairId);
        throw new PairPollError("expired_token");
      }
      token = held.token;
      identitySecret = held.identitySecret;
    } else {
      token = row.issued_token;
      identitySecret = row.identity_secret;
    }
    const duplicate = replay;
    return {
      ...this.#connection(row.room_id, row.member_id, token, {
        identityId: row.identity_id, identitySecret, duplicate, reconnected: false
      }),
      ...(origin ? { origin } : {})
    };
  }

  list(token, roomId, binding = null) {
    this.#approver(token, roomId, binding);
    const now = this.store.now();
    return {
      pairs: this.db.prepare("SELECT * FROM pairs WHERE room_id=? AND status='pending' AND expires_at>? ORDER BY created_at").all(roomId, now)
        .map(row => this.#view(row))
    };
  }

  #view(row, presentedCode = null) {
    const duplicate = row.duplicate_member_id ? ownMember(this.store.room(row.room_id).state.members, row.duplicate_member_id) : null;
    return {
      pairId: row.pair_id, roomId: row.room_id, displayName: row.display_name,
      // The code itself is no longer stored (T2-L10c-C1): a legacy row can
      // still show its stored code, and peek can show the code the caller
      // just presented (the hash lookup already proved it names this row).
      // Otherwise the code is not recoverable from the row and reads null.
      userCode: legacyCode(row.user_code) ?? presentedCode,
      status: row.status, expiresAt: row.expires_at,
      ...(duplicate ? { possibleDuplicate: { memberId: duplicate.id, displayName: duplicate.displayName } } : {})
    };
  }

  peek(userCode) {
    const raw = normalizeCode(userCode);
    if (!raw) return null;
    const row = this.db.prepare("SELECT * FROM pairs WHERE user_code_hash=? AND status='pending' AND expires_at>?").get(digestHex(raw, CODE_SALT), this.store.now());
    return row ? this.#view(row, formatCode(raw)) : null;
  }

  decide(token, roomId, { pairId = null, userCode = null, decision, reconnect = false, profile = "contribute" } = {}, binding = null) {
    if (!["approve", "deny"].includes(decision)) fail(422, "invalid_pair", "decision must be approve or deny");
    if (!agentAccessProfiles[profile]) fail(422, "invalid_pair", "profile must be guest, member, chat, contribute, review, or collaborate");
    const auth = this.#approver(token, roomId, binding);
    const permissions = [...agentAccessProfiles[profile]];
    if (permissions.some(permission => NEVER_GRANT.includes(permission))) fail(403, "access_denied", "That grant is not available on a pair");
    try {
      return this.#decideLocked(auth, roomId, { pairId, userCode, decision, reconnect, profile, permissions, binding, token });
    } catch (error) {
      if (error?.code === "code_failed") this.#failCode(error.roomId ?? roomId);
      throw error;
    }
  }

  #decideLocked(auth, roomId, { pairId, userCode, decision, reconnect, profile, permissions, binding, token }) {
    return this.store.transaction(() => {
      const row = pairId ? this.db.prepare("SELECT * FROM pairs WHERE pair_id=? AND room_id=?").get(pairId, roomId)
        : this.#rowByCode(roomId, userCode, false);
      if (!row || row.room_id !== roomId) fail(404, "not_found", "Pair not found");
      if (row.status !== "pending") fail(409, "pair_closed", "This pair is no longer pending");
      if (this.store.now() >= row.expires_at) {
        this.db.prepare("UPDATE pairs SET status='expired' WHERE pair_id=?").run(row.pair_id);
        fail(410, "expired_token", "This pair expired");
      }
      if (decision === "deny") {
        this.db.prepare("UPDATE pairs SET status='denied', decided_by=? WHERE pair_id=?").run(auth.member.id, row.pair_id);
        this.#append(roomId, this.#pairEvent(roomId, auth.member.id, T.PAIR_DENIED, {
          pairId: row.pair_id, displayName: row.display_name, status: "denied",
          // Only a legacy row still carries its code to record (T2-L10c-C1).
          ...(legacyCode(row.user_code) ? { userCode: row.user_code } : {})
        }));
        this.#clearLock(roomId);
        return { pairId: row.pair_id, status: "denied" };
      }
      return this.#admit(row.pair_id, { actorId: auth.member.id, token, binding, profile, reconnect: Boolean(reconnect), permissions });
    });
  }

  #rowByCode(roomId, userCode, recordFailure = true) {
    const raw = normalizeCode(userCode);
    const lock = this.db.prepare("SELECT failures, locked_until FROM pair_code_locks WHERE room_id=?").get(roomId);
    if (lock?.locked_until && this.store.now() < lock.locked_until) fail(429, "code_locked", "Too many incorrect codes");
    const row = raw && this.db.prepare("SELECT * FROM pairs WHERE room_id=? AND user_code_hash=? AND status='pending'").get(roomId, digestHex(raw, CODE_SALT));
    if (!row) {
      if (recordFailure) this.#failCode(roomId);
      const error = new ServiceError(404, "code_failed", "Pair not found");
      error.roomId = roomId;
      throw error;
    }
    return row;
  }

  #failCode(roomId) {
    const now = this.store.now();
    const lock = this.db.prepare("SELECT failures FROM pair_code_locks WHERE room_id=?").get(roomId);
    const failures = (lock?.failures ?? 0) + 1;
    const lockedUntil = failures >= LOCK_AFTER ? now + LOCK_MS : null;
    this.db.prepare(`INSERT INTO pair_code_locks(room_id, failures, locked_until) VALUES(?,?,?)
      ON CONFLICT(room_id) DO UPDATE SET failures=excluded.failures, locked_until=excluded.locked_until`)
      .run(roomId, failures, lockedUntil);
    fail(404, "not_found", "Pair not found");
  }

  #clearLock(roomId) {
    this.db.prepare("DELETE FROM pair_code_locks WHERE room_id=?").run(roomId);
  }

  #admit(pairId, { actorId, token = null, binding = null, profile = "contribute", reconnect = false, permissions = null }) {
    const row = this.db.prepare("SELECT * FROM pairs WHERE pair_id=?").get(pairId);
    const roomId = row.room_id;
    const grants = permissions ?? [...agentAccessProfiles[profile]];
    const keyHit = row.public_key ? this.resolveKey(roomId, row.public_key) : null;
    const reconnectId = (keyHit?.memberId && (keyHit.active || token) ? keyHit.memberId : null)
      || (reconnect ? row.duplicate_member_id : null);
    let memberId;
    let identityId = keyHit?.identityId ?? null;
    let identitySecret = null;
    let reconnected = false;
    if (reconnectId) {
      const member = ownMember(this.store.room(roomId).state.members, reconnectId);
      if (!member || member.kind !== "agent") fail(409, "pair_closed", "That agent is no longer in the room");
      if (member.active === false) {
        if (!token) fail(403, "access_denied", "An inactive agent needs an owner to approve the reconnect");
        this.#reactivate(token, roomId, member, binding);
      }
      memberId = reconnectId;
      identityId = identityId ?? ownMember(this.store.room(roomId).state.members, memberId)?.identityId ?? null;
      reconnected = true;
    } else if (identityId || row.starter_identity_id) {
      identityId = identityId ?? row.starter_identity_id;
      memberId = this.#linkIdentity(roomId, actorId, identityId, row.display_name, grants);
    } else {
      const created = this.store.identities.create(row.display_name, { publicKey: row.public_key ?? undefined });
      identityId = created.identityId;
      identitySecret = created.secret ?? null;
      memberId = this.#linkIdentity(roomId, actorId, identityId, row.display_name, grants);
    }
    if (row.public_key) {
      this.#bindKey(roomId, memberId, row.public_key);
      if (identityId && !this.#activeKeyIdentity(row.public_key)) {
        this.store.keyRegistry.registerKey(identityId, row.public_key, { validFrom: this.store.now() });
      }
    }
    const issued = this.#issue(roomId, memberId);
    const now = this.store.now();
    const replayUntil = now + PAIR_REPLAY_MS;
    // Store only scrypt hashes of the issued token and the identity secret
    // (T2-L10c-C1). The live values are delivered synchronously to this
    // caller and, for the polling device, from the in-memory delivery
    // buffer — never read back from this row.
    this.db.prepare(`UPDATE pairs SET status='approved', member_id=?, identity_id=?, issued_token=?, identity_secret=?,
      approved_at=?, replay_until=?, decided_by=? WHERE pair_id=?`)
      .run(memberId, identityId, digestHex(issued, TOKEN_SALT), identitySecret ? digestHex(identitySecret, IDENTITY_SALT) : null,
        now, replayUntil, actorId, pairId);
    this.#rememberDelivery(pairId, issued, identitySecret, replayUntil);
    this.#append(roomId, this.#pairEvent(roomId, actorId, T.PAIR_APPROVED, {
      pairId, displayName: row.display_name, status: "approved", memberId,
      // Only a legacy row still carries its code to record (T2-L10c-C1).
      ...(legacyCode(row.user_code) ? { userCode: row.user_code } : {})
    }));
    this.#clearLock(roomId);
    return {
      pairId, status: "approved", memberId, reconnected,
      connection: this.#connection(roomId, memberId, issued, { identityId, identitySecret, duplicate: false, reconnected })
    };
  }

  #linkIdentity(roomId, actorId, identityId, displayName, permissions) {
    const existing = this.db.prepare("SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
    if (existing) return existing.memberId;
    const members = this.store.room(roomId).state.members ?? {};
    assertNotReservedRoleName(displayName);
    const activeNames = Object.values(members)
      .filter(member => member.active !== false)
      .map(member => ({ memberId: member.id, displayName: member.displayName }));
    const checked = checkAgentDisplayName(displayName, { activeNames });
    const collision = checked.reason === "name_collision";
    if (!checked.safe && !collision) fail(422, "invalid_pair", "displayName is not available in this room");
    const memberId = identityId;
    if (ownMember(members, memberId)) fail(409, "identity_conflict", "Member id is already taken");
    const now = this.store.now();
    this.db.prepare("INSERT INTO identity_links(room_id, identity_id, member_id, linked_at) VALUES(?,?,?,?)")
      .run(roomId, identityId, memberId, now);
    this.#append(roomId, event({
      id: randomUUID(),
      idempotencyKey: createHash("sha256").update(`pair-member:${roomId}:${identityId}`).digest("hex"),
      type: T.MEMBER_ADDED, roomId, actorId,
      at: new Date(now).toISOString(),
      data: {
        memberId, displayName, kind: "agent", permissions: [...permissions], identityId,
        referredBy: actorId, authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION,
        ...(collision ? {} : { displayNamePolicyVersion: DISPLAY_NAME_POLICY_VERSION })
      }
    }));
    return memberId;
  }

  merge(token, roomId, { keepMemberId, retireMemberId } = {}, binding = null) {
    if (!validId(keepMemberId) || !validId(retireMemberId)) fail(422, "invalid_merge", "keepMemberId and retireMemberId are required");
    const auth = this.#ownerLevel(token, roomId, binding);
    return this.store.transaction(() => {
      const state = this.store.room(roomId).state;
      const kept = ownMember(state.members, keepMemberId);
      const retired = ownMember(state.members, retireMemberId);
      if (!kept || !retired) fail(404, "not_found", "Unknown member");
      const now = this.store.now();
      const next = this.#append(roomId, event({
        id: randomUUID(),
        idempotencyKey: createHash("sha256").update(`merge:${roomId}:${keepMemberId}:${retireMemberId}:${retired.revision}`).digest("hex"),
        type: T.MEMBER_MERGED, roomId, actorId: auth.member.id,
        at: new Date(now).toISOString(),
        data: {
          keptMemberId: keepMemberId, retiredMemberId: retireMemberId,
          expectedKeptRevision: kept.revision, expectedRetiredRevision: retired.revision
        }
      }));
      this.#moveSideRows(roomId, keepMemberId, retireMemberId);
      const keptMember = ownMember(next.members, keepMemberId);
      return {
        roomId, keepMemberId, retireMemberId,
        permissions: [...keptMember.permissions],
        retired: true
      };
    });
  }

  #moveSideRows(roomId, kept, retired) {
    this.db.prepare("UPDATE identity_links SET member_id=? WHERE room_id=? AND member_id=?").run(kept, roomId, retired);
    this.db.prepare(`DELETE FROM agent_member_keys WHERE room_id=? AND member_id=? AND public_key IN (
      SELECT public_key FROM agent_member_keys WHERE room_id=? AND member_id=?)`).run(roomId, retired, roomId, kept);
    this.db.prepare("UPDATE agent_member_keys SET member_id=? WHERE room_id=? AND member_id=?").run(kept, roomId, retired);
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get()) {
      this.db.prepare("UPDATE messages SET author_id=? WHERE room_id=? AND author_id=?").run(kept, roomId, retired);
      this.db.prepare("UPDATE messages SET to_member_id=? WHERE room_id=? AND to_member_id=?").run(kept, roomId, retired);
      const records = this.db.prepare("SELECT message_id, record_json FROM messages WHERE room_id=? AND record_json LIKE ?").all(roomId, `%${retired}%`);
      for (const row of records) {
        try {
          const record = JSON.parse(row.record_json);
          let changed = false;
          if (record.authorId === retired) { record.authorId = kept; changed = true; }
          if (record.toMemberId === retired) { record.toMemberId = kept; changed = true; }
          if (changed) this.db.prepare("UPDATE messages SET record_json=? WHERE room_id=? AND message_id=?").run(JSON.stringify(record), roomId, row.message_id);
        } catch { /* a non-json shadow is left for the projection */ }
      }
    }
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_claims'").get()) {
      const claims = this.db.prepare("SELECT claim_id, item_json FROM work_claims WHERE room_id=?").all(roomId);
      for (const row of claims) {
        try {
          const item = JSON.parse(row.item_json);
          const changed = rewriteMember(item, retired, kept);
          if (changed) this.db.prepare("UPDATE work_claims SET item_json=? WHERE room_id=? AND claim_id=?").run(JSON.stringify(item), roomId, row.claim_id);
        } catch { /* skip a row that is not an object */ }
      }
    }
  }
}

const MEMBER_FIELDS = new Set(["holderId", "ownerId", "claimantId", "memberId", "accountableMemberId", "verifierMemberId"]);
function rewriteMember(value, from, to) {
  if (!value || typeof value !== "object") return false;
  let changed = false;
  if (Array.isArray(value)) {
    for (const entry of value) if (rewriteMember(entry, from, to)) changed = true;
    return changed;
  }
  for (const [key, child] of Object.entries(value)) {
    if (MEMBER_FIELDS.has(key) && child === from) { value[key] = to; changed = true; }
    else if (child && typeof child === "object" && rewriteMember(child, from, to)) changed = true;
  }
  return changed;
}
