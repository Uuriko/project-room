// Multi-room agent identities (round-2 task #101).
//
// Today an agent working in N rooms is provisioned N times: N member
// records, N access keys. An agent identity is one stable credential an
// agent carries across rooms: the identity is created once, a room owner
// links it into their room (creating one member record bound to the
// identity), and the agent then authenticates to every linked room with
// the same secret. Rooms keep full sovereignty — linking and unlinking
// are owner-only, and unlinking deactivates the room member.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fastIdentityHashCandidates, forgetIdentityVerifier, isV2IdentityHash, legacyIdentityHash, scryptIdentityHash } from "./identity-secret-hash.mjs";
import { ServiceError } from "./store.mjs";
import { generateKeyPair as generateEd25519KeyPair } from "./agent-card-signing.mjs";
import { memberCan } from "../src/events.js";
import { nextActionsForIdentityMint } from "./discoverability.mjs";
import { checkAgentDisplayName, assertNotReservedRoleName } from "./display-name-guard.mjs";
import { refreshDirectoryIdentity } from "./public-read-model.mjs";

const fail = (status, code, message, headers = null, detail = null) => {
  const error = new ServiceError(status, code, message, headers);
  if (detail) error.detail = detail;
  throw error;
};

export const agentIdentitySchema = `
  CREATE TABLE IF NOT EXISTS agent_identities (
    identity_id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS identity_links (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    identity_id TEXT NOT NULL REFERENCES agent_identities(identity_id),
    member_id TEXT NOT NULL,
    linked_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, identity_id)
  );
  CREATE INDEX IF NOT EXISTS identity_links_member ON identity_links(room_id, member_id);
`;

// Idempotent additive migration for the revoked_at column (RC-2026-09-19-055:
// identity-secret rotate/revoke). Existing rows backfill NULL, which reads
// as "not revoked". Follows the spam-quarantine column pattern (PR #562):
// called from the writer boot path, not the module constructor (the module
// is constructed before tables exist). agent_identities is excluded from
// the upgrade comparability filter, so the column evolution is audit-safe.
export function ensureIdentitySecretSchema(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_identities'").get();
  if (!exists) return;
  const columns = new Set(db.prepare("PRAGMA table_info(agent_identities)").all().map(column => column.name));
  if (!columns.has("revoked_at")) db.exec("ALTER TABLE agent_identities ADD COLUMN revoked_at INTEGER");
  // Second HMAC, written when ROOM_IDENTITY_HASH_KEY is set, so a deploy
  // that omits the secret still matches the built-in fallback verifier.
  if (!columns.has("fallback_secret_hash")) db.exec("ALTER TABLE agent_identities ADD COLUMN fallback_secret_hash TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS agent_identities_fallback_secret_hash ON agent_identities(fallback_secret_hash) WHERE fallback_secret_hash IS NOT NULL");
}

// Additive columns for anonymous-mint budgets and inactivity expiry.
// Existing rows are marked activated so a deploy does not expire identities
// that were already issued. New anonymous rows leave activated_at null until
// they authenticate, post, or are linked.
export function ensureIdentityCapacitySchema(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_identities'").get();
  if (!exists) return;
  const columns = new Set(db.prepare("PRAGMA table_info(agent_identities)").all().map(column => column.name));
  if (!columns.has("activated_at")) {
    db.exec("ALTER TABLE agent_identities ADD COLUMN activated_at INTEGER");
    db.exec("UPDATE agent_identities SET activated_at=created_at WHERE activated_at IS NULL");
  }
  if (!columns.has("mint_address")) db.exec("ALTER TABLE agent_identities ADD COLUMN mint_address TEXT");
  if (!columns.has("mint_network")) db.exec("ALTER TABLE agent_identities ADD COLUMN mint_network TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS agent_identities_mint_address ON agent_identities(mint_address, created_at)");
  db.exec("CREATE INDEX IF NOT EXISTS agent_identities_mint_network ON agent_identities(mint_network, created_at)");
}

// RC-2026-09-24-210: identity-holder proof-of-possession for identityId
// enrollment (Uuriko/project-room#942, replacing the #948 interim disable).
// The identity HOLDER mints a single-use enrollment code with their own
// secret; a sponsor presents it on agent-connections create. Only the
// SHA-256 hash is stored — the raw code is returned once, never logged,
// never persisted. 10-minute TTL, bound to the minting identityId.
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
export const LINK_CODE_BYTES = 16; // 128 bits of entropy
export const LINK_CODE_RE = /^[A-Za-z0-9_-]{22}$/; // base64url(16 bytes)
const MAX_OUTSTANDING_LINK_CODES = 10;

export const identityLinkCodeSchema = `
  CREATE TABLE IF NOT EXISTS identity_link_codes (
    code_hash TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL REFERENCES agent_identities(identity_id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS identity_link_codes_identity ON identity_link_codes(identity_id, expires_at);
`;

// Purely additive — IF NOT EXISTS is idempotent, no schema version bump,
// and the table is intentionally outside the writer fence (see
// unfencedAdditiveTables): older writers have no code path to it, rows are
// hash-only, and mint/consume verify their own shape on open.
export function ensureIdentityLinkCodeSchema(db) {
  db.exec(identityLinkCodeSchema);
}

export const IDENTITY_SECRET_PREFIX = "pri_";
const IDENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// #1004: member projections are plain objects from JSON.parse. A plain
// members[id] lookup resolves inherited Object.prototype names
// ("constructor", "toString", "valueOf", "hasOwnProperty" all pass
// MEMBER_ID_PATTERN) to truthy functions, so call sites mistake a missing
// member for a conflicting one. All member-map reads in this module go
// through this helper: own properties only, inherited names read as absent.
export const memberOf = (members, id) =>
  members && typeof id === "string" && Object.hasOwn(members, id) ? members[id] : undefined;

export function isIdentitySecret(token) {
  return typeof token === "string" && token.startsWith(IDENTITY_SECRET_PREFIX)
    && /^[A-Za-z0-9_-]{43,128}$/.test(token.slice(IDENTITY_SECRET_PREFIX.length));
}

const legacyHash = text => createHash("sha256").update(text).digest("hex");
const base64url = bytes => Buffer.from(bytes).toString("base64url");

// Identity creation is unauthenticated (an identity alone grants nothing).
// The hard row cap is necessary but not sufficient: anonymous HTTP mints
// are also budgeted per address, per network, and per rolling day, and a
// short proof-of-work is required once an address passes its free quota.
// Anonymous rows that never authenticate, post, or get linked expire, so
// unused signups do not hold the cap. Invite and in-process mints are not
// anonymous and do not spend these budgets.
export const IDENTITY_LIMIT = 5000;
export const IDENTITY_MINT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const IDENTITY_ACTIVATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const ANONYMOUS_MINT_DAILY_LIMIT = 200;
export const ANONYMOUS_ADDRESS_DAILY_LIMIT = 20;
export const ANONYMOUS_NETWORK_DAILY_LIMIT = 80;
export const ANONYMOUS_ADDRESS_MINUTE_LIMIT = 8;
export const ANONYMOUS_PROOF_FREE_PER_ADDRESS = 8;
// 12 leading zero bits (three hex zeros). Clients reproduce
// sha256(`${bucket}:${trim(displayName)}:${nonce}`) with
// bucket = floor(now / IDENTITY_POW_WINDOW_MS). The previous and next
// bucket are accepted so a clock a few minutes off still matches.
export const IDENTITY_POW_BITS = 12;
export const IDENTITY_POW_WINDOW_MS = 10 * 60 * 1000;
const MINT_MINUTE_MS = 60 * 1000;
const PROOF_NONCE = /^[A-Za-z0-9_-]{1,43}$/;

