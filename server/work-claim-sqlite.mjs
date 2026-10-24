// Durable work-claim registry.
//
// Production RoomStore owns this registry; HTTP and next-actions share it.
// Claims, leases and review attestations survive Worker eviction and deployment.
// The Map registry remains a fixture for isolated state-machine tests.
//
// Items are stored whole as JSON. The work-claims state machine validates
// every item it reads (workOf), so a row is never trusted without passing
// through it first.

import { roomWorkClaimConfig, MAX_CLAIM_HISTORY } from "./work-claims.mjs";
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
  "repo", "branch", "chain", "supersededBy", "workItemId", "squadId",
  "kind", "revision", "ci", "reviews", "historyOmitted", "readingAcks", "deploy",
  "requestOutcomes", "acceptanceCriteria", "delivery", "verification", "deliveryGeneration", "claimRound"];
const WORK_CLAIM_DEFAULTS = { title: null, state: "unclaimed", owner: null, history: [],
  claimedAt: null, leaseStartAt: null, leaseExpiresAt: null, deliveryMode: null,
  reviewPolicy: null, reviewedBy: null, attestations: [], tags: [], files: [], fileBlocks: {}, blobs: [],
  dependsOn: [], parentClaimId: null, evidenceRefs: [], premiseFlag: null,
  pullRequest: null, pullRequests: [], updatedAt: null,
  repo: null, branch: null, chain: [], supersededBy: null, workItemId: null, squadId: null,
  kind: "work", revision: null, ci: null, reviews: [], readingAcks: {}, deploy: null, requestOutcomes: {},
  acceptanceCriteria: [], delivery: null, verification: null, deliveryGeneration: 0, claimRound: 0 };
const decodeItem = text => {
  const item = decodeRow(text, { kind: WORK_CLAIM_ROW_KIND, fields: WORK_CLAIM_FIELDS, defaults: WORK_CLAIM_DEFAULTS });
  if (item.title == null) item.title = item.id; // workOf: title ?? id
  // SEC-2 history cap: only claims that dropped history carry the counter.
  if (item.historyOmitted == null) delete item.historyOmitted;
  // plan-pr-autolink: deploy links are sparse; absent means never deployed.
  if (item.deploy == null) delete item.deploy;
  // PRODUCT-200 A4: idempotency records are sparse; absent means none seen.
  if (item.requestOutcomes == null || Object.keys(item.requestOutcomes).length === 0) delete item.requestOutcomes;
  return item;
};

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
  CREATE TABLE IF NOT EXISTS work_claim_history (
    room_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    stamp_json TEXT NOT NULL,
    PRIMARY KEY (room_id, claim_id, seq)
  );
  CREATE TABLE IF NOT EXISTS work_claim_review_history (
    room_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    review_json TEXT NOT NULL,
    PRIMARY KEY (room_id, claim_id, seq)
  );
