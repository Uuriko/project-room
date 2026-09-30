// Matchmaking P1 — seeker profiles (matchmaking-plan-2026-09-30.md §5/§16).
//
// The worker side of the room's two-sided market. A seeker profile records
// what kind of work an agent or human wants (intents: paid | credits | fun),
// what they claim they can do (capabilities — stored and shown, scored zero
// by the engine in P3), when they're reachable (availability), where they'll
// work (surfaces), and whether posters may discover them (discoverable).
//
// Storage contract: this module never creates its own table. The
// match_profiles table is provisioned by the wiring layer; createMatchProfiles
// fails closed with schema-not-provisioned when it is absent — so the table
// stays out of the store's auditRecovery table inventory until it is
// registered in server/writer-fence.mjs unfencedAdditiveTables and the schema
// is exec'd at store open. The db handle, clock, and id generator are all
// injected — the module does no I/O of its own.
//
// No synthetic reputation is ever stored here: rank is computed at read time
// from receipts (P3), every time, so every factor cites live evidence. The
// reward_floor is visible to the profile owner only; public candidate views
// redact it (mutual-opt-in visibility, plan §13).

// Local error (mirrors server/store.mjs). We avoid importing from store.mjs
// here to break the circular dependency for the Workers bundle: store.mjs
// may import this module in the wiring slice, so this module cannot import
// from store.mjs at the top level.
class MatchProfileError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "MatchProfileError";
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new MatchProfileError(status, code, message); };
const check = (condition, status, code, message) => { if (!condition) fail(status, code, message); };

export const MATCH_PROFILES_TABLE = "match_profiles";

export const matchProfilesSchema = `
  CREATE TABLE IF NOT EXISTS match_profiles (
    room_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('agent','human')),
    display_name TEXT NOT NULL,
    intents_json TEXT NOT NULL,
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    availability TEXT NOT NULL DEFAULT 'open' CHECK(availability IN ('open','busy','paused')),
    surfaces_json TEXT NOT NULL DEFAULT '["room"]',
    discoverable TEXT NOT NULL DEFAULT 'public' CHECK(discoverable IN ('public','private')),
    reward_floor_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, identity_id)
  );
  CREATE INDEX IF NOT EXISTS match_profiles_discoverable
    ON match_profiles(room_id, discoverable, availability);
`;

export const PROFILE_INTENTS = Object.freeze(["paid", "credits", "fun"]);
export const PROFILE_KINDS = Object.freeze(["agent", "human"]);
export const PROFILE_AVAILABILITY = Object.freeze(["open", "busy", "paused"]);
export const PROFILE_SURFACES = Object.freeze(["room", "repo", "venue"]);
export const PROFILE_DISCOVERABLE = Object.freeze(["public", "private"]);
const MAX_CAPABILITIES = 50;
const MAX_TAG_LENGTH = 64;
const MAX_DISPLAY_NAME = 120;

const isStringArray = value => Array.isArray(value) && value.every(v => typeof v === "string");

const parseJsonArray = (raw, field) => {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw);
    check(Array.isArray(parsed), 500, "corrupt_profile", `${field} is not a JSON array`);
    return parsed;
  } catch (error) {
    if (error instanceof MatchProfileError) throw error;
    fail(500, "corrupt_profile", `${field} is not valid JSON`);
  }
};

// The public view: reward_floor is redacted until mutual opt-in (plan §13) —
// posters see evidence lines, never the seeker's minimum.
const profileView = (row, { redactRewardFloor = false } = {}) => row ? Object.freeze({
  roomId: row.room_id,
  identityId: row.identity_id,
  kind: row.kind,
  displayName: row.display_name,
  intents: Object.freeze(parseJsonArray(row.intents_json, "intents_json")),
  capabilities: Object.freeze(parseJsonArray(row.capabilities_json, "capabilities_json")),
  availability: row.availability,
  surfaces: Object.freeze(parseJsonArray(row.surfaces_json, "surfaces_json")),
  discoverable: row.discoverable,
  rewardFloor: redactRewardFloor ? null : (row.reward_floor_json ? JSON.parse(row.reward_floor_json) : null),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
}) : null;

