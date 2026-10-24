// Durable landing-record registry (RECORD-PRIM, mig-primitives.md
// Primitive 3).
//
// Landing records are the room-native Record object: one typed object per
// qualified PR head, carrying its evidence and priced flags as data instead
// of JSON embedded in a message the room-journal watcher parses back out.
// This is NOT the receipts store and not the land queue: the queue is a view
// over what may land next; a record is the qualification itself, and it
// outlives the landing (the landed transition is the LAND_RECORD leg).
//
// Items are stored whole as JSON in the persisted-row envelope. The state
// machine in server/landing-records.mjs validates every item it reads, so a
// row is never trusted without passing through it first.

import { encodeRow, decodeRow } from "./persisted-row.mjs";

export const LANDING_RECORD_ROW_KIND = "landing-record";
const LANDING_RECORD_FIELDS = ["id", "pr", "headSha", "baseSha", "state", "evidence", "flags",
  "acceptingAuthority", "note", "createdByMemberId", "createdByDisplayName", "createdByKind",
  "createdAt", "landedAt", "landedByMemberId", "mergedSha", "treeSha",
  "revokedAt", "revokeReason", "supersededBy", "supersededByHeadSha", "supersedes", "history"];
const LANDING_RECORD_DEFAULTS = { evidence: [], flags: [], acceptingAuthority: null, note: null,
  createdByDisplayName: null, createdByKind: null, landedAt: null, landedByMemberId: null,
  mergedSha: null, treeSha: null, revokedAt: null, revokeReason: null,
  supersededBy: null, supersededByHeadSha: null, supersedes: [], history: [] };
const decodeItem = text => decodeRow(text, { kind: LANDING_RECORD_ROW_KIND, fields: LANDING_RECORD_FIELDS, defaults: LANDING_RECORD_DEFAULTS });

export const landingRecordSchema = `
  CREATE TABLE IF NOT EXISTS landing_records (
    room_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    item_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, record_id)
  );
`;

export function createDurableLandingRecordRegistry(db, { now = () => Date.now(), transaction = fn => fn() } = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("a SQLite database handle is required");
  // Prepare lazily: RoomStore constructs services before its atomic schema migration.
  const statement = sql => ({
    get: (...args) => db.prepare(sql).get(...args),
    all: (...args) => db.prepare(sql).all(...args),
    run: (...args) => db.prepare(sql).run(...args),
  });
  const selectOne = statement("SELECT item_json FROM landing_records WHERE room_id=? AND record_id=?");
  const selectRoom = statement("SELECT item_json FROM landing_records WHERE room_id=? ORDER BY rowid ASC");
  const upsert = statement(`INSERT INTO landing_records (room_id, record_id, item_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id, record_id) DO UPDATE SET item_json=excluded.item_json, updated_at=excluded.updated_at`);
  const remove = statement("DELETE FROM landing_records WHERE room_id=? AND record_id=?");

  return {
    transaction,
    verifySchema({ allowAbsent = false } = {}) {
      const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
      const sql = landingRecordSchema.trim().replace(/;$/, "");
      const actual = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get("landing_records")?.sql;
      if (allowAbsent && actual === undefined) return false;
      if (normalize(sql) !== normalize(actual)) throw new Error("Landing-record schema requires operator reconciliation");
      return true;
    },
    get(roomId, id) {
      const row = selectOne.get(roomId, id);
      return row ? decodeItem(row.item_json) : null;
    },
    set(roomId, item) {
      if (!item || typeof item.id !== "string") throw new TypeError("landing record item needs an id");
      upsert.run(roomId, item.id, JSON.stringify(encodeRow(LANDING_RECORD_ROW_KIND, item)), now());
      return item;
    },
    list(roomId) { return selectRoom.all(roomId).map(row => decodeItem(row.item_json)); },
    has(roomId, id) { return selectOne.get(roomId, id) != null; },
    delete(roomId, id) { remove.run(roomId, id); },
  };
}
