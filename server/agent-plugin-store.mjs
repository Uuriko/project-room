// Lane D agent plug-in sub-store: persistence + ownership wiring for the
// four pure plug-in modules.
//
// server/agent-api-keys.mjs, server/agent-directory.mjs,
// server/agent-plugin-manifest.mjs and server/agent-webhook-subscriptions.mjs
// are pure logic (caller-owned Maps, no I/O). This sub-store bridges them to
// SQLite: the Maps are hydrated from the tables on open, and every mutation
// is written through inside the same store transaction. API-key secrets are
// never persisted — only their SHA-256 hashes (the pure module never returns
// a stored secret). Webhook signing secrets ARE persisted because the server
// needs them to sign deliveries, but they are never returned over HTTP
// (only shown once when the server generates one at subscribe time).
//
// Ownership: API keys, directory cards and webhook subscriptions are scoped
// to the publishing agent identity. Cross-identity access reads as 404
// (never an oracle); a publish colliding with another identity's card is
// 409. Nothing here touches the network.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createAgentApiKeys, ApiKeyError, API_KEY_PREFIX } from "./agent-api-keys.mjs";
import { createAgentDirectory, DirectoryError } from "./agent-directory.mjs";
import { createIdentityVerification, VERIFIED, UNVERIFIED } from "./identity-verification.mjs";
import { buildPluginManifest, ManifestError } from "./agent-plugin-manifest.mjs";
import {
  createAgentWebhookSubscriptions, WebhookSubscriptionError, signPayload, verifySignature,
} from "./agent-webhook-subscriptions.mjs";
import { buildWakePing, WAKE_PING_EVENT } from "./outbound-webhooks.mjs"; // RC-2026-09-18-051: wake-ping payloads.

export { ApiKeyError, DirectoryError, ManifestError, WebhookSubscriptionError, signPayload, verifySignature, API_KEY_PREFIX };

// Purely additive, intentionally outside the writer fence (see
// unfencedAdditiveTables in server/writer-fence.mjs): older writers have no
// code path to these tables, and every row is scoped to an agent identity.
export const agentPluginSchema = `
  CREATE TABLE IF NOT EXISTS agent_api_keys (
    key_id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    identity_id TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
    last_used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS agent_api_key_identity ON agent_api_keys(identity_id);
  CREATE TABLE IF NOT EXISTS agent_directory_cards (
    agent_id TEXT PRIMARY KEY,
    card_json TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK(visibility IN ('public','room','private')),
    owner_identity_id TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(withdrawn IN (0,1)),
    -- RC-2026-09-18-014: the key envelope for signed cards (base64 Ed25519
    -- public key + base64 signature over the canonical card body). Legacy
    -- rows backfill NULL and pin a key on their next owner-signed republish.
    public_key TEXT,
    signature TEXT
  );
  CREATE TABLE IF NOT EXISTS agent_webhook_subs (
    subscription_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    url TEXT NOT NULL,
    events_json TEXT NOT NULL,
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    created_at INTEGER NOT NULL,
    journal_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS agent_webhook_sub_agent ON agent_webhook_subs(agent_id);
  -- RC-2026-09-18-049: agent verification tiers. A row attests that a room
  -- owner vouches for the identity (verifiedBy = attesting owner's member
  -- id); absence of a row means the identity is unverified. A second table
  -- holds the per-room gate policy.
  CREATE TABLE IF NOT EXISTS agent_identity_verification (
    identity_id TEXT PRIMARY KEY,
    verified_by TEXT NOT NULL,
    verified_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS room_verification_policy (
    room_id TEXT PRIMARY KEY,
    require_verified INTEGER NOT NULL DEFAULT 0 CHECK(require_verified IN (0,1)),
    set_by TEXT,
    updated_at INTEGER NOT NULL
  );
`;

export class AgentPluginError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AgentPluginError";
    this.status = status;
    this.code = code;
  }
}