function validateProfileInput(input) {
  const { kind, displayName, intents, capabilities = [], availability = "open",
    surfaces = ["room"], discoverable = "public", rewardFloor = null } = input ?? {};
  check(PROFILE_KINDS.includes(kind), 422, "invalid_kind",
    `kind must be one of ${PROFILE_KINDS.join(", ")}`);
  check(typeof displayName === "string" && displayName.length >= 1 && displayName.length <= MAX_DISPLAY_NAME,
    422, "invalid_display_name", `displayName must be 1..${MAX_DISPLAY_NAME} characters`);
  check(isStringArray(intents) && intents.length >= 1 && intents.every(i => PROFILE_INTENTS.includes(i)),
    422, "invalid_intents", `intents must be a non-empty array of ${PROFILE_INTENTS.join(", ")}`);
  check(new Set(intents).size === intents.length, 422, "invalid_intents", "intents must not repeat");
  check(isStringArray(capabilities) && capabilities.length <= MAX_CAPABILITIES
    && capabilities.every(t => t.length >= 1 && t.length <= MAX_TAG_LENGTH),
    422, "invalid_capabilities", `capabilities must be ≤${MAX_CAPABILITIES} tags of 1..${MAX_TAG_LENGTH} chars`);
  check(new Set(capabilities).size === capabilities.length, 422, "invalid_capabilities", "capabilities must not repeat");
  check(PROFILE_AVAILABILITY.includes(availability), 422, "invalid_availability",
    `availability must be one of ${PROFILE_AVAILABILITY.join(", ")}`);
  check(isStringArray(surfaces) && surfaces.length >= 1 && surfaces.every(s => PROFILE_SURFACES.includes(s)),
    422, "invalid_surfaces", `surfaces must be a non-empty array of ${PROFILE_SURFACES.join(", ")}`);
  check(new Set(surfaces).size === surfaces.length, 422, "invalid_surfaces", "surfaces must not repeat");
  check(PROFILE_DISCOVERABLE.includes(discoverable), 422, "invalid_discoverable",
    `discoverable must be one of ${PROFILE_DISCOVERABLE.join(", ")}`);
  if (rewardFloor !== null && rewardFloor !== undefined) {
    check(typeof rewardFloor === "object" && !Array.isArray(rewardFloor), 422, "invalid_reward_floor",
      "rewardFloor must be an object {amount, denomination} or null");
    check(typeof rewardFloor.amount === "number" && Number.isFinite(rewardFloor.amount) && rewardFloor.amount > 0,
      422, "invalid_reward_floor", "rewardFloor.amount must be a positive number");
    check(typeof rewardFloor.denomination === "string" && rewardFloor.denomination.length >= 1
      && rewardFloor.denomination.length <= 16,
      422, "invalid_reward_floor", "rewardFloor.denomination must be 1..16 characters");
  }
  return {
    kind, displayName, intents: [...intents], capabilities: [...capabilities],
    availability, surfaces: [...surfaces], discoverable,
    rewardFloor: rewardFloor ?? null,
  };
}

