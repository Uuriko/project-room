// Durable work-claim registry.
//
// Production RoomStore owns this registry; HTTP and next-actions share it.
// Claims, leases and review attestations survive Worker eviction and deployment.
// The Map registry remains a fixture for isolated state-machine tests.
//
// Items are stored whole as JSON. The work-claims state machine validates
// every item it reads (workOf), so a row is never trusted without passing
// through it first.

import { roomWorkClaimConfig } from "./work-claims.mjs";
import { encodeRow, decodeRow } from "./persisted-row.mjs";

// Replay-safe row kind for claim items (RC-2026-09-27-2730). The fields mirror
// the workOf() output shape in work-claims.mjs; unknown fields are dropped on
// read and missing fields take these defaults, so rows written by older code
// (plain JSON, no envelope) still load.
export const WORK_CLAIM_ROW_KIND = "work-claim";
const WORK_CLAIM_FIELDS = ["id", "title", "state", "owner", "history", "claimedAt",
  "leaseStartAt", "leaseExpiresAt", "deliveryMode", "reviewPolicy", "reviewedBy",
  "attestations", "tags", "files", "fileBlocks", "blobs", "dependsOn", "parentClaimId", "evidenceRefs",
  "premiseFlag", "pullRequest", "pullRequests", "updatedAt",
  "repo", "branch", "chain", "supersededBy", "workItemId", "squadId", "namespace",
  "kind", "revision", "ci", "reviews", "historyOmitted", "readingAcks", "deploy"];
const WORK_CLAIM_DEFAULTS = { title: null, state: "unclaimed", owner: null, history: [],
  claimedAt: null, leaseStartAt: null, leaseExpiresAt: null, deliveryMode: null,
  reviewPolicy: null, reviewedBy: null, attestations: [], tags: [], files: [], fileBlocks: {}, blobs: [],
  dependsOn: [], parentClaimId: null, evidenceRefs: [], premiseFlag: null,
  pullRequest: null, pullRequests: [], updatedAt: null,
  repo: null, branch: null, chain: [], supersededBy: null, workItemId: null, squadId: null,
  namespace: "default",
  kind: "work", revision: null, ci: null, reviews: [], readingAcks: {}, deploy: null };
const decodeItem = text => {
  const item = decodeRow(text, { kind: WORK_CLAIM_ROW_KIND, fields: WORK_CLAIM_FIELDS, defaults: WORK_CLAIM_DEFAULTS });
  if (item.title == null) item.title = item.id; // workOf: title ?? id
  // SEC-2 history cap: only claims that dropped history carry the counter.
  if (item.historyOmitted == null) delete item.historyOmitted;
  // plan-pr-autolink: deploy links are sparse; absent means never deployed.
  if (item.deploy == null) delete item.deploy;
  return item;
};

