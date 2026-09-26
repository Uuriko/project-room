// Durable work-claim registry.
//
// server/work-claim-routes.mjs keeps claims in createWorkClaimRegistry(), a
// module-level Map. On the live Worker that Map lives inside the ProjectRoom
// Durable Object, so every deploy or eviction drops every claim, lease and
// review attestation. This module is the same registry interface backed by
// the room SQLite database, so the routes and next-actions need no change:
// pass `createDurableWorkClaimRegistry(store.db)` wherever the default
// registry is used today, and exec `workClaimSchema` with the other schemas.
//
// Items are stored whole as JSON. The work-claims state machine validates
// every item it reads (workOf), so a row is never trusted without passing
// through it first.

import { roomWorkClaimConfig } from "./work-claims.mjs";

export const workClaimSchema = `
  CREATE TABLE IF NOT EXISTS work_claims (
    room_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    item_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, claim_id)
  );
  CREATE TABLE IF NOT EXISTS work_claim_config (
    room_id TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

const parse = text => {
  const value = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("work claim row is not an object");
  return value;
};

export function createDurableWorkClaimRegistry(db, { now = () => Date.now() } = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("a SQLite database handle is required");
  const selectOne = db.prepare("SELECT item_json FROM work_claims WHERE room_id=? AND claim_id=?");
  const selectRoom = db.prepare("SELECT item_json FROM work_claims WHERE room_id=? ORDER BY rowid ASC");
  const upsert = db.prepare(`INSERT INTO work_claims (room_id, claim_id, item_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id, claim_id) DO UPDATE SET item_json=excluded.item_json, updated_at=excluded.updated_at`);
  const selectConfig = db.prepare("SELECT config_json FROM work_claim_config WHERE room_id=?");
  const upsertConfig = db.prepare(`INSERT INTO work_claim_config (room_id, config_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at`);

  const rawConfig = roomId => {
    const row = selectConfig.get(roomId);
    return row ? parse(row.config_json) : {};
  };

  return {
    get(roomId, id) {
      const row = selectOne.get(roomId, id);
      return row ? parse(row.item_json) : null;
    },
    set(roomId, item) {
      if (!item || typeof item.id !== "string") throw new TypeError("work claim item needs an id");
      upsert.run(roomId, item.id, JSON.stringify(item), now());
      return item;
    },
    list(roomId) { return selectRoom.all(roomId).map(row => parse(row.item_json)); },
    has(roomId, id) { return selectOne.get(roomId, id) !== undefined; },
    configure(roomId, config) {
      if (config !== undefined && config !== null) {
        if (typeof config !== "object" || Array.isArray(config)) throw new Error("room work-claim config must be an object");
        upsertConfig.run(roomId, JSON.stringify({ ...rawConfig(roomId), ...config }), now());
      }
      return roomWorkClaimConfig({ workClaims: rawConfig(roomId) });
    },
    configFor(roomId) { return roomWorkClaimConfig({ workClaims: rawConfig(roomId) }); },
    rawConfig(roomId) { return { ...rawConfig(roomId) }; },
  };
}
