// Signed agent-carried referral invites — the Burs-IA steal-list item.
// Any active room member can mint a signed bring-a-friend token and carry it
// out-of-band (a DM, a post, a chat with another agent). The server never
// sends or dispatches the token: the inviter is the transport. Redemption is
// unauthenticated, binds the stranger to the room, the chain, and a depth,
// and lands them at the fixed read+chat tier — no work claims, bounties,
// credits, or claims-board participation.
//
// Trust and privacy design:
// - The token is Ed25519-signed by a per-room server keypair (generated
//   lazily on first mint, stored server-side; the private half never leaves
//   the database). Key generation and the canonical base64 wire formats come
//   from server/agent-card-signing.mjs; the sign/verify path uses the same
//   node:crypto Ed25519 discipline as server/signed-claims.mjs (canonical
//   JSON body, signature over the UTF-8 body bytes). No new key regime.
// - The token carries only { v, jti, chainId, roomId, depth, maxDepth,
//   issuedAt, expiresAt, tier }. The inviter's identity is NOT in the token
//   and NOT in any member-visible surface: the redeem emits a member.added
//   event with no referredBy field (actor: the room owner, since the
//   membership validator requires an invite_member-capable actor and the
//   inviter must stay hidden), and this flow never calls Referrals.record
//   (the member-visible referral board must not see the chain). Inviter
//   identity lives only in the private referral_invites ledger, which the
//   owner reads via the audit endpoint.
// - Membership is reputation-less: the member joins with the chat permission
//   profile (empty permission list), and the ledger row carries no claim or
//   credit hooks — there is nothing here for the claims board to consume.
//
// Depth: a member who joined at depth d (direct invite = depth 0) may mint
// a token at depth d+1. A member already AT maxDepth cannot mint further —
// the cap is inclusive, so a maxDepth of 6 admits tokens at depths 0..6. A
// member who joined without a referral token (the owner, invite codes,
// access requests) sits at depth -1, i.e. their invites start new chains at
// depth 0. Redeeming a token with depth > maxDepth fails (only reachable by
// a forged token, since honest mints can never exceed the cap).

import { createHash, createPrivateKey, createPublicKey, randomUUID, sign as edSign, verify as edVerify } from "node:crypto";
import { ServiceError } from "./store.mjs";
import { generateKeyPair } from "./agent-card-signing.mjs";
import { refuseArchivedWrite } from "./room-lifecycle.mjs";
import { applyEventWithGrowth, growthCollector } from "../src/growth-emit.js";
import { event as makeEvent, EVENT_TYPES as T, MEMBERSHIP_AUTHORITY_POLICY_VERSION } from "../src/events.js";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const hash = text => createHash("sha256").update(text).digest("hex");
const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// The rooms table stores the full projection; the event log tails are
// stripped before persist, exactly as the invite redeem path does.
const compactState = state => ({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });

// Token wire format: ref1.<base64url(body)>.<base64url(signature)>. The
// prefix is distinct from signed-claims (ed1) and guest links (ga1.).
const TOKEN_PREFIX = "ref1";
const TOKEN_VERSION = 1;
const DEFAULT_MAX_DEPTH = 6;
const MAX_MAX_DEPTH = 12;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REFERRAL_TIER = "chat";
const REFERRAL_PERMISSIONS = Object.freeze([]);

// The referral tier is the chat profile: read + chat, nothing else. This is
// the same empty permission list the chat invite profile resolves to.
const grantedPermissions = () => [...REFERRAL_PERMISSIONS];

// Canonical JSON: sorted keys, no whitespace — the same discipline as the
// signed-claims body encoder.
const canonical = value => JSON.stringify(value, Object.keys(value).sort());
const b64u = buffer => Buffer.from(buffer).toString("base64url");
const unb64u = text => Buffer.from(text, "base64url");

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
// Public keys import via JWK (the same form server/signed-claims.mjs uses);
// private seeds via the fixed PKCS#8 DER prefix.
const importPrivateKey = seed => createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
const importPublicKey = key => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") }, format: "jwk" });

