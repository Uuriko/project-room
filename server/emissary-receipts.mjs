// Emissary slice 1a — external work receipt index (work.receipts).
//
// An append-only index of signed receipts attributable to external
// identities (or to room offers worked by outsiders). Slice 1a is the
// index only: it records that a receipt exists, who it belongs to, and
// what kind it is. Verification of receipt signatures, jury verdicts, and
// reputation effects land in later slices; nothing here moves money or
// grants capability.
//
// Receipt model:
//   receipt_id   "ert1." + 32 lowercase hex, minted server-side.
//   external_id  optional ex1.* id; when present it must already exist in
//                the same room (fail closed, 404 otherwise).
//   offer_id     optional opaque string (offers table lands later).
//   kind         work | jury | oracle | tier_cut | reputation_import.
//   payload_json opaque JSON object (the signed receipt body lives here).
//
// Reads are deterministic: created_at ASC, receipt_id ASC. Filters are
// exact-match on kind; unknown kinds fail closed.
//
// Local ServiceError (mirrors server/store.mjs); we avoid importing from
// the store to keep this module dependency-light for tests.
import { randomBytes } from "node:crypto";

class ServiceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const fail = (status, code, message, details) => { throw new ServiceError(status, code, message, details); };

export const RECEIPT_ID_RE = /^ert1\.[0-9a-f]{32}$/;
export const EXTERNAL_ID_RE = /^ex1\.[0-9a-f]{32}$/;
const KINDS = new Set(["work", "jury", "oracle", "tier_cut", "reputation_import"]);
const MAX_PAYLOAD_BYTES = 65536;

export const mintReceiptId = () => `ert1.${randomBytes(16).toString("hex")}`;

export const emissaryReceiptSchema = `
  CREATE TABLE IF NOT EXISTS external_receipts (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    receipt_id TEXT NOT NULL,
    external_id TEXT,
    offer_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('work','jury','oracle','tier_cut','reputation_import')),
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, receipt_id)
  );
  CREATE INDEX IF NOT EXISTS external_receipts_by_external ON external_receipts(room_id, external_id);
  CREATE INDEX IF NOT EXISTS external_receipts_by_offer ON external_receipts(room_id, offer_id);
`;

const checkRoom = (db, roomId) => {
  if (typeof roomId !== "string" || !roomId) fail(422, "invalid_emissary_input", "roomId is required");
  const room = db.prepare("SELECT id FROM rooms WHERE id=?").get(roomId);
  if (!room) fail(404, "unknown_room", "Room not found");
};

const checkPayload = (payload) => {
  if (payload === undefined) return {};
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    fail(422, "invalid_emissary_input", "payload must be an object");
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES)
    fail(422, "invalid_emissary_input", "payload exceeds 64KiB");
  return payload;
};

const publicReceipt = (row) => ({
  room_id: row.room_id,
  receipt_id: row.receipt_id,
  external_id: row.external_id,
  offer_id: row.offer_id,
  kind: row.kind,
  payload: JSON.parse(row.payload_json),
  created_at: row.created_at,
});

export class EmissaryReceipts {
  constructor(store) { this.store = store; this.db = store.db; }

  record(roomId, { externalId = null, offerId = null, kind, payload } = {}) {
    checkRoom(this.db, roomId);
    if (!KINDS.has(kind))
      fail(422, "invalid_emissary_input", "kind must be work|jury|oracle|tier_cut|reputation_import");
    let external = null;
    if (externalId !== null && externalId !== undefined) {
      if (!EXTERNAL_ID_RE.test(externalId))
        fail(422, "invalid_emissary_input", "externalId must be an ex1.* id");
      external = this.db.prepare(
        "SELECT external_id FROM external_identities WHERE room_id=? AND external_id=?"
      ).get(roomId, externalId);
      if (!external) fail(404, "unknown_external", "External identity not found in this room");
    }
    let offer = null;
    if (offerId !== null && offerId !== undefined) {
      if (typeof offerId !== "string" || !offerId || offerId.length > 128 || /[\u0000-\u001f\u007f]/.test(offerId))
        fail(422, "invalid_emissary_input", "offerId must be a 1-128 character string");
      offer = offerId;
    }
    const body = checkPayload(payload);
    const now = Date.now();
    const receiptId = mintReceiptId();
    return this.store.transaction(() => {
      this.db.prepare(
        `INSERT INTO external_receipts
           (room_id, receipt_id, external_id, offer_id, kind, payload_json, created_at)
         VALUES (?,?,?,?,?,?,?)`
      ).run(roomId, receiptId, externalId ?? null, offer, kind, JSON.stringify(body), now);
      return this.get(roomId, receiptId);
    });
  }