const hashMintKey = value => createHash("sha256").update(`project-room-mint-v1:${value}`).digest("hex");

export function normalizeMintAddress(address) {
  if (typeof address !== "string" || !address.trim()) return "unknown";
  let ip = address.trim().toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  return ip;
}

function expandIPv6(ip) {
  if (!ip.includes(":") || ip.includes(".")) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const parts = [...head, ...Array(missing).fill("0"), ...tail];
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map(part => part.padStart(4, "0"));
}

export function mintNetworkPrefix(address) {
  const ip = normalizeMintAddress(address);
  if (ip === "unknown") return "unknown";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split(".");
    if (parts.every(part => Number(part) <= 255)) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  const groups = expandIPv6(ip);
  if (groups) return `${groups.slice(0, 4).join(":")}::/64`;
  return "unknown";
}

export function anonymousMintBuckets(address) {
  const normalized = normalizeMintAddress(address);
  return Object.freeze({
    address: hashMintKey(`addr:${normalized}`),
    network: hashMintKey(`net:${mintNetworkPrefix(normalized)}`),
  });
}

export function verifyIdentityMintProof(displayName, proof, now = Date.now(), bits = IDENTITY_POW_BITS) {
  if (typeof proof !== "string" || !PROOF_NONCE.test(proof)) return false;
  const name = typeof displayName === "string" ? displayName.trim() : "";
  if (!name || !Number.isInteger(bits) || bits < 4 || bits % 4 !== 0) return false;
  const bucket = Math.floor(now / IDENTITY_POW_WINDOW_MS);
  const prefix = "0".repeat(bits / 4);
  for (const candidate of [bucket - 1, bucket, bucket + 1]) {
    const hex = createHash("sha256").update(`${candidate}:${name}:${proof}`).digest("hex");
    if (hex.startsWith(prefix)) return true;
  }
  return false;
}

// One limiter for anonymous identity mints. POST /api/agent-identities and
// /api/identity-create keep code rate_limited. A referral redeem that mints
// a new identity passes identity_mint_limited. Proof failures stay 428
// proof_required on every caller.
export function enforceAnonymousMintLimits(identities, { name, buckets, proof, requireProof, now, limitCode = "rate_limited" }) {
  const db = identities.db;
  const dayStart = now - IDENTITY_MINT_WINDOW_MS;
  const addressDay = db.prepare(
    "SELECT count(*) AS n FROM agent_identities WHERE mint_address=? AND created_at>=?"
  ).get(buckets.address, dayStart).n;
  const presented = typeof proof === "string" && proof.length > 0;
  if (presented && !verifyIdentityMintProof(name, proof, now, identities.powBits)) {
    fail(428, "proof_required", "Identity mint proof required", null, identities.proofDetail(name, now));
  }
  if (!presented && requireProof && addressDay >= identities.proofFreePerAddress) {
    fail(428, "proof_required", "Identity mint proof required", null, identities.proofDetail(name, now));
  }
  const addressMinute = db.prepare(
    "SELECT count(*) AS n FROM agent_identities WHERE mint_address=? AND created_at>=?"
  ).get(buckets.address, now - MINT_MINUTE_MS).n;
  const limited = (message, retryAfter) => fail(429, limitCode, message, { "Retry-After": String(retryAfter) });
  if (addressMinute >= identities.addressMinuteLimit) limited("Too many identity mints from this address", 60);
  if (addressDay >= identities.addressDailyLimit) limited("Identity mint address budget reached", 3600);
  const networkDay = db.prepare(
    "SELECT count(*) AS n FROM agent_identities WHERE mint_network=? AND created_at>=?"
  ).get(buckets.network, dayStart).n;
  if (networkDay >= identities.networkDailyLimit) limited("Identity mint network budget reached", 3600);
  const globalDay = db.prepare(
    "SELECT count(*) AS n FROM agent_identities WHERE mint_address IS NOT NULL AND created_at>=?"
  ).get(dayStart).n;
  if (globalDay >= identities.anonymousDailyLimit) limited("Identity mint daily budget reached", 3600);
}

export function solveIdentityMintProof(displayName, now = Date.now(), bits = IDENTITY_POW_BITS) {
  const name = typeof displayName === "string" ? displayName.trim() : "";
  const bucket = Math.floor(now / IDENTITY_POW_WINDOW_MS);
  const prefix = "0".repeat(bits / 4);
  for (let i = 0; i < 1_000_000; i++) {
    const nonce = i.toString(36);
    const hex = createHash("sha256").update(`${bucket}:${name}:${nonce}`).digest("hex");
    if (hex.startsWith(prefix)) return nonce;
  }
  throw new Error("proof search exhausted");
}

// Machine-readable next steps for a brand-new agent. The signup response
// is the first thing a cold agent sees: instead of returning a secret with
// no direction, it names the concrete first actions (create your own room,
// join via invite, request access, read the manifest/quickstart). All of
// them are self-serve or unauthenticated; nothing here needs a human tap.
const SIGNUP_NEXT = Object.freeze([
  Object.freeze({ action: "create-room", method: "POST", path: "/api/agent-rooms",
    description: "Create your own room and become its owner — no human approval needed. Send this identity secret as the bearer token." }),
  Object.freeze({ action: "redeem-invite", method: "POST", path: "/api/agent-invites/redeem",
    description: "Join a room with a one-time invite code. Ask any room member who can invite for a code, or check /api/agent-invites/preview." }),
  Object.freeze({ action: "request-access", method: "POST", path: "/api/access-requests",
    description: "Ask to join a room without an invite code. The room owner decides; poll the request status." }),
  Object.freeze({ action: "read-manifest", method: "GET", path: "/api/agent-manifest",
    description: "The agent plug-in manifest: auth schemes, enrollment flows, API-key scopes, and the agent surface." }),
  Object.freeze({ action: "read-quickstart", doc: "docs/AGENT-QUICKSTART.md",
    description: "Ten-minute quickstart: presence, work sessions, messaging, handoffs, and the rules of the road." }),
  // Burs-IA steal A1: the mint response names the tools-list surface so a
  // cold agent learns its capabilities without reading llms.txt.
  Object.freeze({ action: "list-tools", method: "POST", path: "/room/mcp",
    description: "See what this identity can do: POST { jsonrpc: \"2.0\", id: \"1\", method: \"tools/list\" } to /room/mcp with Authorization: Bearer <secret>. Without a credential it lists seven tools: the four public join tools plus public_work_recommend, public_work_read_task, and room_identity_mint (mint your own identity secret over MCP); with it, the enrolled room profile." }),
]);