export const workClaimSchema = `
  CREATE TABLE IF NOT EXISTS work_claims (
    room_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    item_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'default',
    PRIMARY KEY (room_id, claim_id)
  );
  CREATE INDEX IF NOT EXISTS work_claims_board_idx ON work_claims (room_id, namespace);
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

export function createDurableWorkClaimRegistry(db, { now = () => Date.now(), transaction = fn => fn(), onChange = null } = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("a SQLite database handle is required");
  // Sharded boards migration (wave300/sharded-claim-boards): purely additive.
  // Pre-shard databases lack the namespace column; every existing row reads
  // as the default board. ALTER appends the column last, matching the
  // canonical schema shape exactly (verified by verifySchema).
  const columns = db.prepare("PRAGMA table_info(work_claims)").all().map(col => col.name);
  if (columns.length > 0 && !columns.includes("namespace")) {
    db.exec("ALTER TABLE work_claims ADD COLUMN namespace TEXT NOT NULL DEFAULT 'default'");
  }
  if (columns.length > 0 && !db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='work_claims_board_idx'").get()) {
    db.exec("CREATE INDEX IF NOT EXISTS work_claims_board_idx ON work_claims (room_id, namespace)");
  }
  // Prepare lazily: RoomStore constructs services before its atomic schema migration.
  const statement = sql => ({
    get: (...args) => db.prepare(sql).get(...args),
    all: (...args) => db.prepare(sql).all(...args),
    run: (...args) => db.prepare(sql).run(...args),
  });
  const selectOne = statement("SELECT item_json FROM work_claims WHERE room_id=? AND claim_id=?");
  const selectOneNs = statement("SELECT item_json FROM work_claims WHERE room_id=? AND claim_id=? AND namespace=?");
  const selectRoom = statement("SELECT item_json FROM work_claims WHERE room_id=? ORDER BY rowid ASC");
  const selectBoard = statement("SELECT item_json FROM work_claims WHERE room_id=? AND namespace=? ORDER BY rowid ASC");
  const selectNamespaces = statement("SELECT DISTINCT namespace FROM work_claims WHERE room_id=?");
  const upsert = statement(`INSERT INTO work_claims (room_id, claim_id, item_json, updated_at, namespace) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(room_id, claim_id) DO UPDATE SET item_json=excluded.item_json, updated_at=excluded.updated_at, namespace=excluded.namespace`);
  const selectConfig = statement("SELECT config_json FROM work_claim_config WHERE room_id=?");
  const upsertConfig = statement(`INSERT INTO work_claim_config (room_id, config_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at`);

  const rawConfig = roomId => {
    const row = selectConfig.get(roomId);
    return row ? parse(row.config_json) : {};
  };

  return {
    transaction,
    verifySchema({ allowAbsent = false } = {}) {
      const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
      const definitions = workClaimSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean);
      const nameOf = sql => {
        const table = /CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(sql);
        if (table) return table[1];
        const index = /CREATE INDEX IF NOT EXISTS ([a-z_]+)/.exec(sql);
        return index ? index[1] : null;
      };
      const shapes = definitions.map(sql => ({ sql, actual: db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(nameOf(sql))?.sql }));
      if (allowAbsent && shapes.every(shape => shape.actual === undefined)) return false;
      if (shapes.some(shape => normalize(shape.sql) !== normalize(shape.actual))) throw new Error("Work-claim schema requires operator reconciliation");
      return true;
    },
    get(roomId, id, namespace) {
      // Namespace-aware lookup. Without a namespace the default board wins
      // first (backward compatible: pre-shard callers resolve pre-shard
      // claims), then any board — claim ids are room-unique.
      const row = namespace === undefined || namespace === null
        ? (selectOneNs.get(roomId, id, "default") ?? selectOne.get(roomId, id))
        : selectOneNs.get(roomId, id, namespace);
      return row ? decodeItem(row.item_json) : null;
    },
    set(roomId, item) {
      if (!item || typeof item.id !== "string") throw new TypeError("work claim item needs an id");
      const ns = typeof item.namespace === "string" && item.namespace.length > 0 ? item.namespace : "default";
      upsert.run(roomId, item.id, JSON.stringify(encodeRow(WORK_CLAIM_ROW_KIND, item)), now(), ns);
      if (typeof onChange === "function") onChange(roomId);
      return item;
    },
    // list(roomId) merges every board (the global read view). Pass a
    // namespace for one board only.
    list(roomId, namespace) {
      const rows = namespace === undefined || namespace === null
        ? selectRoom.all(roomId)
        : selectBoard.all(roomId, namespace);
      return rows.map(row => decodeItem(row.item_json));
    },
    namespaces(roomId) { return selectNamespaces.all(roomId).map(row => row.namespace); },
    has(roomId, id) { return selectOne.get(roomId, id) != null; },
    delete(roomId, id, namespace) {
      // #1527: readyClaims treats a missing dependency as "not done", so a
      // claim depending on a deleted claim could never return to
      // queue=ready -- stranded, ownerless, invisible. Waive the deleted id
      // from every dependent's dependsOn: the unsatisfiable dependency is
      // dropped and survivors re-evaluate on their remaining dependencies.
      // The land-queue delete paths already emit a deletion receipt naming
      // the dependents, so the waiving is visible, not silent.
      const dependents = selectRoom.all(roomId)
        .map(row => decodeItem(row.item_json))
        .filter(item => item && item.id !== id && Array.isArray(item.dependsOn) && item.dependsOn.includes(id));
      for (const item of dependents) {
        const waived = { ...item, dependsOn: item.dependsOn.filter(dep => dep !== id) };
        const waivedNs = typeof waived.namespace === "string" && waived.namespace.length > 0 ? waived.namespace : "default";
        upsert.run(roomId, item.id, JSON.stringify(encodeRow(WORK_CLAIM_ROW_KIND, waived)), now(), waivedNs);
      }
      if (namespace === undefined || namespace === null) {
        db.prepare("DELETE FROM work_claims WHERE room_id=? AND claim_id=?").run(roomId, id);
      } else {
        db.prepare("DELETE FROM work_claims WHERE room_id=? AND claim_id=? AND namespace=?").run(roomId, id, namespace);
      }
      if (typeof onChange === "function") onChange(roomId);
    },
    configure(roomId, config) {
      if (config !== undefined && config !== null) {
        if (typeof config !== "object" || Array.isArray(config)) throw new Error("room work-claim config must be an object");
        const prev = rawConfig(roomId);
        // Deep-merge per-board caps: setting one board's cap must not wipe
        // another board's entry.
        const boards = (config.boards === undefined || config.boards === null) ? prev.boards
          : { ...(prev.boards ?? {}), ...config.boards };
        upsertConfig.run(roomId, JSON.stringify({ ...prev, ...config, ...(boards === undefined ? {} : { boards }) }), now());
      }
      return roomWorkClaimConfig({ workClaims: rawConfig(roomId) });
    },
    configFor(roomId) { return roomWorkClaimConfig({ workClaims: rawConfig(roomId) }); },
    rawConfig(roomId) { return { ...rawConfig(roomId) }; },
  };
}
