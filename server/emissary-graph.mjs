// Emissary slice 1a — external identity graph (graph.external).
//
// Strangers stay outside the room: this table records who an external
// agent or human claims to be, what venues vouch for that claim, and how
// far up the status ladder they have climbed. It grants nothing — there is
// no capability, membership, or money attached to any row here. Later
// slices build the offer/jury/vouch flow on top; this slice is the
// tracking substrate only.
//
// Identity model:
//   external_id  "ex1." + 32 lowercase hex, minted server-side, never reused.
//   kind         "agent" | "human".
//   venues       [{ venue, handle, proof, verified_at }] — a venue proof is
//                one of:
//                  self_asserted — the registrant's own claim; never
//                    promotes past "stranger", never collides with others.
//                  signed_card   — an Ed25519-signed agent card whose
//                    signature verifies against the room's agent-card
//                    verifier AND whose card name binds the claimed
//                    handle. Promotes stranger -> known.
//                  venue_api     — opaque evidence for a future
//                    server-side check; stored, never promotes (slice 1a).
//   status       stranger -> known -> working -> vouched -> member.
//                Monotonic: setStatus only moves one rung up. Slice 1a
//                performs stranger -> known via verifyVenue; the higher
//                rungs are enforced here for later slices to call.
//   referrer_external_id — optional; must already exist in the same room.
//
// Fail-closed rules: unknown rooms, malformed ids, bad proofs, and
// venue-handle collisions on verified venues all fail with a ServiceError
// and write nothing. A verified (non-self-asserted) venue handle may only
// belong to one external identity per room — re-registering it returns
// 409 with the existing external_id so the caller can merge instead.
//
// Local ServiceError (mirrors server/store.mjs); we avoid importing from
// the store to keep this module dependency-light for tests.
import { randomBytes } from "node:crypto";
import { verifyCardSignature } from "./agent-card-signing.mjs";

class ServiceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const fail = (status, code, message, details) => { throw new ServiceError(status, code, message, details); };

export const EXTERNAL_ID_RE = /^ex1\.[0-9a-f]{32}$/;
const KINDS = new Set(["agent", "human"]);
const PROOFS = new Set(["self_asserted", "signed_card", "venue_api"]);
const STATUSES = ["stranger", "known", "working", "vouched", "member"];
const STATUS_RANK = { stranger: 0, known: 1, working: 2, vouched: 3, member: 4 };
const MAX_VENUES = 8;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const mintExternalId = () => `ex1.${randomBytes(16).toString("hex")}`;

export const emissaryGraphSchema = `
  CREATE TABLE IF NOT EXISTS external_identities (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    external_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('agent','human')),
    display_name TEXT NOT NULL,
    venues_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'stranger' CHECK(status IN ('stranger','known','working','vouched','member')),
    referrer_external_id TEXT,
    reputation INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, external_id)
  );
  CREATE INDEX IF NOT EXISTS external_identities_by_status ON external_identities(room_id, status);
  CREATE INDEX IF NOT EXISTS external_identities_by_referrer ON external_identities(room_id, referrer_external_id);
`;

const checkRoom = (db, roomId) => {
  if (typeof roomId !== "string" || !roomId) fail(422, "invalid_emissary_input", "roomId is required");
  const room = db.prepare("SELECT id FROM rooms WHERE id=?").get(roomId);
  if (!room) fail(404, "unknown_room", "Room not found");
};

const checkDisplayName = (displayName) => {
  const name = typeof displayName === "string" ? displayName.trim() : "";
  if (!name || name.length > 80) fail(422, "invalid_emissary_input", "displayName must be 1-80 characters");
  if (CONTROL_CHARS.test(name)) fail(422, "invalid_emissary_input", "displayName must not contain control characters");
  return name;
};