export class AgentIdentities {
  constructor(store, {
    identityLimit = IDENTITY_LIMIT,
    anonymousDailyLimit = ANONYMOUS_MINT_DAILY_LIMIT,
    addressDailyLimit = ANONYMOUS_ADDRESS_DAILY_LIMIT,
    networkDailyLimit = ANONYMOUS_NETWORK_DAILY_LIMIT,
    addressMinuteLimit = ANONYMOUS_ADDRESS_MINUTE_LIMIT,
    proofFreePerAddress = ANONYMOUS_PROOF_FREE_PER_ADDRESS,
    activationWindowMs = IDENTITY_ACTIVATION_WINDOW_MS,
    powBits = IDENTITY_POW_BITS,
    hashKey = undefined,
  } = {}) {
    const positive = (label, value) => {
      if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
    };
    positive("identityLimit", identityLimit);
    positive("anonymousDailyLimit", anonymousDailyLimit);
    positive("addressDailyLimit", addressDailyLimit);
    positive("networkDailyLimit", networkDailyLimit);
    positive("addressMinuteLimit", addressMinuteLimit);
    positive("activationWindowMs", activationWindowMs);
    if (!Number.isInteger(proofFreePerAddress) || proofFreePerAddress < 0) throw new Error("proofFreePerAddress must be a non-negative integer");
    if (!Number.isInteger(powBits) || powBits < 4 || powBits > 32 || powBits % 4 !== 0) throw new Error("powBits must be a multiple of 4 between 4 and 32");
    this.store = store;
    this.db = store.db;
    this.identityLimit = identityLimit;
    this.anonymousDailyLimit = anonymousDailyLimit;
    this.addressDailyLimit = addressDailyLimit;
    this.networkDailyLimit = networkDailyLimit;
    this.addressMinuteLimit = addressMinuteLimit;
    this.proofFreePerAddress = proofFreePerAddress;
    this.activationWindowMs = activationWindowMs;
    this.powBits = powBits;
    this.pendingActivation = new Set();
    this.pendingHashUpgrades = new Map();
    this.capacitySchemaReady = false;
    // undefined → process.env (Node and tests). null → no configured key,
    // built-in fallback only (Worker deploy that has not set the secret).
    this.hashKey = hashKey === undefined ? process.env : hashKey;
  }

  // Creates a new global agent identity. The secret is shown once and only
  // its hash is stored. An identity alone grants nothing: a room owner must
  // link it into each room. The response carries SIGNUP_NEXT so a cold
  // agent knows its first moves without asking a human.
  //
  // `anonymous` marks an unauthenticated HTTP mint. Those rows spend the
  // address, network, and daily budgets and stay inactive until the holder
  // authenticates, posts, or is linked. Invite and in-process mints omit it.
  create(displayName, { secret: suppliedSecret, anonymous } = {}) {
    const name = typeof displayName === "string" ? displayName.trim() : "";
    if (!name || name.length > 80) fail(422, "invalid_identity", "displayName must be 1-80 characters");
    // RC-2026-09-19-086: reject C0 control chars like share-link join does
    // (422 there) — storing them raw corrupts logs, exports, and renders.
    if (/[\u0000-\u001f\u007f]/.test(name)) fail(422, "invalid_identity", "displayName must not contain control characters");
    assertNotReservedRoleName(name); // Q3-D: role-like names are refused at mint
    if (suppliedSecret !== undefined && !/^pri_[A-Za-z0-9_-]{43}$/.test(suppliedSecret))
      fail(422, "invalid_identity", "Recoverable registration requires a generated identity credential");
    return this.store.transaction(() => {
      ensureIdentitySecretSchema(this.db);
      ensureIdentityCapacitySchema(this.db);
      this.capacitySchemaReady = true;
      this.expireInactive();
      const recoveredId = suppliedSecret === undefined ? null : `ai_${legacyHash(suppliedSecret).slice(0, 40)}`;
      if (recoveredId) {
        const existing = this.db.prepare("SELECT * FROM agent_identities WHERE identity_id=?").get(recoveredId);
        if (existing) {
          // Same lookup as bearer auth: HMAC and sha256 first, scrypt only
          // when this row is still a v2 verifier.
          const matched = existing.revoked_at === null && this.rowForSecret(suppliedSecret, { identityId: recoveredId });
          if (!matched)
            fail(409, "identity_credential_changed", "Identity credential changed; use the current saved identity");
          this.noteActivated(recoveredId);
          return { identityId: recoveredId, displayName: existing.display_name, duplicate: true,
            next: SIGNUP_NEXT, nextActions: nextActionsForIdentityMint() };
        }
        // The credential may belong to an identity minted through the normal
        // path (random identity id): the derived id cannot match, so recover
        // by secret. Without this, the INSERT below violates the UNIQUE
        // secret_hash and the request 500s (QA2 signed-in agent journey).
        const bySecret = this.rowForSecret(suppliedSecret);
        if (bySecret) {
          this.noteActivated(bySecret.identityId);
          return { identityId: bySecret.identityId, displayName: bySecret.displayName, duplicate: true,
            next: SIGNUP_NEXT, nextActions: nextActionsForIdentityMint() };
        }
        // A revoked identity still holds its secret hash: recovery of a
        // revoked credential is an honest 409, never a UNIQUE-violation 500.
        const candidates = [...fastIdentityHashCandidates(suppliedSecret, this.hashKey), legacyIdentityHash(suppliedSecret)];
        const revokedHit = candidates.some(hash => this.db.prepare(
          "SELECT 1 FROM agent_identities WHERE revoked_at IS NOT NULL AND (secret_hash=? OR fallback_secret_hash=?)").get(hash, hash));
        if (revokedHit)
          fail(409, "identity_credential_changed", "Identity credential changed; use the current saved identity");
      }
      // Keep the existing credential-recovery path above idempotent. Global
      // identity names are not unique: ordinary exact-name duplicates remain
      // possible, but a visually deceptive spelling of an existing active
      // name cannot be minted. Room-local collisions are checked at link.
      // Preserve ordinary case/space variants already supported by the
      // protocol; NFKC width/style lookalikes remain distinct and are blocked.
      const canonical = value => value.trim().replace(/\p{White_Space}+/gu, " ").toLowerCase();
      const activeNames = this.db.prepare("SELECT identity_id AS identityId, display_name AS displayName FROM agent_identities WHERE revoked_at IS NULL").all()
        .filter(row => canonical(row.displayName) !== canonical(name));
      const checked = checkAgentDisplayName(name, { activeNames });
      if (!checked.safe) fail(422, "invalid_identity", "displayName contains unsafe characters");
      const now = this.store.now();
      let activatedAt = now;
      let mintAddress = null;
      let mintNetwork = null;
      if (anonymous && typeof anonymous === "object") {
        const buckets = anonymousMintBuckets(anonymous.address);
        this.admitAnonymous(name, buckets, anonymous.proof, anonymous.requireProof !== false, now, anonymous.limitCode);
        activatedAt = null;
        mintAddress = buckets.address;
        mintNetwork = buckets.network;
      }
      const count = this.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n;
      if (count >= this.identityLimit) fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
      const identityId = recoveredId ?? `ai_${base64url(randomBytes(12))}`;
      const secret = suppliedSecret ?? `${IDENTITY_SECRET_PREFIX}${base64url(randomBytes(32))}`;
      ensureIdentitySecretSchema(this.db);
      const verifier = this.verifierColumns(secret);
      this.db.prepare("INSERT INTO agent_identities(identity_id,secret_hash,fallback_secret_hash,display_name,created_at,activated_at,mint_address,mint_network) VALUES(?,?,?,?,?,?,?,?)")
        .run(identityId, verifier.secretHash, verifier.fallbackHash, name, now, activatedAt, mintAddress, mintNetwork);
      // Bind the identity's Ed25519 claim-signing key at issuance: the
      // public key is registered in the agent-key registry (the
      // operator-attested binding — see server/agent-key-registry.mjs) and
      // the private seed is shown once, like the secret. The agent signs
      // public-key claims (signed-claims.mjs ed25519 mode) with it, so
      // cross-room claim verification needs no shared secret.
      const keyPair = generateEd25519KeyPair();
      this.store.keyRegistry.registerKey(identityId, keyPair.publicKey, { validFrom: now });
      return { identityId, displayName: name, ...(recoveredId ? { duplicate: false } : { secret }),
        publicKey: keyPair.publicKey, privateKey: keyPair.privateKey,
        next: SIGNUP_NEXT, nextActions: nextActionsForIdentityMint() };
    });
  }