export class AgentPluginStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.keys = new Map();
    this.cards = new Map();
    this.subs = new Map();
    this.verifications = new Map();
    this.verificationPolicies = new Map();
    const clock = () => store.now();
    this.apiKeys = createAgentApiKeys({ store: this.keys, clock });
    // RC-2026-09-18-049: verification tiers ride on the trust evidence —
    // a verified attestation becomes host-supplied trust for the card's
    // owner identity; unverified cards still surface an explicit
    // verification:"unverified" tier so readers can decide.
    this.identityVerification = createIdentityVerification({ store: this.verifications, clock });
    const verificationTrust = agentId => {
      // Card ownership lives in the DB (the directory Map is keyed by
      // agentId); the attestation is for the card's owner identity.
      const row = this.db.prepare(
        "SELECT owner_identity_id AS ownerIdentityId FROM agent_directory_cards WHERE agent_id=?").get(agentId);
      const attestation = row?.ownerIdentityId
        ? this.identityVerification.attestation(row.ownerIdentityId)
        : null;
      return {
        approvedBy: attestation?.verifiedBy ?? null,
        approvedAt: attestation?.verifiedAt ?? null,
        grants: [],
        status: "active",
        lastSeenAt: null,
        verification: attestation ? VERIFIED : UNVERIFIED,
      };
    };
    this.directory = createAgentDirectory({ store: this.cards, clock,
      trust: verificationTrust,
      presence: agentId => this.presenceForCard(agentId) });
    this.webhooks = createAgentWebhookSubscriptions({
      store: this.subs,
      clock,
      // Collision-free across restarts (the module's default counter is not
      // durable); the caller may still pass an explicit subscriptionId.
      id: () => {
        let subscriptionId;
        do { subscriptionId = `sub_${randomBytes(9).toString("base64url")}`; }
        while (this.subs.has(subscriptionId));
        return subscriptionId;
      },
    });
  }

  // Hydrate the pure modules' Maps from SQLite. Called once from the store
  // open path after the schema is exec'd.
  load() {
    // RC-2026-09-18-014: idempotent additive migration for the signed-card
    // key envelope. CREATE TABLE IF NOT EXISTS cannot add columns to an
    // existing table, so backfill them here (same pragma/ALTER pattern as
    // the credentials migration in server/store.mjs). Legacy rows keep NULL
    // and pin a key on their next owner-signed republish.
    const cardColumns = new Set(this.db.prepare("PRAGMA table_info(agent_directory_cards)").all().map(c => c.name));
    if (!cardColumns.has("public_key")) this.db.exec("ALTER TABLE agent_directory_cards ADD COLUMN public_key TEXT");
    if (!cardColumns.has("signature")) this.db.exec("ALTER TABLE agent_directory_cards ADD COLUMN signature TEXT");
    this.keys.clear();
    this.cards.clear();
    this.subs.clear();
    this.verifications.clear();
    this.verificationPolicies.clear();
    for (const row of this.db.prepare("SELECT * FROM agent_api_keys").all()) {
      this.keys.set(row.key_id, {
        keyId: row.key_id,
        keyHash: row.key_hash,
        identityId: row.identity_id,
        scopes: Object.freeze(JSON.parse(row.scopes_json)),
        label: row.label,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revoked: row.revoked === 1,
        lastUsedAt: row.last_used_at,
      });
    }
    for (const row of this.db.prepare("SELECT * FROM agent_directory_cards").all()) {
      this.cards.set(row.agent_id, {
        agentId: row.agent_id,
        card: JSON.parse(row.card_json),
        // Legacy rows (published before signed cards) have NULL here and
        // pin a key on their next owner-signed republish.
        publicKey: row.public_key ?? undefined,
        signature: row.signature ?? undefined,
        visibility: row.visibility,
        publishedAt: row.published_at,
        updatedAt: row.updated_at,
        withdrawn: row.withdrawn === 1,
      });
    }
    for (const row of this.db.prepare("SELECT * FROM agent_webhook_subs").all()) {
      this.subs.set(row.subscription_id, {
        subscriptionId: row.subscription_id,
        agentId: row.agent_id,
        url: row.url,
        events: Object.freeze(JSON.parse(row.events_json)),
        secret: row.secret,
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        deliveries: JSON.parse(row.journal_json),
      });
    }
    // RC-2026-09-18-049: verification attestations and per-room gate policy.
    for (const row of this.db.prepare("SELECT * FROM agent_identity_verification").all()) {
      this.verifications.set(row.identity_id, Object.freeze({
        identityId: row.identity_id,
        level: VERIFIED,
        verifiedBy: row.verified_by,
        verifiedAt: row.verified_at,
      }));
    }
    for (const row of this.db.prepare("SELECT * FROM room_verification_policy").all()) {
      this.verificationPolicies.set(row.room_id, Object.freeze({
        roomId: row.room_id,
        requireVerified: row.require_verified === 1,
        setBy: row.set_by ?? null,
        updatedAt: row.updated_at,
      }));
    }
  }

  // Read-only open path: verify the additive tables, allowing absence like
  // the other additive journals (read-only never migrates).
  verifySchema({ allowAbsent = false } = {}) {
    const tables = ["agent_api_keys", "agent_directory_cards", "agent_webhook_subs",
      "agent_identity_verification", "room_verification_policy"];
    const missing = tables.filter(name =>
      !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    if (missing.length && !allowAbsent) throw new Error(`agent-plugin tables missing: ${missing.join(", ")}`);
  }

  // ---- Scoped API keys (secret shown once at issue/rotate; hash-only storage) ----

  // Every mutation below runs the pure-module Map change and its SQLite
  // write-through inside one store transaction. SQLite rolls back on throw,
  // but the caller-owned Maps would not — so snapshot all three Maps first
  // and restore their entries if anything throws. The Map objects themselves
  // are never replaced (the pure modules close over them), only their
  // entries are restored.
  mutate(fn) {
    const snapshot = map => new Map([...map].map(([k, v]) => [k, structuredClone(v)]));
    const before = { keys: snapshot(this.keys), cards: snapshot(this.cards), subs: snapshot(this.subs),
      verifications: snapshot(this.verifications), verificationPolicies: snapshot(this.verificationPolicies) };
    try {
      return this.store.transaction(fn);
    } catch (err) {
      for (const name of ["keys", "cards", "subs", "verifications", "verificationPolicies"]) {
        const target = this[name], saved = before[name];
        target.clear();
        for (const [k, v] of saved) target.set(k, v);
      }
      throw err;
    }
  }

  issueApiKey({ identityId, scopes, expiresAt = null, label = null }) {
    return this.mutate(() => {
      const issued = this.apiKeys.issue({ identityId, scopes, expiresAt, label });
      const record = this.keys.get(issued.keyId);
      this.db.prepare(`INSERT INTO agent_api_keys
        (key_id, key_hash, identity_id, scopes_json, label, created_at, expires_at, revoked, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`)
        .run(record.keyId, record.keyHash, record.identityId, JSON.stringify([...record.scopes]),
          record.label, record.createdAt, record.expiresAt);
      return issued;
    });
  }

  listApiKeys(identityId) {
    return this.store.readTransaction(() => this.apiKeys.keysForIdentity(identityId));
  }

  keyRecordForOwner(keyId, identityId) {
    const record = this.keys.get(keyId);
    // Unknown-or-not-yours reads as 404 either way: no cross-identity oracle.
    if (!record || record.identityId !== identityId) {
      throw new AgentPluginError(404, "unknown_key", `Unknown API key "${keyId}"`);
    }
    return record;
  }

  rotateApiKey({ identityId, keyId }) {
    return this.mutate(() => {
      this.keyRecordForOwner(keyId, identityId);
      const rotated = this.apiKeys.rotate(keyId);
      const record = this.keys.get(keyId);
      this.db.prepare("UPDATE agent_api_keys SET key_hash=?, last_used_at=NULL WHERE key_id=?")
        .run(record.keyHash, keyId);
      return rotated;
    });
  }

  revokeApiKey({ identityId, keyId }) {
    return this.mutate(() => {
      this.keyRecordForOwner(keyId, identityId);
      const revoked = this.apiKeys.revoke(keyId);
      this.db.prepare("UPDATE agent_api_keys SET revoked=1 WHERE key_id=?").run(keyId);
      return revoked;
    });
  }

  // Server-side bulk revoke (RC-2026-09-19-055): when an identity's primary
  // secret is revoked, every scoped key it minted is revoked too — a
  // revoked identity must not keep operating through an earlier key. No
  // owner check here: the caller (AgentIdentities#revoke) already proved
  // ownership with the identity's own secret. Returns the count revoked.
  revokeApiKeysForIdentity(identityId) {
    return this.mutate(() => {
      let revoked = 0;
      for (const record of this.apiKeys.keysForIdentity(identityId)) {
        if (record.revoked) continue;
        this.apiKeys.revoke(record.keyId);
        this.db.prepare("UPDATE agent_api_keys SET revoked=1 WHERE key_id=?").run(record.keyId);
        revoked += 1;
      }
      return revoked;
    });
  }

  // Authenticate a presented API-key secret (for future scoped use); updates
  // lastUsedAt on success. Returns the public record or null.
  verifyApiKeySecret(secret) {
    return this.mutate(() => {
      const record = this.apiKeys.verify(secret);
      if (!record) return null;
      const stored = this.keys.get(record.keyId);
      this.db.prepare("UPDATE agent_api_keys SET last_used_at=? WHERE key_id=?")
        .run(stored.lastUsedAt, record.keyId);
      return record;
    });
  }

  // ---- Agent verification tiers (RC-2026-09-18-049) ----
  //
  // A room owner attests an agent identity as verified — vouching it is
  // genuine and under legitimate control. Everything unattested is
  // unverified. Attestation is global (one row per identity); rooms gate on
  // the tier through the per-room verification policy below.

  // True when the identity is linked as a member in at least one room where
  // that member is the room's owner: the attestation authority.
  isRoomOwner(identityId) {
    return this.store.readTransaction(() =>
      !!this.db.prepare(
        `SELECT 1 FROM identity_links il JOIN rooms r ON il.room_id = r.id
         WHERE il.identity_id = ?
           AND json_extract(r.projection, '$.room.ownerId') = il.member_id
         LIMIT 1`).get(identityId));
  }

  verifyIdentity({ identityId, verifiedBy }) {
    return this.mutate(() => {
      const record = this.identityVerification.verify(identityId, { verifiedBy });
      this.db.prepare(`INSERT INTO agent_identity_verification (identity_id, verified_by, verified_at)
        VALUES (?, ?, ?)
        ON CONFLICT(identity_id) DO UPDATE SET verified_by=excluded.verified_by, verified_at=excluded.verified_at`)
        .run(record.identityId, record.verifiedBy, record.verifiedAt);
      return record;
    });
  }

  unverifyIdentity({ identityId }) {
    return this.mutate(() => {
      const result = this.identityVerification.unverify(identityId);
      this.db.prepare("DELETE FROM agent_identity_verification WHERE identity_id=?").run(identityId);
      return result;
    });
  }

  verificationAttestation(identityId) {
    return this.store.readTransaction(() => this.identityVerification.attestation(identityId));
  }

  verificationLevel(identityId) {
    return this.store.readTransaction(() => this.identityVerification.level(identityId));
  }

  verificationAttestations() {
    return this.store.readTransaction(() => this.identityVerification.attestations());
  }

  // Per-room gate: when requireVerified is set, linking an unverified
  // identity into the room is denied (see AgentIdentities.link).
  setRoomVerificationPolicy({ roomId, requireVerified, setBy = null }) {
    if (typeof roomId !== "string" || !roomId) {
      throw new AgentPluginError(422, "invalid_room", "roomId is required");
    }
    if (typeof requireVerified !== "boolean") {
      throw new AgentPluginError(422, "invalid_policy", "requireVerified must be a boolean");
    }
    return this.mutate(() => {
      const at = this.store.now();
      const policy = Object.freeze({ roomId, requireVerified, setBy, updatedAt: at });
      this.verificationPolicies.set(roomId, policy);
      this.db.prepare(`INSERT INTO room_verification_policy (room_id, require_verified, set_by, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(room_id) DO UPDATE SET require_verified=excluded.require_verified,
          set_by=excluded.set_by, updated_at=excluded.updated_at`)
        .run(roomId, requireVerified ? 1 : 0, setBy, at);
      return policy;
    });
  }

  roomVerificationPolicy(roomId) {
    return this.store.readTransaction(() => {
      const policy = this.verificationPolicies.get(roomId);
      return policy ?? Object.freeze({ roomId, requireVerified: false, setBy: null, updatedAt: null });
    });
  }

  // ---- Agent directory (public document; owner-scoped publish/withdraw) ----

  publishCard({ identityId, agentId, card, publicKey, signature, rotationSignature = null,
    ownerRecovery = false, visibility = "public" }) {
    return this.mutate(() => {
      const existing = this.db.prepare("SELECT owner_identity_id AS ownerIdentityId FROM agent_directory_cards WHERE agent_id=?").get(agentId);
      if (existing && existing.ownerIdentityId !== identityId) {
        throw new AgentPluginError(409, "card_owned_by_another_identity",
          `Card "${agentId}" is published by another identity`);
      }
      this.directory.publish({
        agentId, card, visibility, publicKey, signature, rotationSignature,
        allowRecovery: ownerRecovery,
      });
      const entry = this.cards.get(agentId);
      this.db.prepare(`INSERT INTO agent_directory_cards
        (agent_id, card_json, visibility, owner_identity_id, published_at, updated_at, withdrawn, public_key, signature)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET card_json=excluded.card_json, visibility=excluded.visibility,
          updated_at=excluded.updated_at, withdrawn=0,
          public_key=excluded.public_key, signature=excluded.signature`)
        .run(agentId, JSON.stringify(entry.card), entry.visibility, identityId,
          entry.publishedAt, entry.updatedAt, entry.publicKey, entry.signature);
      // Rebuild the doc after the owner row exists so the trust source sees
      // the card's owner identity (RC-2026-09-18-049 verification tiers).
      return this.directory.get(agentId);
    });
  }

  withdrawCard({ identityId, agentId }) {
    return this.mutate(() => {
      const row = this.db.prepare("SELECT owner_identity_id AS ownerIdentityId FROM agent_directory_cards WHERE agent_id=?").get(agentId);
      if (!row || row.ownerIdentityId !== identityId) {
        throw new AgentPluginError(404, "unknown_card", `No card "${agentId}" for this identity`);
      }
      const result = this.directory.withdraw(agentId);
      // Persist the entry's own updatedAt from the pure withdraw above —
      // calling the clock again here could differ by milliseconds.
      const entry = this.cards.get(agentId);
      this.db.prepare("UPDATE agent_directory_cards SET withdrawn=1, updated_at=? WHERE agent_id=?")
        .run(entry.updatedAt, agentId);
      return result;
    });
  }

  // Authenticate a presented HTTP credential ("rak_"+raw secret). The pure
  // module keeps the raw-secret contract (tests pin it); the HTTP layer
  // presents the rak_-prefixed credential, so the prefix is stripped here.
  // Read-only: authenticate() runs inside read transactions, where the
  // lastUsedAt write of verifyApiKeySecret would throw — so this path does
  // the same constant-time hash comparison and revoked/expiry checks without
  // updating lastUsedAt. Returns the public record or null (unknown,
  // revoked, expired, or not a well-formed API-key credential).
  verifyPresentedApiKey(presented) {
    if (typeof presented !== "string" || !presented.startsWith(API_KEY_PREFIX)) return null;
    const secret = presented.slice(API_KEY_PREFIX.length);
    if (!secret) return null;
    return this.store.readTransaction(() => {
      const digest = createHash("sha256").update(secret).digest("hex");
      for (const record of this.keys.values()) {
        const stored = Buffer.from(record.keyHash, "hex");
        const candidate = Buffer.from(digest, "hex");
        if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
          if (record.revoked) return null;
          if (record.expiresAt !== null && this.store.now() >= record.expiresAt) return null;
          return Object.freeze({
            keyId: record.keyId,
            identityId: record.identityId,
            scopes: Object.freeze([...record.scopes]),
            label: record.label,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            revoked: record.revoked,
            lastUsedAt: record.lastUsedAt,
          });
        }
      }
      return null;
    });
  }

  // True when the agent identity is linked to at least one room: the
  // "room member" proof for the room-visibility directory read surface
  // (RC-2026-09-18-012). Cards carry no room linkage, so a room card is
  // visible only when the viewer and the card's owner share at least one
  // room (checked per card by the shared-room join below).
  identityIsRoomMember(identityId) {
    return this.store.readTransaction(() =>
      !!this.db.prepare("SELECT 1 FROM identity_links WHERE identity_id=? LIMIT 1").get(identityId));
  }

  // The frozen member directory document: public cards plus room-visibility
  // cards whose owner shares a room with the viewer. Private cards stay
  // invisible.
  memberDirectoryDocument({ viewerIdentityId, serviceOrigin, query = "", capability = null }) {
    return this.store.readTransaction(() => {
      if (typeof serviceOrigin !== "string" || !/^https:\/\/\S+$/.test(serviceOrigin)) {
        throw new AgentPluginError(422, "invalid_origin", "serviceOrigin must be an https URL");
      }
      const roomOwners = new Map(this.db.prepare(
        "SELECT agent_id AS agentId, owner_identity_id AS ownerIdentityId FROM agent_directory_cards WHERE visibility='room' AND withdrawn=0"
      ).all().map(row => [row.agentId, row.ownerIdentityId]));
      const sharesRoom = new Map();
      const visibleRoomCard = agent => {
        if (!roomOwners.has(agent.agentId)) return false;
        let shared = sharesRoom.get(agent.agentId);
        if (shared === undefined) {
          shared = !!this.db.prepare(
            `SELECT 1 FROM identity_links a JOIN identity_links b ON a.room_id = b.room_id
             WHERE a.identity_id=? AND b.identity_id=? LIMIT 1`
          ).get(viewerIdentityId, roomOwners.get(agent.agentId));
          sharesRoom.set(agent.agentId, shared);
        }
        return shared;
      };
      const agents = this.directory.list({ query, capability, includeNonPublic: true })
        .filter(agent => agent.visibility === "public"
          || (agent.visibility === "room" && visibleRoomCard(agent)))
        .map(agent => ({
          ...agent,
          cardUrl: `${serviceOrigin}/api/agents/directory/${agent.agentId}`,
        }));
      return Object.freeze({
        version: "1.0.0",
        origin: serviceOrigin,
        generatedAt: this.store.now(),
        agents: Object.freeze(agents),
      });
    });
  }

  // A single member-visible card (public, or room-visibility when the viewer
  // shares a room with the card's owner). Private, withdrawn, or
  // room-invisible cards read as 404, exactly like unknown cards: no oracle.
  memberCard(agentId, viewerIdentityId) {
    return this.store.readTransaction(() => {
      const entry = this.cards.get(agentId);
      if (!entry || entry.withdrawn || entry.visibility === "private") {
        throw new AgentPluginError(404, "unknown_card", `No member-visible card "${agentId}"`);
      }
      if (entry.visibility === "room") {
        const owner = this.db.prepare("SELECT owner_identity_id AS ownerIdentityId FROM agent_directory_cards WHERE agent_id=?")
          .get(agentId);
        const shared = owner && !!this.db.prepare(
          `SELECT 1 FROM identity_links a JOIN identity_links b ON a.room_id = b.room_id
           WHERE a.identity_id=? AND b.identity_id=? LIMIT 1`
        ).get(viewerIdentityId, owner.ownerIdentityId);
        if (!shared) throw new AgentPluginError(404, "unknown_card", `No member-visible card "${agentId}"`);
      }
      return this.directory.get(agentId);
    });
  }

  // The frozen public directory document (public, non-withdrawn cards only).
  publicDirectoryDocument({ serviceOrigin, query = "", capability = null }) {
    return this.store.readTransaction(() => {
      if (!query && capability === null) return this.directory.buildDocument({ serviceOrigin });
      const agents = this.directory.list({ query, capability }).map(agent => ({
        ...agent,
        cardUrl: `${serviceOrigin}/api/agents/directory/${agent.agentId}`,
      }));
      return Object.freeze({
        version: "1.0.0",
        origin: serviceOrigin,
        generatedAt: this.store.now(),
        agents: Object.freeze(agents),
      });
    });
  }

  // A single public card (the cardUrl target in the directory document).
  // Non-public or withdrawn cards read as 404.
  publicCard(agentId) {
    return this.store.readTransaction(() => {
      const entry = this.cards.get(agentId);
      if (!entry || entry.withdrawn || entry.visibility !== "public") {
        throw new AgentPluginError(404, "unknown_card", `No public card "${agentId}"`);
      }
      return this.directory.get(agentId);
    });
  }

  // RC-2026-09-18-051: host-supplied presence for a directory card. The card
  // is keyed by public agentId; heartbeats are keyed by the owning identity,
  // so resolve through the card's owner_identity_id. Returns null when the
  // heartbeat tables are absent (read-only on an older database) or the
  // agent never registered a host.
  presenceForCard(agentId) {
    const heartbeats = this.store.agentHeartbeats;
    if (!heartbeats) return null;
    const row = this.db.prepare("SELECT owner_identity_id AS ownerIdentityId FROM agent_directory_cards WHERE agent_id=?").get(agentId);
    if (!row) return null;
    const status = heartbeats.statusOf(row.ownerIdentityId);
    return { status: status.status, lastSeenAt: status.lastSeenAt, hosts: status.hosts.length };
  }

  // RC-2026-09-18-051: journal an agent.wake delivery for every enabled
  // subscription of the identity that listens for wake pings. Delivery is
  // pending (actual HTTP dispatch is a later slice); the agent sees the
  // pending entry in its delivery journal. No subscription, no delivery —
  // the heartbeat queue alone carries the wake.
  deliverWakePing({ identityId, signal }) {
    return this.mutate(() => {
      const rows = this.db.prepare(
        "SELECT subscription_id AS subscriptionId, events_json AS eventsJson FROM agent_webhook_subs WHERE agent_id=? AND enabled=1").all(identityId);
      const deliveries = [];
      for (const row of rows) {
        let events = [];
        try { events = JSON.parse(row.eventsJson); } catch { continue; }
        if (!events.includes(WAKE_PING_EVENT) && !events.includes("*")) continue;
        deliveries.push(this.buildWebhookDelivery(row.subscriptionId,
          { eventType: WAKE_PING_EVENT, data: buildWakePing({ agentId: identityId, signal }) }));
      }
      return Object.freeze({ deliveries: Object.freeze(deliveries) });
    });
  }

  // ---- Per-agent webhook subscriptions ----

  subscribeWebhook({ identityId, url, events, secret = null }) {
    return this.mutate(() => {
      // Caller-supplied secrets are never echoed; a server-generated secret
      // is shown exactly once so the agent can verify deliveries.
      const signingSecret = secret ?? randomBytes(32).toString("base64url");
      const view = this.webhooks.subscribe({ agentId: identityId, url, events, secret: signingSecret });
      const sub = this.subs.get(view.subscriptionId);
      this.db.prepare(`INSERT INTO agent_webhook_subs
        (subscription_id, agent_id, url, events_json, secret, enabled, created_at, journal_json)
        VALUES (?, ?, ?, ?, ?, 1, ?, '[]')`)
        .run(sub.subscriptionId, sub.agentId, sub.url, JSON.stringify([...sub.events]), sub.secret, sub.createdAt);
      return { subscription: view, secretShownOnce: secret === null ? signingSecret : null };
    });
  }

  listWebhooks(identityId) {
    return this.store.readTransaction(() => this.webhooks.forAgent(identityId));
  }

  unsubscribeWebhook({ identityId, subscriptionId }) {
    return this.mutate(() => {
      const row = this.db.prepare("SELECT agent_id FROM agent_webhook_subs WHERE subscription_id=?").get(subscriptionId);
      if (!row || row.agent_id !== identityId) {
        throw new AgentPluginError(404, "unknown_subscription", `Unknown subscription "${subscriptionId}"`);
      }
      const result = this.webhooks.unsubscribe(subscriptionId, { agentId: identityId });
      this.db.prepare("DELETE FROM agent_webhook_subs WHERE subscription_id=?").run(subscriptionId);
      return result;
    });
  }

  // ---- Delivery journal (server-side dispatch calls these; no HTTP routes yet) ----

  buildWebhookDelivery(subscriptionId, { eventType, data }) {
    return this.mutate(() => {
      const delivery = this.webhooks.buildDelivery(subscriptionId, { eventType, data });
      this.persistJournal(subscriptionId);
      return delivery;
    });
  }

  recordWebhookAttempt(deliveryId, { ok, error = null }) {
    return this.mutate(() => {
      const result = this.webhooks.recordAttempt(deliveryId, { ok, error });
      for (const sub of this.subs.values()) {
        if (sub.deliveries.some(d => d.deliveryId === deliveryId)) { this.persistJournal(sub.subscriptionId); break; }
      }
      return result;
    });
  }

  webhookJournal(subscriptionId) {
    return this.store.readTransaction(() => this.webhooks.journal(subscriptionId));
  }

  // RC-2026-09-18-038: identity-scoped journal read. Cross-identity reads
  // 404 like unsubscribe — an agent never learns another's deliveries.
  webhookJournalFor({ identityId, subscriptionId }) {
    return this.store.readTransaction(() => {
      const row = this.db.prepare("SELECT agent_id FROM agent_webhook_subs WHERE subscription_id=?").get(subscriptionId);
      if (!row || row.agent_id !== identityId) {
        throw new AgentPluginError(404, "unknown_subscription", `Unknown subscription "${subscriptionId}"`);
      }
      return this.webhooks.journal(subscriptionId);
    });
  }

  persistJournal(subscriptionId) {
    const sub = this.subs.get(subscriptionId);
    if (!sub) return;
    this.db.prepare("UPDATE agent_webhook_subs SET journal_json=? WHERE subscription_id=?")
      .run(JSON.stringify(sub.deliveries), subscriptionId);
  }

  // ---- Plug-in manifest (derived, unauthenticated) ----

  pluginManifest(serviceOrigin) {
    return buildPluginManifest({ serviceOrigin, roomId: null });
  }
}