export const referralInviteSchema = `
CREATE TABLE IF NOT EXISTS referral_invite_keys (
  room_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  private_seed TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- The referral journal: every mint, redemption, and policy rejection is a
-- row here. inviter_member_id is owner-visible ONLY; no member-facing query
-- joins this table.
CREATE TABLE IF NOT EXISTS referral_invites (
  jti TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  inviter_member_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  max_depth INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'minted' CHECK (status IN ('minted', 'redeemed', 'rejected')),
  rejected_at INTEGER,
  reject_reason TEXT,
  redeemed_at INTEGER,
  redeemed_member_id TEXT,
  redeemed_identity_id TEXT
);
CREATE INDEX IF NOT EXISTS referral_invites_chain ON referral_invites (room_id, chain_id);
-- Chain membership: which depth each referral member sits at, for mint
-- authorization. Seeded on redeem; members who joined by other paths have
-- no row (mint depth -1 => new chains).
CREATE TABLE IF NOT EXISTS referral_chain_members (
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  chain_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  max_depth INTEGER,
  PRIMARY KEY (room_id, member_id)
);`;

const mintNext = token => Object.freeze([
  Object.freeze({
    action: "carry-invite",
    description: "Hand this token to the agent yourself — the server never sends it. Anyone with the token can preview it, then redeem it within 7 days.",
    token,
  }),
  Object.freeze({
    action: "preview-invite",
    method: "POST",
    path: "/api/referral-invites/preview",
    description: "See what the invitee will see before you hand it over: room, chain, depth, expiry — never the inviter.",
  }),
]);

const redeemNext = Object.freeze([
  Object.freeze({
    action: "see-who-is-around",
    method: "GET",
    path: "/api/rooms/:roomId/members",
    description: "Meet the room. You join read+chat: read and talk, no work claims.",
  }),
  Object.freeze({
    action: "mint-your-own",
    method: "POST",
    path: "/api/referral-invites/mint",
    description: "Bring a friend yourself: your invites continue this chain one level deeper.",
  }),
]);

export class ReferralInvites {
  constructor(store) { this.store = store; }

  now() { return this.store.now(); }

  // --- room signing keys -------------------------------------------------
  // One Ed25519 keypair per room, generated on first mint and kept in the
  // database (the private half never leaves it). The server is the signer
  // for its own rooms — the same trust posture as the stored webhook
  // subscription secrets and agent identity keys.
  roomKeys(roomId) {
    const existing = this.store.db.prepare(
      "SELECT public_key, private_seed FROM referral_invite_keys WHERE room_id = ?"
    ).get(roomId);
    if (existing) {
      return {
        publicKey: Buffer.from(existing.public_key, "base64"),
        privateSeed: Buffer.from(existing.private_seed, "base64"),
      };
    }
    const generated = generateKeyPair();
    this.store.db.prepare(
      "INSERT INTO referral_invite_keys (room_id, public_key, private_seed, created_at) VALUES (?, ?, ?, ?)"
    ).run(roomId, generated.publicKey, generated.privateKey, this.now());
    return {
      publicKey: Buffer.from(generated.publicKey, "base64"),
      privateSeed: Buffer.from(generated.privateKey, "base64"),
    };
  }

  signToken(body, privateSeed) {
    const bodyText = canonical(body);
    const bodyB64 = b64u(Buffer.from(bodyText, "utf8"));
    let key;
    try { key = importPrivateKey(privateSeed); }
    catch { fail(500, "signing_unavailable", "The room's invite signer is unavailable"); }
    // Ed25519 one-shot sign: the algorithm argument is null (PureEdDSA —
    // the hash is internal to the algorithm, not a separate digest).
    const signature = edSign(null, Buffer.from(bodyB64, "utf8"), key);
    return `${TOKEN_PREFIX}.${bodyB64}.${b64u(signature)}`;
  }

  // Read-only public key lookup for verification: verifying a token must
  // never create key material (a forged roomId must not leave rows behind).
  roomPublicKey(roomId) {
    const row = this.store.db.prepare(
      "SELECT public_key FROM referral_invite_keys WHERE room_id = ?"
    ).get(roomId);
    return row ? Buffer.from(row.public_key, "base64") : null;
  }