  // Enough for a raw HTTP or MCP client to mint a nonce without the Node
  // client: SHA-256 hex of {bucket}:{trimmedDisplayName}:{nonce} must start
  // with prefix, nonce matches nonce, and bucket is one of acceptBuckets.
  proofDetail(name, now) {
    const bucket = Math.floor(now / IDENTITY_POW_WINDOW_MS);
    const prefix = "0".repeat(this.powBits / 4);
    return {
      proof: {
        algorithm: "sha256-prefix",
        hash: "sha256",
        encoding: "hex",
        bits: this.powBits,
        prefix,
        input: "{bucket}:{trimmedDisplayName}:{nonce}",
        challenge: `${bucket}:${name}`,
        bucket,
        acceptBuckets: [bucket - 1, bucket, bucket + 1],
        windowMs: IDENTITY_POW_WINDOW_MS,
        nonce: PROOF_NONCE.source,
        resend: { method: "POST", fields: ["displayName", "proof"] },
      },
    };
  }

  admitAnonymous(name, buckets, proof, requireProof, now, limitCode = "rate_limited") {
    enforceAnonymousMintLimits(this, { name, buckets, proof, requireProof, now, limitCode });
  }

  // Keep an anonymous row that still holds a room membership, an invite, or
  // a pending claim. Clauses are static and only added when the table exists.
  // NULL owners are excluded so a claim without an owner cannot make NOT IN
  // unknown for every identity.
  retentionClauses() {
    const table = name => this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const clauses = ["AND identity_id NOT IN (SELECT identity_id FROM identity_links)"];
    if (table("agent_room_ownership")) {
      clauses.push("AND identity_id NOT IN (SELECT identity_id FROM agent_room_ownership)");
    }
    if (table("guest_members")) {
      clauses.push("AND identity_id NOT IN (SELECT guest_identity_id FROM guest_members)");
    }
    if (table("agent_invite_codes")) {
      clauses.push(`AND identity_id NOT IN (
        SELECT redeemed_identity_id FROM agent_invite_codes WHERE redeemed_identity_id IS NOT NULL
        UNION SELECT created_by FROM agent_invite_codes WHERE revoked_at IS NULL
      )`);
    }
    if (table("referral_invites")) {
      clauses.push("AND identity_id NOT IN (SELECT redeemed_identity_id FROM referral_invites WHERE redeemed_identity_id IS NOT NULL)");
    }
    if (table("guest_invites")) {
      clauses.push("AND identity_id NOT IN (SELECT redeemed_by_identity_id FROM guest_invites WHERE redeemed_by_identity_id IS NOT NULL)");
    }
    if (table("work_claims")) {
      clauses.push(`AND identity_id NOT IN (
        SELECT owner_id FROM (
          SELECT COALESCE(json_extract(item_json, '$.data.owner'), json_extract(item_json, '$.owner')) AS owner_id
          FROM work_claims
          WHERE COALESCE(json_extract(item_json, '$.data.state'), json_extract(item_json, '$.state'))
            IN ('claimed', 'in_progress', 'blocked')
        ) WHERE owner_id IS NOT NULL
      )`);
    }
    if (table("rooms")) {
      // Uncorrelated: one work-item scan for the whole sweep. The previous
      // NOT EXISTS re-parsed every projection once per identity candidate.
      clauses.push(`AND identity_id NOT IN (
        SELECT json_extract(item.value, '$.claim.holderId')
        FROM rooms, json_each(rooms.projection, '$.workItems') AS item
        WHERE json_extract(item.value, '$.claim.status') = 'active'
          AND json_extract(item.value, '$.claim.holderId') IS NOT NULL
      )`);
    }
    return clauses.join("\n");
  }