`;

const parse = text => {
  const value = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("work claim row is not an object");
  return value;
};

export function createDurableWorkClaimRegistry(db, { now = () => Date.now(), transaction = fn => fn(), onChange = null } = {}) {
  if (!db || typeof db.prepare !== "function") throw new TypeError("a SQLite database handle is required");
  // Prepare lazily: RoomStore constructs services before its atomic schema migration.
  const statement = sql => ({
    get: (...args) => db.prepare(sql).get(...args),
    all: (...args) => db.prepare(sql).all(...args),
    run: (...args) => db.prepare(sql).run(...args),
  });
  const selectOne = statement("SELECT item_json FROM work_claims WHERE room_id=? AND claim_id=?");
  const selectRoom = statement("SELECT item_json FROM work_claims WHERE room_id=? ORDER BY rowid ASC");
  const upsert = statement(`INSERT INTO work_claims (room_id, claim_id, item_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id, claim_id) DO UPDATE SET item_json=excluded.item_json, updated_at=excluded.updated_at`);
  const selectConfig = statement("SELECT config_json FROM work_claim_config WHERE room_id=?");
  const upsertConfig = statement(`INSERT INTO work_claim_config (room_id, config_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at`);
  const insertSpill = statement("INSERT OR IGNORE INTO work_claim_history (room_id, claim_id, seq, stamp_json) VALUES (?, ?, ?, ?)");
  const selectSpill = statement("SELECT seq, stamp_json FROM work_claim_history WHERE room_id=? AND claim_id=? AND seq<? ORDER BY seq ASC");
  const deleteSpill = statement("DELETE FROM work_claim_history WHERE room_id=? AND claim_id=?");
  const insertReviewVersion = statement("INSERT OR IGNORE INTO work_claim_review_history (room_id, claim_id, seq, review_json) VALUES (?, ?, ?, ?)");
  const selectReviewVersions = statement("SELECT seq, review_json FROM work_claim_review_history WHERE room_id=? AND claim_id=? ORDER BY seq ASC");
  const maxReviewVersionSeq = statement("SELECT COALESCE(MAX(seq), -1) AS max_seq FROM work_claim_review_history WHERE room_id=? AND claim_id=?");
  const deleteReviewVersions = statement("DELETE FROM work_claim_review_history WHERE room_id=? AND claim_id=?");
  // W3 claim-history spill: work_claim_history is additive (created by the
  // schema exec on open), but a registry can be constructed before that
  // exec runs and read-only handles never create it, so availability is
  // probed rather than assumed. A true result is cached for the life of
  // the registry; a false one is re-probed on the next write or read.
  let spillReady = false;
  const spillAvailable = () => {
    if (!spillReady) {
      spillReady = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get("work_claim_history"));
    }
    return spillReady;
  };
  // HW-CAPTURE review-version archive: work_claim_review_history carries
  // the same availability story as the spill — additive (created by the
  // schema exec on open), but a registry can be constructed before that
  // exec runs and read-only handles never create it, so availability is
  // probed rather than assumed.
  let reviewArchiveReady = false;
  const reviewArchiveAvailable = () => {
    if (!reviewArchiveReady) {
      reviewArchiveReady = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get("work_claim_review_history"));
    }
    return reviewArchiveReady;
  };
  // Key-order-insensitive record comparison: a review record round-trips
  // through JSON storage, so identity of content — not key order or
  // object identity — decides whether a record was displaced.
  const canonicalReview = value => {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(canonicalReview).join(",")}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalReview(value[key])}`).join(",")}}`;
  };
  const omittedOf = value => (Number.isSafeInteger(value) && value > 0 ? value : 0);
  // The state machine trims a claim's in-row history to MAX_CLAIM_HISTORY
  // (SEC-2) before the item reaches set(), so the dropped stamps are absent
  // from the item being written — but a trim drops from the front, so they
  // are exactly the front of the previously stored row's history followed
  // by any stamps appended in the same batch, and the previously stored
  // row still holds its share. Preserve that prefix here, under each
  // stamp's lifetime seq (the stored historyOmitted counts the stamps
  // before the stored window, so stored history[i] has seq
  // historyOmitted + i). Stamps appended AND dropped inside one set()
  // batch never reach a stored row and cannot be sourced; no current
  // writer appends more than a stamp or two per set(), so the sourced
  // prefix covers every real write.
  const spillDroppedHistory = (roomId, item) => {
    const nextOmitted = omittedOf(item?.historyOmitted);
    if (nextOmitted === 0 || !spillAvailable()) return;
    const row = selectOne.get(roomId, item.id);
    if (!row) return;
    const before = decodeItem(row.item_json);
    const beforeOmitted = omittedOf(before.historyOmitted);
    if (nextOmitted <= beforeOmitted) return;
    const beforeHistory = Array.isArray(before.history) ? before.history : [];
    const sourced = Math.min(nextOmitted, beforeOmitted + beforeHistory.length);
    for (let seq = beforeOmitted; seq < sourced; seq += 1) {
      insertSpill.run(roomId, item.id, seq, JSON.stringify(beforeHistory[seq - beforeOmitted]));
    }
  };
  // The stored row always keeps the SEC-2 shape — newest MAX_CLAIM_HISTORY
  // stamps plus the historyOmitted counter — whatever shape the caller
  // hands set(). Writers that trim before set() (withHistory,
  // claim-autolink) take the spillDroppedHistory path above. A caller
  // round-tripping a reunited get() can hand back MORE than the cap (a
  // field-only update appends no stamp, so nothing re-trims it); the
  // excess is then the item's own front — history[i] has lifetime seq
  // historyOmitted + i — and is spilled from the item itself before the
  // row is written. Either way, the trim stops destroying stamps.
  const capForStorage = (roomId, item) => {
    const history = Array.isArray(item?.history) ? item.history : null;
    if (!history || history.length <= MAX_CLAIM_HISTORY) {
      spillDroppedHistory(roomId, item);
      return item;
    }
    const omitted = omittedOf(item.historyOmitted);
    const excess = history.length - MAX_CLAIM_HISTORY;
    if (spillAvailable()) {
      for (let index = 0; index < excess; index += 1) {
        insertSpill.run(roomId, item.id, omitted + index, JSON.stringify(history[index]));
      }
    }
    return { ...item, history: history.slice(excess), historyOmitted: omitted + excess };
  };

  // The state machine keeps only the latest review record per member on
  // the item: recordReview filters the member's prior record out, and
  // attestWork supersedes a verdict the same way, so a re-review used to
  // destroy the earlier verdict record outright — verdict, summary, url
  // and basis survived nowhere. Preserve every displaced record here, at
  // set() time, before the stored row is replaced: a record in the
  // previously stored row that the item being written no longer carries
  // for that member (member absent, or the member's record changed) is
  // appended to work_claim_review_history under the claim's next
  // lifetime seq. The stored row keeps its current shape; reviewHistory()
  // below is the versioned read. A no-change set() displaces nothing.
  const archiveDisplacedReviews = (roomId, item) => {
    if (!reviewArchiveAvailable()) return;
    const row = selectOne.get(roomId, item.id);
    if (!row) return;
    const before = decodeItem(row.item_json);
    const prior = Array.isArray(before.reviews) ? before.reviews : [];
    if (prior.length === 0) return;
    const next = Array.isArray(item?.reviews) ? item.reviews : [];
    const nextByMember = new Map(next.map(entry => [entry?.memberId, entry]));
    let seq = null;
    for (const record of prior) {
      const memberId = record?.memberId;
      if (typeof memberId !== "string") continue;
      const current = nextByMember.get(memberId);
      if (current !== undefined && canonicalReview(current) === canonicalReview(record)) continue;
      if (seq === null) seq = maxReviewVersionSeq.get(roomId, item.id).max_seq + 1;
      insertReviewVersion.run(roomId, item.id, seq, JSON.stringify(record));
      seq += 1;
    }
  };

  const rawConfig = roomId => {
    const row = selectConfig.get(roomId);
    return row ? parse(row.config_json) : {};
  };

  return {
    transaction,
    verifySchema({ allowAbsent = false } = {}) {
      const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
      const definitions = workClaimSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean);
      const shapes = definitions.map(sql => ({ name: /CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(sql)[1], sql, actual: db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(sql)[1])?.sql }));
      // The purely additive sidecars (work_claim_history, the W3 history
      // spill; work_claim_review_history, the HW-CAPTURE review-version
      // archive): an older database carries the claim pair without them
      // and read-only startup never creates them, so absence is the
      // pre-sidecar state, not damage — a present sidecar is
      // shape-verified, an absent one is tolerated (the wake-queue
      // side-table pattern). The claim pair itself stays all-or-nothing:
      // both absent is the pre-claims state allowAbsent exists for;
      // exactly one absent, or any shape drift anywhere, is operator
      // reconciliation.
      const sidecarNames = new Set(["work_claim_history", "work_claim_review_history"]);
      const core = shapes.filter(shape => !sidecarNames.has(shape.name));
      const sidecar = shapes.filter(shape => sidecarNames.has(shape.name));
      if (sidecar.some(shape => shape.actual !== undefined && normalize(shape.sql) !== normalize(shape.actual))) throw new Error("Work-claim schema requires operator reconciliation");
      if (allowAbsent && core.every(shape => shape.actual === undefined)) return false;
      if (core.some(shape => normalize(shape.sql) !== normalize(shape.actual))) throw new Error("Work-claim schema requires operator reconciliation");
      return true;
    },
    get(roomId, id) {
      const row = selectOne.get(roomId, id);
      if (!row) return null;
      const item = decodeItem(row.item_json);
      const omitted = omittedOf(item.historyOmitted);
      if (omitted > 0 && spillAvailable()) {
        const spilled = selectSpill.all(roomId, id, omitted);
        // Reunite only a complete, contiguous prefix [0, omitted): a short
        // or gapped spill means out-of-band loss, and the stored shape
        // (window + counter) is the honest read — never fabricate stamps.
        if (spilled.length === omitted && spilled.every((entry, index) => entry.seq === index)) {
          item.history = [...spilled.map(entry => JSON.parse(entry.stamp_json)), ...(Array.isArray(item.history) ? item.history : [])];
          delete item.historyOmitted;
        }
      }
      return item;
    },
    // Every review record ever recorded for the claim: the archived
    // versions displaced by re-reviews (lifetime seq order), then the
    // records still live on the item. Per member the order is the
    // recording order, and the newest record per member here is exactly
    // the record get() shows in item.reviews — the versioned read loses
    // nothing the current read shows, and the live read model is
    // unchanged. Without the sidecar (a pre-archive database) this is
    // just the live records.
    reviewHistory(roomId, id) {
      const archived = reviewArchiveAvailable()
        ? selectReviewVersions.all(roomId, id).map(entry => JSON.parse(entry.review_json))
        : [];
      const row = selectOne.get(roomId, id);
      if (!row) return archived;
      const item = decodeItem(row.item_json);
      const live = Array.isArray(item.reviews) ? item.reviews : [];
      return [...archived, ...live];
    },
    set(roomId, item) {
      if (!item || typeof item.id !== "string") throw new TypeError("work claim item needs an id");
      archiveDisplacedReviews(roomId, item);
      upsert.run(roomId, item.id, JSON.stringify(encodeRow(WORK_CLAIM_ROW_KIND, capForStorage(roomId, item))), now());
      if (typeof onChange === "function") onChange(roomId);
      return item;
    },
    list(roomId) { return selectRoom.all(roomId).map(row => decodeItem(row.item_json)); },
    has(roomId, id) { return selectOne.get(roomId, id) != null; },
    delete(roomId, id) {
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
        upsert.run(roomId, item.id, JSON.stringify(encodeRow(WORK_CLAIM_ROW_KIND, waived)), now());
      }
      db.prepare("DELETE FROM work_claims WHERE room_id=? AND claim_id=?").run(roomId, id);
      // Claim deletion is an explicit, receipted act (the land-queue paths
      // name the dependents): the claim's spilled history dies with it, so
      // a later claim reusing the id can never inherit a predecessor's
      // stamps through the reunion read.
      if (spillAvailable()) deleteSpill.run(roomId, id);
      // Same rule for the review-version archive: the claim's archived
      // verdicts die with it, so a later claim reusing the id can never
      // inherit a predecessor's verdicts through the versioned read.
      if (reviewArchiveAvailable()) deleteReviewVersions.run(roomId, id);
      if (typeof onChange === "function") onChange(roomId);
    },
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