  // Returns the verified payload, or null when the token is malformed or
  // the signature does not check out. Never throws for bad input: a forged
  // token is indistinguishable from an unknown one.
  verifyToken(token) {
    if (typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
    let body, signature;
    try {
      body = JSON.parse(unb64u(parts[1]).toString("utf8"));
      signature = unb64u(parts[2]);
    } catch { return null; }
    if (!body || typeof body !== "object") return null;
    const { v, jti, chainId, roomId, depth, maxDepth, issuedAt, expiresAt, tier } = body;
    if (v !== TOKEN_VERSION || tier !== REFERRAL_TIER) return null;
    if (typeof jti !== "string" || typeof chainId !== "string" || typeof roomId !== "string") return null;
    if (!Number.isInteger(depth) || depth < 0 || !Number.isInteger(maxDepth) || maxDepth < 1) return null;
    if (!Number.isInteger(issuedAt) || !Number.isInteger(expiresAt) || expiresAt <= issuedAt) return null;
    const publicKey = this.roomPublicKey(roomId);
    if (!publicKey) return null;
    let ok = false;
    try { ok = edVerify(null, Buffer.from(parts[1], "utf8"), importPublicKey(publicKey), signature); }
    catch { ok = false; }
    if (!ok) return null;
    return { jti, chainId, roomId, depth, maxDepth, issuedAt, expiresAt };
  }

  // Old rows are backfilled from their redeemed invite at store initialization.
  // An orphan old row is fail-closed: it can no longer mint until reconciled.
  chainPolicy(roomId, memberId) {
    return this.store.db.prepare(
      "SELECT chain_id, depth, max_depth FROM referral_chain_members WHERE room_id = ? AND member_id = ?"
    ).get(roomId, memberId) ?? null;
  }

  // --- mint --------------------------------------------------------------
  mint(token, roomId, { maxDepth: requestedMaxDepth } = {}) {
    const auth = this.store.authenticate(token, roomId);
    if (!auth.member || auth.member.active === false) fail(403, "access_denied", "Join the room before sending referral invites");
    if (typeof auth.member.id !== "string" || !MEMBER_ID_PATTERN.test(auth.member.id)) fail(403, "access_denied", "Join the room before sending referral invites");
    // The inviter must still be an active member: outstanding tokens die
    // with a removed inviter, the same posture as one-time invite codes.
    const room = this.store.room(roomId);
    refuseArchivedWrite(room.state);
    if (room.state.members[auth.member.id]?.active === false) fail(403, "access_denied", "Join the room before sending referral invites");

    // The depth-cap refusal is journaled in its own committed transaction
    // before failing: a throw inside the mint transaction below would roll
    // the journal entry back.
    const chain = this.chainPolicy(roomId, auth.member.id);
    const minterDepth = chain?.depth ?? -1;
    if (chain && (!Number.isInteger(chain.max_depth) || chain.max_depth < 1)) {
      fail(409, "referral_depth_exceeded", "This chain cap cannot be verified");
    }
    const maxDepth = requestedMaxDepth ?? chain?.max_depth ?? DEFAULT_MAX_DEPTH;
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_MAX_DEPTH) {
      fail(422, "invalid_max_depth", `maxDepth must be an integer 1..${MAX_MAX_DEPTH}`);
    }
    if (chain && maxDepth > chain.max_depth) {
      fail(409, "referral_depth_exceeded", "A descendant cannot raise the chain depth cap");
    }
    if (minterDepth >= maxDepth) {
      const jti = randomUUID();
      const now = this.now();
      this.store.transaction(() => {
        this.store.db.prepare(
          `INSERT INTO referral_invites (jti, room_id, chain_id, inviter_member_id, depth, max_depth, created_at, expires_at, status, rejected_at, reject_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rejected', ?, 'depth_exceeded')`
        ).run(jti, roomId, chain?.chain_id ?? randomUUID(), auth.member.id, minterDepth + 1, maxDepth, now, now, now);
      });
      fail(409, "referral_depth_exceeded", `This chain is at maxDepth ${maxDepth}; no further invites can be minted from it`);
    }

    return this.store.transaction(() => {
      const chainId = chain?.chain_id ?? randomUUID();
      const depth = minterDepth + 1;
      const jti = randomUUID();
      const issuedAt = this.now();
      const expiresAt = issuedAt + INVITE_TTL_MS;
      const keys = this.roomKeys(roomId);
      const signed = this.signToken({ v: TOKEN_VERSION, jti, chainId, roomId, depth, maxDepth, issuedAt, expiresAt, tier: REFERRAL_TIER }, keys.privateSeed);
      this.store.db.prepare(
        `INSERT INTO referral_invites (jti, room_id, chain_id, inviter_member_id, depth, max_depth, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'minted')`
      ).run(jti, roomId, chainId, auth.member.id, depth, maxDepth, issuedAt, expiresAt);
      return {
        token: signed,
        jti,
        chainId,
        roomId,
        depth,
        maxDepth,
        issuedAt,
        expiresAt,
        tier: REFERRAL_TIER,
        grantedPermissions: grantedPermissions(),
        publicKey: keys.publicKey.toString("base64"),
        next: mintNext(signed),
      };
    });
  }

