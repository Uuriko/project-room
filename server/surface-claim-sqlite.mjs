// Durable surface-claim registry (CLAIM-PRIM, mig-primitives.md Primitive 1).
//
// Surface claims are the room-native coordination claim: a member takes a
// claim on a subject (PRs, issues, a branch, repo surfaces, a lane, the room
// itself, or free-named work) so other members and fleets can see who holds
// what before touching it. This is NOT the work-claim registry: work claims
// lease board work items; surface claims coordinate shared surfaces.
//
// Items are stored whole as JSON in the persisted-row envelope. The state
// machine in server/surface-claims.mjs validates every item it reads, so a
// row is never trusted without passing through it first.

import { encodeRow, decodeRow } from "./persisted-row.mjs";

export const SURFACE_CLAIM_ROW_KIND = "surface-claim";
const SURFACE_CLAIM_FIELDS = ["id", "holderMemberId", "holderDisplayName", "holderKind", "scope", "note",
  "state", "claimedAt", "expiresAt", "heartbeatAt", "releasedAt", "releaseReason",
  "supersededBy", "supersedes", "history"];
const SURFACE_CLAIM_DEFAULTS = { holderDisplayName: null, holderKind: null, scope: null, note: null,
  state: "active", claimedAt: null, expiresAt: null, heartbeatAt: null, releasedAt: null,
  releaseReason: null, supersededBy: null, supersedes: [], history: [] };
const decodeItem = text => decodeRow(text, { kind: SURFACE_CLAIM_ROW_KIND, fields: SURFACE_CLAIM_FIELDS, defaults: SURFACE_CLAIM_DEFAULTS });

export const surfaceClaimSchema = `
  CREATE TABLE IF NOT EXISTS surface_claims (
    room_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    item_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, claim_id)
  );
`;

export function createDurableSurfaceClaimRegistry(db, { now = () => Date.now(), transaction = fn => fn() } = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("a SQLite database handle is required");
  // Prepare lazily: RoomStore constructs services before its atomic schema migration.
  const statement = sql => ({
    get: (...args) => db.prepare(sql).get(...args),
    all: (...args) => db.prepare(sql).all(...args),
    run: (...args) => db.prepare(sql).run(...args),
  });
  const selectOne = statement("SELECT item_json FROM surface_claims WHERE room_id=? AND claim_id=?");
  const selectRoom = statement("SELECT item_json FROM surface_claims WHERE room_id=? ORDER BY rowid ASC");
  const upsert = statement(`INSERT INTO surface_claims (room_id, claim_id, item_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id, claim_id) DO UPDATE SET item_json=excluded.item_json, updated_at=excluded.updated_at`);
  const remove = statement("DELETE FROM surface_claims WHERE room_id=? AND claim_id=?");

  return {
    transaction,
    verifySchema({ allowAbsent = false } = {}) {
      const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
      const sql = surfaceClaimSchema.trim().replace(/;$/, "");
      const actual = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get("surface_claims")?.sql;
      if (allowAbsent && actual === undefined) return false;
      if (normalize(sql) !== normalize(actual)) throw new Error("Surface-claim schema requires operator reconciliation");
      return true;
    },
    get(roomId, id) {
      const row = selectOne.get(roomId, id);
      return row ? decodeItem(row.item_json) : null;
    },
    set(roomId, item) {
      if (!item || typeof item.id !== "string") throw new TypeError("surface claim item needs an id");
      upsert.run(roomId, item.id, JSON.stringify(encodeRow(SURFACE_CLAIM_ROW_KIND, item)), now());
      return item;
    },
    list(roomId) { return selectRoom.all(roomId).map(row => decodeItem(row.item_json)); },
    has(roomId, id) { return selectOne.get(roomId, id) != null; },
    delete(roomId, id) { remove.run(roomId, id); },
  };
}