export function createMatchProfiles({ db, clock, id } = {}) {
  check(db && typeof db.prepare === "function",
    500, "misconfigured", "db (node:sqlite DatabaseSync) is required");
  const provisioned = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(MATCH_PROFILES_TABLE);
  if (!provisioned) {
    fail(500, "schema-not-provisioned",
      `${MATCH_PROFILES_TABLE} is not provisioned on this database — the wiring layer must exec matchProfilesSchema at store open (see server/writer-fence.mjs).`);
  }
  const now = clock ?? Date.now;
  void id;

  const rowByKey = (roomId, identityId) =>
    db.prepare("SELECT * FROM match_profiles WHERE room_id = ? AND identity_id = ?").get(roomId, identityId);

  // Upsert keyed on (room_id, identity_id): entering matchmaking twice never
  // creates a second profile. Returns { profile, created }.
  const upsert = ({ roomId, identityId, ...input }) => {
    check(typeof roomId === "string" && roomId.length > 0,
      422, "invalid_room", "roomId must be a non-empty string");
    check(typeof identityId === "string" && identityId.length >= 1 && identityId.length <= 256,
      422, "invalid_identity", "identityId must be 1..256 characters");
    const v = validateProfileInput(input);
    const existing = rowByKey(roomId, identityId);
    const at = now();
    if (existing) {
      db.prepare(`UPDATE match_profiles SET kind = ?, display_name = ?, intents_json = ?,
        capabilities_json = ?, availability = ?, surfaces_json = ?, discoverable = ?,
        reward_floor_json = ?, updated_at = ? WHERE room_id = ? AND identity_id = ?`)
        .run(v.kind, v.displayName, JSON.stringify(v.intents), JSON.stringify(v.capabilities),
          v.availability, JSON.stringify(v.surfaces), v.discoverable,
          v.rewardFloor ? JSON.stringify(v.rewardFloor) : null, at, roomId, identityId);
      return { profile: profileView(rowByKey(roomId, identityId)), created: false };
    }
    db.prepare(`INSERT INTO match_profiles (room_id, identity_id, kind, display_name,
      intents_json, capabilities_json, availability, surfaces_json, discoverable,
      reward_floor_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(roomId, identityId, v.kind, v.displayName, JSON.stringify(v.intents),
        JSON.stringify(v.capabilities), v.availability, JSON.stringify(v.surfaces),
        v.discoverable, v.rewardFloor ? JSON.stringify(v.rewardFloor) : null, at, at);
    return { profile: profileView(rowByKey(roomId, identityId)), created: true };
  };

  // Partial update: only the supplied fields change. Used by PATCH /profile.
  const update = ({ roomId, identityId, ...patch }) => {
    check(typeof roomId === "string" && roomId.length > 0,
      422, "invalid_room", "roomId must be a non-empty string");
    check(typeof identityId === "string" && identityId.length >= 1 && identityId.length <= 256,
      422, "invalid_identity", "identityId must be 1..256 characters");
    const existing = rowByKey(roomId, identityId);
    if (!existing) return null;
    const current = profileView(existing);
    const merged = validateProfileInput({
      kind: current.kind,
      displayName: current.displayName,
      intents: patch.intents ?? current.intents,
      capabilities: patch.capabilities ?? current.capabilities,
      availability: patch.availability ?? current.availability,
      surfaces: patch.surfaces ?? current.surfaces,
      discoverable: patch.discoverable ?? current.discoverable,
      rewardFloor: patch.rewardFloor === undefined ? current.rewardFloor : patch.rewardFloor,
    });
    db.prepare(`UPDATE match_profiles SET intents_json = ?, capabilities_json = ?,
      availability = ?, surfaces_json = ?, discoverable = ?,
      reward_floor_json = ?, updated_at = ? WHERE room_id = ? AND identity_id = ?`)
      .run(JSON.stringify(merged.intents), JSON.stringify(merged.capabilities),
        merged.availability, JSON.stringify(merged.surfaces), merged.discoverable,
        merged.rewardFloor ? JSON.stringify(merged.rewardFloor) : null, now(), roomId, identityId);
    return profileView(rowByKey(roomId, identityId));
  };

  const get = ({ roomId, identityId }) => {
    check(typeof roomId === "string" && roomId.length > 0,
      422, "invalid_room", "roomId must be a non-empty string");
    check(typeof identityId === "string" && identityId.length >= 1 && identityId.length <= 256,
      422, "invalid_identity", "identityId must be 1..256 characters");
    return profileView(rowByKey(roomId, identityId));
  };

  // Poster-side candidate search: public + not paused. The reward floor is
  // redacted — mutual-opt-in visibility only (plan §13).
  const listPublic = ({ roomId }) => {
    check(typeof roomId === "string" && roomId.length > 0,
      422, "invalid_room", "roomId must be a non-empty string");
    const rows = db.prepare(
      `SELECT * FROM match_profiles WHERE room_id = ? AND discoverable = 'public'
       AND availability != 'paused' ORDER BY updated_at DESC`).all(roomId);
    return Object.freeze(rows.map(row => profileView(row, { redactRewardFloor: true })));
  };

  return Object.freeze({ upsert, update, get, listPublic });
}

export { MatchProfileError };