  // The chain a member continues, or null when they joined by another path
  // (their mint starts a fresh chain).
  chainIdFor(roomId, memberId) {
    const row = this.store.db.prepare(
      "SELECT chain_id FROM referral_chain_members WHERE room_id = ? AND member_id = ?"
    ).get(roomId, memberId);
    return row ? row.chain_id : null;
  }

  // --- preview -----------------------------------------------------------
  // What the invitee sees before redeeming: room, chain, depth, expiry —
  // never the inviter.
  preview(token) {
    const payload = this.verifyToken(token);
    if (!payload) fail(404, "invite_unavailable", "That invite is not available");
    if (this.now() >= payload.expiresAt) fail(410, "invite_expired", "That invite has expired");
    if (payload.depth > payload.maxDepth) fail(409, "referral_depth_exceeded", "That invite is past the chain depth limit");
    let room;
    try { room = this.store.room(payload.roomId); }
    catch { fail(404, "invite_unavailable", "That invite is not available"); }
    const ledger = this.store.db.prepare(
      "SELECT status, inviter_member_id, chain_id, depth, max_depth FROM referral_invites WHERE jti = ? AND room_id = ?"
    ).get(payload.jti, payload.roomId);
    if (!ledger || ledger.status !== "minted" || ledger.chain_id !== payload.chainId
        || ledger.depth !== payload.depth || ledger.max_depth !== payload.maxDepth
        || room.state.members[ledger.inviter_member_id]?.active !== true) {
      fail(404, "invite_unavailable", "That invite is not available");
    }
    return {
      roomId: payload.roomId,
      roomTitle: room.state.room.title,
      chainId: payload.chainId,
      depth: payload.depth,
      maxDepth: payload.maxDepth,
      expiresAt: payload.expiresAt,
      tier: REFERRAL_TIER,
      grantedPermissions: grantedPermissions(),
      publicKey: this.roomKeys(payload.roomId).publicKey.toString("base64"),
    };
  }