const checkVenues = (venues) => {
  if (!Array.isArray(venues)) fail(422, "invalid_emissary_input", "venues must be an array");
  if (venues.length > MAX_VENUES) fail(422, "invalid_emissary_input", `at most ${MAX_VENUES} venues`);
  const seen = new Set();
  return venues.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      fail(422, "invalid_emissary_input", `venues[${index}] must be an object`);
    const venue = typeof entry.venue === "string" ? entry.venue.trim() : "";
    const handle = typeof entry.handle === "string" ? entry.handle.trim() : "";
    if (!venue || venue.length > 64 || CONTROL_CHARS.test(venue))
      fail(422, "invalid_emissary_input", `venues[${index}].venue must be 1-64 characters`);
    if (!handle || handle.length > 128 || CONTROL_CHARS.test(handle))
      fail(422, "invalid_emissary_input", `venues[${index}].handle must be 1-128 characters`);
    const proof = entry.proof === undefined ? "self_asserted" : entry.proof;
    if (!PROOFS.has(proof)) fail(422, "invalid_emissary_input", `venues[${index}].proof must be self_asserted|signed_card|venue_api`);
    const key = `${venue}\n${handle}`;
    if (seen.has(key)) fail(422, "invalid_emissary_input", `venues[${index}] duplicates an earlier venue handle`);
    seen.add(key);
    return { venue, handle, proof, verified_at: null };
  });
};

// A verified (non-self-asserted) venue handle belongs to exactly one
// external identity per room. Returns the colliding external_id, or null.
const findVerifiedCollision = (db, roomId, venues, excludeExternalId = null) => {
  const verified = venues.filter(v => v.proof !== "self_asserted");
  if (!verified.length) return null;
  const rows = db.prepare(
    "SELECT external_id, venues_json FROM external_identities WHERE room_id=?"
  ).all(roomId);
  for (const row of rows) {
    if (excludeExternalId && row.external_id === excludeExternalId) continue;
    let existing;
    try { existing = JSON.parse(row.venues_json); } catch { continue; }
    for (const have of existing) {
      if (have.proof === "self_asserted") continue;
      if (verified.some(v => v.venue === have.venue && v.handle === have.handle))
        return row.external_id;
    }
  }
  return null;
};

const publicRecord = (row) => ({
  room_id: row.room_id,
  external_id: row.external_id,
  kind: row.kind,
  display_name: row.display_name,
  venues: JSON.parse(row.venues_json),
  status: row.status,
  referrer_external_id: row.referrer_external_id,
  reputation: row.reputation,
  created_at: row.created_at,
  last_seen_at: row.last_seen_at,
});

export class EmissaryGraph {
  constructor(store) { this.store = store; this.db = store.db; }