  get(roomId, receiptId) {
    checkRoom(this.db, roomId);
    if (!RECEIPT_ID_RE.test(receiptId || ""))
      fail(422, "invalid_emissary_input", "receiptId must be an ert1.* id");
    const row = this.db.prepare(
      "SELECT * FROM external_receipts WHERE room_id=? AND receipt_id=?"
    ).get(roomId, receiptId);
    if (!row) fail(404, "unknown_receipt", "Receipt not found");
    return publicReceipt(row);
  }

  listByExternal(roomId, externalId, { kind = null, limit = 50, offset = 0 } = {}) {
    checkRoom(this.db, roomId);
    if (!EXTERNAL_ID_RE.test(externalId || ""))
      fail(422, "invalid_emissary_input", "externalId must be an ex1.* id");
    const exists = this.db.prepare(
      "SELECT external_id FROM external_identities WHERE room_id=? AND external_id=?"
    ).get(roomId, externalId);
    if (!exists) fail(404, "unknown_external", "External identity not found in this room");
    if (kind !== null && !KINDS.has(kind))
      fail(422, "invalid_emissary_input", "kind must be work|jury|oracle|tier_cut|reputation_import");
    const take = Math.min(Math.max(Math.trunc(limit) || 0, 1), 200);
    const skip = Math.max(Math.trunc(offset) || 0, 0);
    const rows = kind === null
      ? this.db.prepare(
          `SELECT * FROM external_receipts WHERE room_id=? AND external_id=?
           ORDER BY created_at ASC, receipt_id ASC LIMIT ? OFFSET ?`
        ).all(roomId, externalId, take, skip)
      : this.db.prepare(
          `SELECT * FROM external_receipts WHERE room_id=? AND external_id=? AND kind=?
           ORDER BY created_at ASC, receipt_id ASC LIMIT ? OFFSET ?`
        ).all(roomId, externalId, kind, take, skip);
    return rows.map(publicReceipt);
  }

  listByOffer(roomId, offerId, { limit = 50, offset = 0 } = {}) {
    checkRoom(this.db, roomId);
    if (typeof offerId !== "string" || !offerId)
      fail(422, "invalid_emissary_input", "offerId is required");
    const take = Math.min(Math.max(Math.trunc(limit) || 0, 1), 200);
    const skip = Math.max(Math.trunc(offset) || 0, 0);
    const rows = this.db.prepare(
      `SELECT * FROM external_receipts WHERE room_id=? AND offer_id=?
       ORDER BY created_at ASC, receipt_id ASC LIMIT ? OFFSET ?`
    ).all(roomId, offerId, take, skip);
    return rows.map(publicReceipt);
  }

  // Identity merge support: move every receipt from one external id to
  // another within the same room. Called by EmissaryGraph.merge inside
  // its transaction; safe to call directly too.
  reassignExternal(roomId, fromExternalId, toExternalId) {
    checkRoom(this.db, roomId);
    if (!EXTERNAL_ID_RE.test(fromExternalId || "") || !EXTERNAL_ID_RE.test(toExternalId || ""))
      fail(422, "invalid_emissary_input", "external ids must be ex1.* ids");
    return this.store.transaction(() => {
      const result = this.db.prepare(
        "UPDATE external_receipts SET external_id=? WHERE room_id=? AND external_id=?"
      ).run(toExternalId, roomId, fromExternalId);
      return { reassigned: Number(result.changes) };
    });
  }
}