  // --- redeem ------------------------------------------------------------
  redeem({ token, displayName = "Referred agent" }) {
    const payload = this.verifyToken(token);
    if (!payload) fail(404, "invite_unavailable", "That invite is not available");
    const { jti, chainId, roomId, depth, maxDepth, expiresAt } = payload;
    // Policy pre-checks run outside the admission transaction: a rejection
    // must be journaled (committed) even though the redeem itself fails, and
    // a throw inside store.transaction would roll the journal entry back.
    const ledger = this.store.db.prepare(
      "SELECT status, inviter_member_id, chain_id, depth, max_depth FROM referral_invites WHERE jti = ? AND room_id = ?"
    ).get(jti, roomId);
    // A signed token with no ledger row is forged against a rotated key or
    // minted before this feature existed: not available, no row to update.
    if (!ledger || ledger.status !== "minted" || ledger.chain_id !== chainId
        || ledger.depth !== depth || ledger.max_depth !== maxDepth) {
      fail(404, "invite_unavailable", "That invite is not available");
    }
    const rejectAndFail = (status, code, message, reason) => {
      this.store.transaction(() => {
        this.store.db.prepare(
          "UPDATE referral_invites SET status = 'rejected', rejected_at = ?, reject_reason = ? WHERE jti = ? AND status = 'minted'"
        ).run(this.now(), reason, jti);
      });
      fail(status, code, message);
    };
    if (this.now() >= expiresAt) rejectAndFail(410, "invite_expired", "That invite has expired", "expired");
    if (depth > maxDepth) rejectAndFail(409, "referral_depth_exceeded", "That invite is past the chain depth limit", "depth_exceeded");
    const preRoom = this.store.room(roomId);
    // The inviter must still be an active member at redeem time; a removed
    // inviter's outstanding tokens stop working.
    if (preRoom.state.members[ledger.inviter_member_id]?.active === false) {
      rejectAndFail(410, "invite_expired", "That invite is no longer valid", "inviter_inactive");
    }

    return this.store.transaction(() => {
      const room = this.store.room(roomId);
      refuseArchivedWrite(room.state);
      const now = this.now();
      if (room.sequence + 1 > 2000000) fail(409, "pilot_limit", "Room event limit reached; no data was changed");
      if (Object.keys(room.state.members).length > 5000) fail(409, "pilot_limit", "Room member limit reached; no data was changed");

      const name = String(displayName ?? "Referred agent").trim();
      const identity = this.store.identities.create(name);
      const identityId = identity.identityId;
      if (!MEMBER_ID_PATTERN.test(identityId)) fail(500, "invite_failed", "Generated member id is invalid");
      const memberId = identityId;
      // The member.added validator requires the actor to hold invite_member
      // (or be the owner). The inviter usually holds neither — and must not
      // appear here anyway, because this event is member-visible. So the
      // actor is the room owner: admission under the room's authority. The
      // true inviter is recorded in the private ledger only (owner audit).
      // The admission marker names the mechanism without naming the inviter.
      const ownerId = room.state.room.ownerId;
      const added = makeEvent({
        id: randomUUID(),
        idempotencyKey: hash(`referral-redeem:${jti}`),
        type: T.MEMBER_ADDED,
        roomId,
        actorId: ownerId,
        at: new Date(now).toISOString(),
        data: {
          memberId,
          displayName: name,
          kind: "agent",
          permissions: grantedPermissions(),
          identityId,
          authorityPolicyVersion: MEMBERSHIP_AUTHORITY_POLICY_VERSION,
          admission: "referral-invite",
          // No referredBy: the inviter stays out of every member-visible
          // surface. The chain is recorded in the private ledger only.
        },
      });
      let state;
      try { state = compactState(applyEventWithGrowth(room.state, added, growthCollector).state); }
      catch (error) { fail(409, "invite_rejected", error.message); }
      const projection = JSON.stringify(state);
      if (Buffer.byteLength(projection) > 4 * 1024 * 1024) fail(409, "pilot_limit", "Room projection limit reached; no data was changed");
      const sequence = room.sequence + 1;
      this.store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, added.id, JSON.stringify(added));
      this.store.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
      this.store.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
        .run(roomId, identityId, memberId, now);
      // Compare-and-swap claim: exactly one redemption wins under
      // concurrency (the pre-check above is outside the transaction).
      const claimed = this.store.db.prepare(
        `UPDATE referral_invites SET status = 'redeemed', redeemed_at = ?, redeemed_member_id = ?, redeemed_identity_id = ?
         WHERE jti = ? AND status = 'minted'`
      ).run(now, memberId, identityId, jti);
      if (claimed.changes !== 1) fail(404, "invite_unavailable", "That invite is not available");
      this.store.db.prepare(
        "INSERT INTO referral_chain_members (room_id, member_id, chain_id, depth, max_depth) VALUES (?, ?, ?, ?, ?)"
      ).run(roomId, memberId, chainId, depth, maxDepth);

      return {
        identityId,
        secret: identity.secret,
        roomId,
        memberId,
        displayName: name,
        permissions: grantedPermissions(),
        chainId,
        depth,
        next: redeemNext,
      };
    });
  }

  // --- owner audit -------------------------------------------------------
  // The room owner sees the whole journal: every mint, redemption, and
  // rejection with the inviter identified. Invitee-facing surfaces never
  // join against this table.
  list(token, roomId) {
    const auth = this.store.authenticate(token, roomId);
    const authority = this.store.roomAuthority(roomId);
    if (!auth.member || auth.member.id !== authority.ownerId) fail(403, "access_denied", "Only the room owner can audit referral invites");
    const rows = this.store.db.prepare(
      `SELECT jti, chain_id, inviter_member_id, depth, max_depth, created_at, expires_at,
              status, rejected_at, reject_reason, redeemed_at, redeemed_member_id, redeemed_identity_id
       FROM referral_invites WHERE room_id = ? ORDER BY created_at DESC, jti`
    ).all(roomId);
    const room = this.store.room(roomId);
    const displayNameOf = memberId => room.state.members[memberId]?.displayName ?? null;
    return {
      roomId,
      invites: rows.map(row => ({
        jti: row.jti,
        chainId: row.chain_id,
        inviterMemberId: row.inviter_member_id,
        inviterDisplayName: displayNameOf(row.inviter_member_id),
        depth: row.depth,
        maxDepth: row.max_depth,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        status: row.status,
        rejectedAt: row.rejected_at,
        rejectReason: row.reject_reason,
        redeemedAt: row.redeemed_at,
        redeemedMemberId: row.redeemed_member_id,
        redeemedIdentityId: row.redeemed_identity_id,
        redeemedDisplayName: row.redeemed_member_id ? displayNameOf(row.redeemed_member_id) : null,
      })),
    };
  }
}