  register(roomId, { kind, displayName, venues = [], referrerExternalId = null } = {}) {
    checkRoom(this.db, roomId);
    if (!KINDS.has(kind)) fail(422, "invalid_emissary_input", "kind must be agent|human");
    const name = checkDisplayName(displayName);
    const venueList = checkVenues(venues);
    let referrer = null;
    if (referrerExternalId !== null && referrerExternalId !== undefined) {
      if (!EXTERNAL_ID_RE.test(referrerExternalId))
        fail(422, "invalid_emissary_input", "referrerExternalId must be an ex1.* id");
      referrer = this.db.prepare(
        "SELECT external_id FROM external_identities WHERE room_id=? AND external_id=?"
      ).get(roomId, referrerExternalId);
      if (!referrer) fail(404, "unknown_referrer", "Referrer external identity not found in this room");
    }
    const collision = findVerifiedCollision(this.db, roomId, venueList);
    if (collision)
      fail(409, "venue_handle_taken",
        "A verified venue handle in this registration already belongs to another external identity",
        { external_id: collision });
    const now = Date.now();
    const externalId = mintExternalId();
    return this.store.transaction(() => {
      this.db.prepare(
        `INSERT INTO external_identities
           (room_id, external_id, kind, display_name, venues_json, status,
            referrer_external_id, reputation, created_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(roomId, externalId, kind, name, JSON.stringify(venueList), "stranger",
        referrerExternalId ?? null, 0, now, now);
      return this.get(roomId, externalId);
    });
  }

  get(roomId, externalId) {
    checkRoom(this.db, roomId);
    if (!EXTERNAL_ID_RE.test(externalId || ""))
      fail(422, "invalid_emissary_input", "externalId must be an ex1.* id");
    const row = this.db.prepare(
      "SELECT * FROM external_identities WHERE room_id=? AND external_id=?"
    ).get(roomId, externalId);
    if (!row) fail(404, "unknown_external", "External identity not found");
    return publicRecord(row);
  }

  list(roomId, { status = null, limit = 50, offset = 0 } = {}) {
    checkRoom(this.db, roomId);
    if (status !== null && !STATUSES.includes(status))
      fail(422, "invalid_emissary_input", "status must be stranger|known|working|vouched|member");
    const take = Math.min(Math.max(Math.trunc(limit) || 0, 1), 200);
    const skip = Math.max(Math.trunc(offset) || 0, 0);
    const rows = status === null
      ? this.db.prepare(
          `SELECT * FROM external_identities WHERE room_id=?
           ORDER BY created_at ASC, external_id ASC LIMIT ? OFFSET ?`
        ).all(roomId, take, skip)
      : this.db.prepare(
          `SELECT * FROM external_identities WHERE room_id=? AND status=?
           ORDER BY created_at ASC, external_id ASC LIMIT ? OFFSET ?`
        ).all(roomId, status, take, skip);
    return rows.map(publicRecord);
  }

  touch(roomId, externalId) {
    const record = this.get(roomId, externalId);
    this.db.prepare(
      "UPDATE external_identities SET last_seen_at=? WHERE room_id=? AND external_id=?"
    ).run(Date.now(), roomId, externalId);
    return { ...record, last_seen_at: Date.now() };
  }

  // Monotonic status ladder. Only one rung up per call; anything else
  // (skips, demotions, unknown words) fails. Slice 1a callers: verifyVenue
  // promotes stranger -> known; higher rungs belong to later slices.
  setStatus(roomId, externalId, toStatus) {
    const record = this.get(roomId, externalId);
    if (!STATUSES.includes(toStatus))
      fail(422, "invalid_emissary_input", "status must be stranger|known|working|vouched|member");
    const from = STATUS_RANK[record.status];
    const to = STATUS_RANK[toStatus];
    if (to !== from + 1)
      fail(422, "invalid_status_transition",
        `status may only advance one rung (currently ${record.status})`);
    return this.store.transaction(() => {
      this.db.prepare(
        "UPDATE external_identities SET status=?, last_seen_at=? WHERE room_id=? AND external_id=?"
      ).run(toStatus, Date.now(), roomId, externalId);
      return this.get(roomId, externalId);
    });
  }

  // Attach and check a venue proof. signed_card with a valid signature
  // whose card name binds the claimed handle promotes stranger -> known.
  // venue_api evidence is stored opaquely (server-side checks land later)
  // and never promotes. self_asserted cannot be "verified".
  verifyVenue(roomId, externalId, venueIndex, proof) {
    const record = this.get(roomId, externalId);
    const index = Math.trunc(venueIndex);
    if (!Number.isInteger(index) || index < 0 || index >= record.venues.length)
      fail(404, "unknown_venue", "Venue index out of range");
    const venue = record.venues[index];
    if (proof === null || typeof proof !== "object" || Array.isArray(proof))
      fail(422, "invalid_emissary_input", "proof must be an object");
    const kind = proof.kind;
    if (kind === "self_asserted")
      fail(422, "invalid_proof", "self_asserted venues cannot be verified; attach a signed_card or venue_api proof");
    if (kind === "signed_card") {
      const { agentId, card, publicKey, signature } = proof;
      if (typeof agentId !== "string" || !agentId
        || card === null || typeof card !== "object" || Array.isArray(card)
        || typeof publicKey !== "string" || !publicKey
        || typeof signature !== "string" || !signature)
        fail(422, "invalid_proof", "signed_card proof needs {kind, agentId, card, publicKey, signature}");
      // The card must bind the claimed handle: its name is the identity
      // the keyholder signed for, and it must equal the venue handle.
      if (typeof card.name !== "string" || card.name !== venue.handle)
        fail(422, "proof_handle_mismatch", "signed card name does not match the claimed venue handle");
      if (!verifyCardSignature({ agentId, card, publicKey, signature }))
        fail(422, "invalid_proof", "signed card signature did not verify");
      return this.store.transaction(() => {
        const venues = record.venues.map((v, i) => i === index
          ? { ...v, proof: "signed_card", verified_at: Date.now() }
          : v);
        // A verified handle is exclusive per room: adopting it here must
        // not steal it from another identity.
        const collision = findVerifiedCollision(this.db, roomId, venues, externalId);
        if (collision)
          fail(409, "venue_handle_taken",
            "This verified venue handle already belongs to another external identity",
            { external_id: collision });
        this.db.prepare(
          "UPDATE external_identities SET venues_json=?, last_seen_at=? WHERE room_id=? AND external_id=?"
        ).run(JSON.stringify(venues), Date.now(), roomId, externalId);
        const updated = this.get(roomId, externalId);
        if (updated.status === "stranger") return this.setStatus(roomId, externalId, "known");
        return updated;
      });
    }
    if (kind === "venue_api") {
      const evidence = proof.evidence;
      if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence))
        fail(422, "invalid_proof", "venue_api proof needs {kind, evidence} (opaque object)");
      return this.store.transaction(() => {
        const venues = record.venues.map((v, i) => i === index
          ? { ...v, proof: "venue_api", verified_at: null }
          : v);
        this.db.prepare(
          "UPDATE external_identities SET venues_json=?, last_seen_at=? WHERE room_id=? AND external_id=?"
        ).run(JSON.stringify(venues), Date.now(), roomId, externalId);
        return this.get(roomId, externalId);
      });
    }
    fail(422, "invalid_proof", "proof.kind must be signed_card|venue_api");
  }

  // Merge a duplicate identity into a canonical one: non-duplicate venues
  // move over, receipts are reassigned, the duplicate row is deleted.
  // Statuses never merge down — the survivor keeps its own status.
  merge(roomId, fromExternalId, toExternalId) {
    if (fromExternalId === toExternalId)
      fail(422, "invalid_emissary_input", "cannot merge an identity into itself");
    const from = this.get(roomId, fromExternalId);
    const to = this.get(roomId, toExternalId);
    return this.store.transaction(() => {
      const have = new Set(to.venues.map(v => `${v.venue}\n${v.handle}`));
      const merged = [...to.venues];
      for (const v of from.venues) {
        if (have.has(`${v.venue}\n${v.handle}`)) continue;
        // A verified handle moving over must not collide with a third identity.
        if (v.proof !== "self_asserted") {
          const collision = findVerifiedCollision(this.db, roomId, [v], toExternalId);
          if (collision && collision !== fromExternalId)
            fail(409, "venue_handle_taken",
              "A verified venue handle in the merge belongs to another external identity",
              { external_id: collision });
        }
        have.add(`${v.venue}\n${v.handle}`);
        merged.push(v);
      }
      this.db.prepare(
        "UPDATE external_identities SET venues_json=?, last_seen_at=? WHERE room_id=? AND external_id=?"
      ).run(JSON.stringify(merged), Date.now(), roomId, toExternalId);
      // M-11a: merged venues must not exceed the cap the rest of the code assumes.
      if (merged.length > MAX_VENUES)
        fail(422, "too_many_venues", `merge would leave ${merged.length} venues, over the ${MAX_VENUES} cap`,
          { external_id: toExternalId });
      // M-11b: reassign other identities' referrers to the survivor (or NULL)
      // before deleting the source row — otherwise referrer_external_id
      // dangles at a deleted identity, violating the schema invariant.
      this.db.prepare(
        "UPDATE external_identities SET referrer_external_id=? WHERE room_id=? AND referrer_external_id=?"
      ).run(toExternalId, roomId, fromExternalId);
      this.db.prepare(
        "DELETE FROM external_identities WHERE room_id=? AND external_id=?"
      ).run(roomId, fromExternalId);
      // Reassign receipts through the receipts module when wired.
      this.store.emissaryReceipts?.reassignExternal(roomId, fromExternalId, toExternalId);
      return this.get(roomId, toExternalId);
    });
  }
}