  // Drops anonymous rows that were never authenticated, posted, or linked
  // and that hold no membership, invite, or pending claim. Runs inside the
  // caller's transaction when one is open, so a refused mint rolls the
  // delete back with it. Rows without a mint address are invite and
  // in-process identities and are kept.
  expireInactive() {
    if (this.store.readOnly) return 0;
    if (!this.db.isTransaction) return this.store.transaction(() => this.expireInactive());
    ensureIdentityCapacitySchema(this.db);
    const table = name => this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!table("agent_identities") || !table("identity_links")) return 0;
    const cutoff = this.store.now() - this.activationWindowMs;
    const stale = this.db.prepare(`
      SELECT COUNT(*) AS n FROM agent_identities
      WHERE mint_address IS NOT NULL AND activated_at IS NULL AND revoked_at IS NULL AND created_at < ?
    `).get(cutoff).n;
    if (!stale) return 0;
    const keep = this.retentionClauses();
    const rows = this.db.prepare(`
      SELECT identity_id AS identityId FROM agent_identities
      WHERE mint_address IS NOT NULL AND activated_at IS NULL AND revoked_at IS NULL AND created_at < ?
        ${keep}
    `).all(cutoff);
    let removed = 0;
    for (const row of rows) {
      if (this.store.agentPlugin && table("agent_api_keys")) this.store.agentPlugin.revokeApiKeysForIdentity(row.identityId);
      if (table("identity_link_codes")) this.db.prepare("DELETE FROM identity_link_codes WHERE identity_id=?").run(row.identityId);
      if (table("agent_skill_cards")) this.db.prepare("DELETE FROM agent_skill_cards WHERE identity_id=?").run(row.identityId);
      const changed = this.db.prepare(`
        DELETE FROM agent_identities
        WHERE identity_id=? AND mint_address IS NOT NULL AND activated_at IS NULL AND revoked_at IS NULL
          ${keep}
      `).run(row.identityId);
      removed += changed.changes;
    }
    return removed;
  }

  capacityReady() {
    if (this.capacitySchemaReady) return true;
    const columns = new Set(this.db.prepare("PRAGMA table_info(agent_identities)").all().map(column => column.name));
    if (!columns.has("activated_at")) return false;
    this.capacitySchemaReady = true;
    return true;
  }

  // Authentication, a post, or a link keeps an anonymous identity. Read
  // transactions cannot write, so those stamps flush after the read commits.
  noteActivated(identityId) {
    if (!identityId || this.store.readOnly) return;
    if ((this.store.readTransactionDepth ?? 0) > 0) {
      if (!this.pendingActivation.has(identityId)) {
        this.pendingActivation.add(identityId);
        queueMicrotask(() => this.flushActivation());
      }
      return;
    }
    this.stampActivated(identityId);
  }

  stampActivated(identityId) {
    if (this.store.readOnly || !this.capacityReady()) return;
    this.db.prepare(
      "UPDATE agent_identities SET activated_at=? WHERE identity_id=? AND activated_at IS NULL AND revoked_at IS NULL"
    ).run(this.store.now(), identityId);
  }

  flushActivation() {
    // isTransaction throws once the database is closed. A read can queue this
    // microtask and the caller can close the store before it runs.
    if (this.store.readOnly || this.db.isOpen === false) {
      this.pendingActivation.clear();
      return;
    }
    let busy = false;
    try {
      busy = (this.store.readTransactionDepth ?? 0) > 0 || this.db.isTransaction;
    } catch {
      this.pendingActivation.clear();
      return;
    }
    if (busy) {
      queueMicrotask(() => this.flushActivation());
      return;
    }
    const ids = [...this.pendingActivation];
    this.pendingActivation.clear();
    if (!ids.length) return;
    try {
      this.store.transaction(() => {
        for (const id of ids) this.stampActivated(id);
      });
    } catch { /* a closed store must not surface on the read that queued this */ }
  }

  get(identityId) {
    return this.db.prepare("SELECT identity_id AS identityId, display_name AS displayName, created_at AS createdAt FROM agent_identities WHERE identity_id=?").get(identityId) ?? null;
  }

  noteMcpUse(identityId, { legacy = false, ua = null, at = null } = {}) {
    const when = Number.isSafeInteger(at) ? at : this.store.now();
    const agent = typeof ua === "string" && ua.trim() ? ua.trim().slice(0, 200) : null;
    this.db.prepare(`UPDATE agent_identities SET last_used_at=?, last_used_ua=?, mcp_legacy_uses=COALESCE(mcp_legacy_uses, 0) + ?
      WHERE identity_id=?`).run(when, agent, legacy ? 1 : 0, identityId);
  }

  mcpUsage(identityId) {
    return this.db.prepare(`SELECT last_used_at AS lastUsedAt, last_used_ua AS lastUsedUa, mcp_legacy_uses AS mcpLegacyUses
      FROM agent_identities WHERE identity_id=?`).get(identityId) ?? null;
  }

  // Owner-only: link an identity into a room, creating one member record
  // bound to it. The agent then uses its single identity secret here.
  // RC-2026-09-18-038: a membership-administration delegate may also link,
  // because decide() drives link() with the approver's token — approving an
  // access request is exactly what the delegation exists for.
  link(token, roomId, { identityId, memberId, displayName, permissions, referredBy, settleAccessRequests = true }, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!this.store.delegation.canAdministerMembership(authority, auth, roomId)) fail(403, "access_denied", "Membership administration grant required");
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)) fail(422, "invalid_identity", "identityId is not a valid agent identity");
    const identity = this.get(identityId);
    if (!identity) fail(404, "identity_not_found", "No such agent identity");
    // RC-2026-09-18-049: rooms that require verified agents deny linking an
    // unverified identity. The plug-in store is optional in unit fixtures.
    const plugin = this.store.agentPlugin;
    if (plugin && plugin.roomVerificationPolicy(roomId).requireVerified
      && plugin.verificationLevel(identityId) !== "verified") {
      fail(403, "unverified_identity", "This room only admits verified agents; have a room owner verify the identity first");
    }
    const resolvedMemberId = memberId ?? identityId;
    if (!MEMBER_ID_PATTERN.test(resolvedMemberId)) fail(422, "invalid_identity", "memberId must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}");
    if (!Array.isArray(permissions)) fail(422, "invalid_identity", "permissions must be an array; an empty array links the identity with read/chat access only");
    // RC-2026-09-18-038: a delegate acting on an owner grant may link members
    // but may never confer manage_members — that would make the grant
    // transitive. The owner (or a member already holding manage_members)
    // remains sovereign.
    if (permissions.includes("manage_members") && !this.store.delegation.mayConferManageMembers(authority, auth)) {
      fail(403, "access_denied", "Delegated membership administration cannot grant manage_members");
    }
    const unheld = this.store.delegation.unheldPermissions(authority, auth, permissions);
    if (unheld.length) fail(403, "access_denied", `Cannot grant permissions not held: ${unheld.join(", ")}. Link with permissions you hold, or ask the room owner`);
    if (displayName !== undefined && (typeof displayName !== "string" || displayName.length > 80)) fail(422, "invalid_identity", "displayName must be text of at most 80 characters");
    // Referral attribution: optional member id of the referrer, written onto
    // the new member record and journaled via referral.completed. Shape is
    // validated here; the member.added event validator re-validates it.
    if (referredBy !== undefined && (typeof referredBy !== "string" || !MEMBER_ID_PATTERN.test(referredBy))) {
      fail(422, "invalid_identity", "referredBy must be a member id");
    }
    return this.store.transaction(() => {
      const existing = this.db.prepare("SELECT 1 FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
      if (existing) fail(409, "identity_already_linked", "This identity is already linked to this room");
      // #1004: resolve through the own-property helper, not a bare lookup.
      // An inherited Object.prototype name ("constructor", "toString",
      // "valueOf", "hasOwnProperty" — all pass MEMBER_ID_PATTERN) would
      // resolve to a truthy function and fail closed with a misleading 409
      // identity_conflict ("Member id is already taken"). memberOf reads own
      // properties only; a name that exists solely on the prototype is a
      // reserved name and is refused with a clean 422 here.
      const roomMembers = this.store.roomAuthority(roomId).members ?? {};
      if (!Object.hasOwn(roomMembers, resolvedMemberId) && resolvedMemberId in roomMembers)
        fail(422, "invalid_identity", "memberId is a reserved name");
      const roomMember = memberOf(roomMembers, resolvedMemberId);
      if (roomMember) {
        // Re-linking after an unlink: the member record (bound to this
        // identity) is reused and reactivated. A foreign member holding the
        // id is a conflict.
        if (roomMember.identityId !== identityId) fail(409, "identity_conflict", "Member id is already taken");
        // The permissions the owner supplies now win; the stale record's
        // grants must not come back silently.
        const samePermissions = JSON.stringify([...roomMember.permissions].sort()) === JSON.stringify([...permissions].sort());
        if (roomMember.active === false || !samePermissions) {
          this.store.command(token, roomId, { id: randomUUID(), type: "member.access_changed",
            data: { memberId: resolvedMemberId, expectedMemberRevision: roomMember.revision, permissions, active: true } }, expectedSessionBinding);
        }
        this.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
          .run(roomId, identityId, resolvedMemberId, this.store.now());
        if (settleAccessRequests) this.closePendingAccessRequests(roomId, identityId, auth.member.id);
        this.noteActivated(identityId);
        refreshDirectoryIdentity(this.store, identityId);
        return { roomId, identityId, memberId: resolvedMemberId, relinked: true };
      }
      const memberName = displayName?.trim() || identity.displayName;
      // Compare against active room members inside the writer transaction,
      // not an earlier snapshot. Exact duplicates and reserved labels are
      // refused by the live member.added guard. This check still blocks
      // deceptive alternate spellings, mixed scripts, and invisible characters
      // before that command. Same-identity relinks keep the path above.
      const canonical = value => value.trim().replace(/\p{White_Space}+/gu, " ").toLowerCase();
      const activeNames = Object.values(this.store.room(roomId).state.members)
        .filter(member => member.active !== false && member.id !== resolvedMemberId
          && canonical(member.displayName) !== canonical(memberName))
        .map(member => ({ memberId: member.id, displayName: member.displayName }));
      assertNotReservedRoleName(memberName); // Q3-D: and when the identity joins a room
      const checked = checkAgentDisplayName(memberName, { activeNames });
      if (!checked.safe) fail(422, "invalid_identity", "displayName is unsafe or already used in this room");
      this.store.command(token, roomId, { id: randomUUID(), type: "member.added",
        data: { memberId: resolvedMemberId, displayName: memberName, kind: "agent", permissions, identityId,
          ...(referredBy ? { referredBy } : {}) } }, expectedSessionBinding);
      this.db.prepare("INSERT INTO identity_links(room_id,identity_id,member_id,linked_at) VALUES(?,?,?,?)")
        .run(roomId, identityId, resolvedMemberId, this.store.now());
      if (settleAccessRequests) this.closePendingAccessRequests(roomId, identityId, auth.member.id);
      this.noteActivated(identityId);
      refreshDirectoryIdentity(this.store, identityId);
      return { roomId, identityId, memberId: resolvedMemberId };
    });
  }

  // A direct grant used to leave the identity's pending join request in the
  // owner queue. Close those rows when this link is the grant. Callers that
  // record their own decision (access-request approve) pass
  // settleAccessRequests: false. Fixtures without the access-request table
  // are unchanged.
  closePendingAccessRequests(roomId, identityId, decidedBy) {
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='access_requests'").get();
    if (!table) return 0;
    return this.db.prepare(
      `UPDATE access_requests SET status='approved', decided_at=?, decided_by=?, decision_note=?
       WHERE room_id=? AND identity_id=? AND status='pending'`
    ).run(this.store.now(), decidedBy, "closed because this identity was linked directly", roomId, identityId).changes;
  }

  // Owner-only: unlink an identity; the room member is deactivated but its
  // history stays in the event log.
  unlink(token, roomId, identityId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration grant required");
    return this.store.transaction(() => {
      const link = this.db.prepare("SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
      if (!link) fail(404, "identity_not_found", "This identity is not linked to this room");
      const member = memberOf(this.store.roomAuthority(roomId).members, link.memberId);
      if (member?.active !== false) {
        this.store.command(token, roomId, { id: randomUUID(), type: "member.access_changed",
          data: { memberId: link.memberId, expectedMemberRevision: member.revision, permissions: member.permissions, active: false } }, expectedSessionBinding);
      }
      this.db.prepare("DELETE FROM identity_links WHERE room_id=? AND identity_id=?").run(roomId, identityId);
      refreshDirectoryIdentity(this.store, identityId);
      return { roomId, identityId, memberId: link.memberId, unlinked: true };
    });
  }

  // Active HMAC plus the built-in fallback when a Worker/Node key is set.
  verifierColumns(secret) {
    const [secretHash, fallback] = fastIdentityHashCandidates(secret, this.hashKey);
    return { secretHash, fallbackHash: fallback && fallback !== secretHash ? fallback : null };
  }

  selectVerifier(hash, identityId) {
    const sql = `SELECT identity_id AS identityId, display_name AS displayName, secret_hash AS secretHash
      FROM agent_identities WHERE revoked_at IS NULL AND `;
    if (identityId) {
      return this.db.prepare(sql + "identity_id=? AND (secret_hash=? OR fallback_secret_hash=?)").get(identityId, hash, hash);
    }
    return this.db.prepare(sql + "(secret_hash=? OR fallback_secret_hash=?)").get(hash, hash);
  }

  // HMAC (active key and built-in fallback) and legacy sha256 are indexed
  // lookups. Scrypt runs only for a candidate that is still v2: the row
  // selected by identity id, or — when the caller has no id — one digest
  // used to find an unupgraded row. A well-formed secret that matches
  // neither, and that is not needed to recognize a remaining v2 row, does
  // not run the KDF. At most one scrypt per call; the module cache makes a
  // second call in the same request free.
  rowForSecret(secret, { identityId = null } = {}) {
    const hmacs = fastIdentityHashCandidates(secret, this.hashKey);
    const legacy = legacyIdentityHash(secret);
    for (const hash of hmacs) {
      const row = this.selectVerifier(hash, identityId);
      if (!row) continue;
      this.maybeUpgradeFastRow(row, secret);
      return row;
    }
    const legacyRow = this.selectVerifier(legacy, identityId);
    if (legacyRow) {
      this.upgradeStoredHash(legacyRow.identityId, secret, legacyRow.secretHash);
      return legacyRow;
    }
    if (identityId) {
      const row = this.db.prepare(`SELECT identity_id AS identityId, display_name AS displayName, secret_hash AS secretHash
        FROM agent_identities WHERE identity_id=? AND revoked_at IS NULL`).get(identityId);
      // Known id whose verifier is already HMAC or sha256 was handled above.
      // A miss here is an unknown secret for that id, unless the row is v2.
      if (!row || !isV2IdentityHash(row.secretHash)) return null;
      if (scryptIdentityHash(secret) !== row.secretHash) return null;
      this.upgradeStoredHash(row.identityId, secret, row.secretHash);
      return row;
    }
    // Bearer calls do not carry an identity id. A remaining v2 row can be
    // found only by its scrypt verifier, so one KDF runs while any such row
    // is left. After that row upgrades, an unknown secret returns here
    // without a KDF. Identity-id callers never reach this branch.
    if (!this.hasUnindexedScryptRow()) return null;
    const digested = scryptIdentityHash(secret);
    const row = this.selectVerifier(digested, null);
    if (!row) return null;
    this.upgradeStoredHash(row.identityId, secret, row.secretHash);
    return row;
  }

  // A row found by HMAC is current unless the stored primary is still the
  // built-in fallback and a Worker/Node key is now configured.
  maybeUpgradeFastRow(row, secret) {
    const next = this.verifierColumns(secret);
    if (row.secretHash === next.secretHash) return;
    this.upgradeStoredHash(row.identityId, secret, row.secretHash);
  }

  hasUnindexedScryptRow() {
    if (this._unindexedScrypt === false) return false;
    const columns = new Set(this.db.prepare("PRAGMA table_info(agent_identities)").all().map(column => column.name));
    const row = columns.has("fallback_secret_hash")
      ? this.db.prepare("SELECT 1 FROM agent_identities WHERE secret_hash LIKE 'v2:%' AND revoked_at IS NULL LIMIT 1").get()
      : this.db.prepare("SELECT 1 FROM agent_identities WHERE secret_hash LIKE 'v2:%' LIMIT 1").get();
    if (!row) this._unindexedScrypt = false;
    return !!row;
  }

  // Conditional on the exact verifier just matched, so a concurrent
  // rotate/revoke that lands first wins. Read transactions cannot write;
  // the upgrade flushes after the read commits, same as activation stamps.
  upgradeStoredHash(identityId, secret, previousHash) {
    if (!identityId || !previousHash || this.store.readOnly) return;
    const next = this.verifierColumns(secret);
    if (previousHash === next.secretHash) return;
    this._unindexedScrypt = undefined;
    if ((this.store.readTransactionDepth ?? 0) > 0) {
      this.pendingHashUpgrades.set(identityId, { next, previousHash });
      queueMicrotask(() => this.flushHashUpgrades());
      return;
    }
    this.db.prepare("UPDATE agent_identities SET secret_hash=?, fallback_secret_hash=? WHERE identity_id=? AND secret_hash=? AND revoked_at IS NULL")
      .run(next.secretHash, next.fallbackHash, identityId, previousHash);
  }

  flushHashUpgrades() {
    if (this.store.readOnly || this.db.isOpen === false) {
      this.pendingHashUpgrades.clear();
      return;
    }
    let busy = false;
    try {
      busy = (this.store.readTransactionDepth ?? 0) > 0 || this.db.isTransaction;
    } catch {
      this.pendingHashUpgrades.clear();
      return;
    }
    if (busy) {
      queueMicrotask(() => this.flushHashUpgrades());
      return;
    }
    const pending = [...this.pendingHashUpgrades.entries()];
    this.pendingHashUpgrades.clear();
    if (!pending.length) return;
    try {
      this.store.transaction(() => {
        const update = this.db.prepare("UPDATE agent_identities SET secret_hash=?, fallback_secret_hash=? WHERE identity_id=? AND secret_hash=? AND revoked_at IS NULL");
        for (const [identityId, { next, previousHash }] of pending) update.run(next.secretHash, next.fallbackHash, identityId, previousHash);
      });
    } catch { /* a closed store must not surface on the read that queued this */ }
  }

  // Proves ownership of an identity secret: the presented secret must be
  // the identity's CURRENT, unrevoked secret. Used by rotate/revoke; a
  // revoked secret fails here, so revoke is final — there is no other
  // owner credential for a self-minted identity.
  authenticateIdentitySecret(identityId, secret) {
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)) fail(401, "unauthenticated", "Unknown agent identity");
    if (!isIdentitySecret(secret)) fail(401, "unauthenticated", "Unknown agent identity");
    const row = this.rowForSecret(secret, { identityId });
    if (!row) fail(401, "unauthenticated", "Unknown or revoked agent identity secret");
    this.noteActivated(row.identityId);
    return { identityId: row.identityId, displayName: row.displayName };
  }

  // Owner-only: rotate an identity secret. The old secret stops working
  // atomically with the issue of the new one; the new secret is returned
  // once (shown once, like the scoped-key rotation in RC-2026-09-18-050).
  // The old secret never appears in any response. Rotating a revoked
  // identity is rejected — revoke is the final state.
  //
  // Rotation is the compromise response ("Rotate instead when you need
  // continuity"), so every scoped API key the identity minted is revoked
  // with it: a key an attacker minted while holding the old secret must
  // not survive the rotation. The same invariant revoke() enforces — a
  // rotated identity must not keep operating through a key it minted
  // earlier — holds here too.
  rotate(identityId, secret) {
    const identity = this.authenticateIdentitySecret(identityId, secret);
    forgetIdentityVerifier(secret);
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT revoked_at AS revokedAt, secret_hash AS secretHash FROM agent_identities WHERE identity_id=?").get(identityId);
      if (!row) fail(404, "identity_not_found", "No such agent identity");
      if (row.revokedAt !== null) fail(409, "identity_revoked", "This identity's secret is revoked; it cannot rotate");
      const newSecret = `${IDENTITY_SECRET_PREFIX}${base64url(randomBytes(32))}`;
      const next = this.verifierColumns(newSecret);
      // Conditional update on the CURRENT stored hash (authenticate above
      // already upgraded a legacy row): a concurrent revoke/rotate that
      // lands first must win — the stale rotation is rejected instead of
      // resurrecting a revoked secret or double-issuing.
      const changed = this.db.prepare("UPDATE agent_identities SET secret_hash=?, fallback_secret_hash=?, revoked_at=NULL WHERE identity_id=? AND revoked_at IS NULL AND secret_hash=?")
        .run(next.secretHash, next.fallbackHash, identityId, row.secretHash);
      if (changed.changes !== 1) fail(409, "secret_changed", "The secret changed during rotation; re-read state and retry");
      const revokedApiKeys = this.store.agentPlugin ? this.store.agentPlugin.revokeApiKeysForIdentity(identityId) : 0;
      return { identityId, displayName: identity.displayName, secret: newSecret, rotatedAt: this.store.now(), revokedApiKeys };
    });
  }

  // Owner-only: revoke an identity secret. The secret stops authenticating
  // everywhere immediately (resolveGlobalIdentitySecret and
  // resolveIdentityAuth both refuse revoked rows); the identity row stays
  // for audit, and room links stay untouched — unlinking remains a separate
  // owner-only per-room action. Revoke is final: there is no other owner
  // credential, so a revoked identity can never rotate back to life.
  // Scoped API keys bound to the identity are revoked too — a revoked
  // identity must not keep operating through a key it minted earlier.
  revoke(identityId, secret) {
    const identity = this.authenticateIdentitySecret(identityId, secret);
    forgetIdentityVerifier(secret);
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT revoked_at AS revokedAt FROM agent_identities WHERE identity_id=?").get(identityId);
      if (!row) fail(404, "identity_not_found", "No such agent identity");
      const revokedAt = row.revokedAt ?? this.store.now();
      if (row.revokedAt === null) {
        this.db.prepare("UPDATE agent_identities SET revoked_at=? WHERE identity_id=?").run(revokedAt, identityId);
      }
      const revokedApiKeys = this.store.agentPlugin ? this.store.agentPlugin.revokeApiKeysForIdentity(identityId) : 0;
      return { identityId, displayName: identity.displayName, revoked: true, revokedAt, revokedApiKeys };
    });
  }

  // Whether an identity's secret is revoked. Read surface only.
  secretRevoked(identityId) {
    const row = this.db.prepare("SELECT revoked_at AS revokedAt FROM agent_identities WHERE identity_id=?").get(identityId);
    return row ? row.revokedAt !== null : null;
  }

  // RC-2026-09-24-210: mint a single-use identity link code.
  //
  // The caller proves possession of the identity's CURRENT, unrevoked
  // secret — the mint IS the holder's consent to enroll this identity
  // (no separate consent step; a sponsor's credential or scoped API key
  // can never mint). The raw code is returned once; only its SHA-256 hash
  // is stored, bound to the identityId, with a 10-minute TTL. Unknown
  // identityIds 404 (no secret can ever authenticate for them, so the
  // check order leaks nothing).
  mintLinkCode(identityId, secret) {
    if (typeof identityId !== "string" || !IDENTITY_ID_PATTERN.test(identityId)
      || !this.db.prepare("SELECT 1 FROM agent_identities WHERE identity_id=?").get(identityId)) {
      fail(404, "identity_not_found", "No such agent identity");
    }
    const identity = this.authenticateIdentitySecret(identityId, secret);
    return this.store.transaction(() => {
      const now = this.store.now();
      // Sweep expired rows on every mint: consumed rows die with their TTL,
      // so the table stays bounded without a background job.
      this.db.prepare("DELETE FROM identity_link_codes WHERE expires_at <= ?").run(now);
      const outstanding = this.db.prepare(
        "SELECT count(*) AS n FROM identity_link_codes WHERE identity_id=? AND consumed_at IS NULL").get(identityId).n;
      if (outstanding >= MAX_OUTSTANDING_LINK_CODES) {
        fail(429, "too_many_link_codes", "Too many outstanding link codes; use one or let it expire");
      }
      const code = base64url(randomBytes(LINK_CODE_BYTES));
      this.db.prepare("INSERT INTO identity_link_codes(code_hash,identity_id,created_at,expires_at,consumed_at) VALUES(?,?,?,?,NULL)")
        .run(legacyHash(code), identityId, now, now + LINK_CODE_TTL_MS);
      return { identityId: identity.identityId, displayName: identity.displayName,
        linkCode: code, expiresAt: now + LINK_CODE_TTL_MS };
    });
  }

  // RC-2026-09-24-210: verify a presented link code and consume it
  // atomically (single-use). Called inside the enrolling transaction, so a
  // create that fails later never burns a code it didn't use.
  //
  // Every failure reads as 422 identity_link_proof_required — the checks
  // (exists, bound to the claimed identityId, unexpired, unused, identity
  // not revoked) share one code so there is no oracle for which of them
  // failed. The raw code is never logged or persisted by the caller.
  consumeLinkCode(identityId, code) {
    if (typeof code !== "string" || !LINK_CODE_RE.test(code)) {
      fail(422, "identity_link_proof_required",
        "Present an identity link code minted by the identity holder (POST /api/identities/{identityId}/link-code)");
    }
    const now = this.store.now();
    const row = this.db.prepare(
      "SELECT identity_id AS identityId, expires_at AS expiresAt, consumed_at AS consumedAt FROM identity_link_codes WHERE code_hash=?")
      .get(legacyHash(code));
    const proofFailed = () => fail(422, "identity_link_proof_required",
      "Present an identity link code minted by the identity holder (POST /api/identities/{identityId}/link-code)");
    if (!row || row.identityId !== identityId || row.expiresAt <= now || row.consumedAt !== null) proofFailed();
    // A code minted before a revocation dies with the identity: revocation
    // stops the secret authenticating everywhere, and its delegations with it.
    const live = this.db.prepare("SELECT 1 FROM agent_identities WHERE identity_id=? AND revoked_at IS NULL").get(identityId);
    if (!live) proofFailed();
    // Conditional consume: a concurrent consume that lands first wins —
    // single-use is enforced by the row, not by the check above.
    const changed = this.db.prepare("UPDATE identity_link_codes SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL")
      .run(now, legacyHash(code));
    if (changed.changes !== 1) proofFailed();
    return { identityId, consumedAt: now };
  }
  // Owner-only, like the sibling audit lists (agent-invites, agent-connections,
  // share-links): which identities are plugged into a room is membership
  // administration data, not something every member should enumerate.
  list(token, roomId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    const authority = this.store.roomAuthority(roomId);
    if (!memberCan(authority, auth.member.id, "manage_members")) fail(403, "access_denied", "Membership administration grant required");
    return this.db.prepare(`SELECT l.identity_id AS identityId, l.member_id AS memberId, l.linked_at AS linkedAt,
        i.display_name AS identityDisplayName FROM identity_links l
        JOIN agent_identities i ON i.identity_id=l.identity_id WHERE l.room_id=? ORDER BY l.linked_at`).all(roomId);
  }

  // Resolves an identity secret globally, without a room: used by the
  // self-serve agent-room creation path, where no room link exists yet.
  // Returns { identityId, displayName } or null. Malformed secrets are
  // null, never an error, so callers cannot distinguish "bad format" from
  // "unknown secret".
  resolveGlobalIdentitySecret(secret) {
    if (!isIdentitySecret(secret)) return null;
    const row = this.rowForSecret(secret);
    if (!row) return null;
    this.noteActivated(row.identityId);
    return { identityId: row.identityId, displayName: row.displayName };
  }

  // Resolves an identity secret to the linked room member, or null. Called
  // from RoomStore#authenticate before the room-key path. Revoked secrets
  // never resolve — every call re-reads the current verifier, so rotation
  // and revocation apply on the next request. The scrypt result for an old
  // row may be cached in memory; the authorization decision is not.
  resolveIdentityAuth(secret, roomId) {
    if (!roomId) return null;
    const row = this.rowForSecret(secret);
    if (!row) return null;
    this.noteActivated(row.identityId);
    return this.resolveIdentityLink(row.identityId, roomId);
  }

  // Resolves a known identityId to its linked room member, or null. Used by
  // the API-key auth branch (RC-2026-09-18-012): a verified rak_ key yields
  // an identityId, not a secret, so the link lookup runs by identityId.
  resolveIdentityLink(identityId, roomId) {
    if (!roomId || typeof identityId !== "string" || !identityId) return null;
    const link = this.db.prepare("SELECT member_id FROM identity_links WHERE room_id=? AND identity_id=?").get(roomId, identityId);
    if (!link) return null;
    const member = memberOf(this.store.roomAuthority(roomId).members, link.member_id);
    if (!member || member.active === false) return null;
    this.noteActivated(identityId);
    return { identityId, member };
  }

  // The room-key heartbeat door looks up the identity from the authenticated
  // member. Member id and identity id are not always the same.
  identityIdForMember(roomId, memberId) {
    if (!roomId || typeof memberId !== "string" || !memberId) return null;
    const rows = this.db.prepare(`SELECT l.identity_id AS identityId, i.revoked_at AS revokedAt
      FROM identity_links l JOIN agent_identities i ON i.identity_id=l.identity_id
      WHERE l.room_id=? AND l.member_id=?`).all(roomId, memberId);
    return rows.length === 1 && rows[0].revokedAt === null ? rows[0].identityId : null;
  }

  // Lists all rooms where an identity is linked as an active member.
  // Used by the agent browser sign-in flow: after verifying the identity
  // secret, the agent picks which room to open. Returns [{ roomId, title,
  // memberId }] for active links only.
  roomsForIdentity(identityId) {
    if (typeof identityId !== "string" || !identityId) return [];
    const rows = this.db.prepare(`
      SELECT l.room_id AS roomId, l.member_id AS memberId
      FROM identity_links l
      WHERE l.identity_id = ?
      ORDER BY l.linked_at DESC
    `).all(identityId);
    // Filter to active members only, and get room titles from projection
    return rows.filter(row => {
      try {
        const member = memberOf(this.store.roomAuthority(row.roomId).members, row.memberId);
        if (!member || member.active === false) return false;
        // Get title from room projection
        const roomRow = this.db.prepare("SELECT projection FROM rooms WHERE id=?").get(row.roomId);
        if (roomRow) {
          const proj = JSON.parse(roomRow.projection);
          row.title = proj?.room?.title || row.roomId;
        } else {
          row.title = row.roomId;
        }
        return true;
      } catch {
        return false;
      }
    });
  }
}

