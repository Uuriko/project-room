// Copyright 2026 Project Room contributors. Licensed under the Apache License,
// Version 2.0 (see LICENSE).
//
// Portions adapted from block/buzz, crates/buzz-audit/src/hash.rs
// (https://github.com/block/buzz, commit fae3f03), Copyright 2026 Block, Inc.,
// Licensed under the Apache License, Version 2.0. Taken: the version-2 TLV
// preimage (one-byte tag + big-endian u64 length + value, optional fields
// omitted so bytes cannot move between fields), canonical JSON with sorted
// keys, and "hash = SHA-256(preimage that includes prev_hash)". Changed: our
// own domain tag; ts is a big-endian u64 of epoch milliseconds, which removes
// the RFC 3339 sub-second precision hazard that Buzz's `to_storage_precision`
// exists to patch; no legacy v1 encoding; Node/Workers `createHash`, not
// `sha2`. See THIRD_PARTY.md.
//
// room_signal_log: a compact, per-room, hash-chained, prunable record of the
// operational signals the journal does not carry (wake sent/delivered/acked/
// dropped now; pr/deploy/smoke/rollback next). It is a diagnostic ledger, not
// an authority: nothing here grants a claim, lease, merge or deploy. The
// journal stays the source of truth for messages and work.
//
// Invariants:
//  - append is synchronous (read head, insert) with no await between, so the
//    chain cannot fork inside one Durable Object / Node process;
//  - never throws: accounting must not fail a post, a wake or an ack;
//  - detail <= 256 bytes, no message text, no secrets, no error text;
//  - bounded: at most SIGNAL_LOG_MAX_ROWS rows and SIGNAL_LOG_MAX_AGE_MS per
//    room, pruned opportunistically; the newest row is never pruned, and
//    verification starts from the oldest retained row's prev_hash;
//  - lazy/additive table, not in backups (REPLAY_SKIPPED_TABLES): a restore
//    starts a fresh chain.
import { createHash } from "node:crypto";

export const SIGNAL_TYPES = Object.freeze([
  "wake.sent", "wake.delivered", "wake.acked", "wake.dropped", "turn.completed",
  "pr.merged", "ci.settled", "deploy.finished", "smoke.passed", "smoke.failed", "rollback"
]);
export const SIGNAL_DETAIL_MAX_BYTES = 256;
export const SIGNAL_LOG_MAX_ROWS = 5000;
export const SIGNAL_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY = 100;
const DOMAIN = "room:signal:v1\0";

export const signalLogSchema = `
  CREATE TABLE IF NOT EXISTS room_signal_log (
    room_id TEXT NOT NULL, seq INTEGER NOT NULL, ts_ms INTEGER NOT NULL, type TEXT NOT NULL,
    actor_id TEXT, target_id TEXT, ref TEXT, parent_seq INTEGER,
    detail TEXT NOT NULL DEFAULT '{}', prev_hash BLOB, hash BLOB NOT NULL,
    PRIMARY KEY(room_id, seq)
  ) WITHOUT ROWID;
  -- Partial index: only non-wake rows (receipts), so reading receipts never walks the much
  -- higher-volume wake rows, and wake rows pay no index write.
  CREATE INDEX IF NOT EXISTS room_signal_log_receipts ON room_signal_log(room_id, seq) WHERE type NOT LIKE 'wake.%';
`;
const ensured = new WeakSet();
export function ensureSignalLogSchema(db) {
  if (!db || ensured.has(db)) return false;
  db.exec(signalLogSchema);
  ensured.add(db);
  return true;
}

function appendTlv(parts, tag, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  parts.push(Buffer.from([tag]), length, bytes);
}
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

// Sorted-key JSON, recursively, so the same detail always hashes the same.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    // Like JSON.stringify, undefined members are absent (not the text "undefined").
    return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Tags: 1 room, 2 seq, 3 ts_ms, 4 type, 5 actor?, 6 target?, 7 ref?, 8 parent_seq?, 9 detail, 10 prev_hash?.
export function computeSignalHash(entry) {
  const parts = [Buffer.from(DOMAIN, "utf8")];
  appendTlv(parts, 1, entry.roomId);
  appendTlv(parts, 2, u64(entry.seq));
  appendTlv(parts, 3, u64(entry.tsMs));
  appendTlv(parts, 4, entry.type);
  if (entry.actorId != null) appendTlv(parts, 5, entry.actorId);
  if (entry.targetId != null) appendTlv(parts, 6, entry.targetId);
  if (entry.ref != null) appendTlv(parts, 7, entry.ref);
  if (entry.parentSeq != null) appendTlv(parts, 8, u64(entry.parentSeq));
  appendTlv(parts, 9, canonicalJson(entry.detail ?? {}));
  if (entry.prevHash != null) appendTlv(parts, 10, entry.prevHash);
  return createHash("sha256").update(Buffer.concat(parts)).digest();
}

const clip = (v, n) => (typeof v === "string" && v ? v.slice(0, n) : null);

// Append one signal. Returns { seq, hash } or null (unknown type, bad input, or
// the table is unavailable). Detail that would exceed the byte cap is dropped
// to {} rather than truncated mid-JSON.
export function appendSignal(db, { roomId = "", at, type, actorId = null, targetId = null, ref = null, parentSeq = null, detail = null } = {}) {
  try {
    if (!SIGNAL_TYPES.includes(type) || !Number.isSafeInteger(at) || at < 0) return null;
    ensureSignalLogSchema(db);
    const room = typeof roomId === "string" ? roomId : "";
    let body = detail && typeof detail === "object" && !Array.isArray(detail) ? detail : {};
    if (Buffer.byteLength(canonicalJson(body)) > SIGNAL_DETAIL_MAX_BYTES) body = {};
    const head = db.prepare("SELECT seq, hash FROM room_signal_log WHERE room_id=? ORDER BY seq DESC LIMIT 1").get(room);
    const entry = { roomId: room, seq: (head?.seq ?? 0) + 1, tsMs: at, type, actorId: clip(actorId, 80), targetId: clip(targetId, 80),
      ref: clip(ref, 80), parentSeq: Number.isSafeInteger(parentSeq) && parentSeq > 0 ? parentSeq : null, detail: body,
      prevHash: head ? Buffer.from(head.hash) : null };
    const hash = computeSignalHash(entry);
    db.prepare(`INSERT INTO room_signal_log (room_id, seq, ts_ms, type, actor_id, target_id, ref, parent_seq, detail, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(room, entry.seq, at, type, entry.actorId, entry.targetId, entry.ref, entry.parentSeq, canonicalJson(body), entry.prevHash, hash);
    if (entry.seq % PRUNE_EVERY === 0) pruneSignalLog(db, room, at);
    return { seq: entry.seq, hash };
  } catch {
    return null;
  }
}

// Keep the newest SIGNAL_LOG_MAX_ROWS rows younger than SIGNAL_LOG_MAX_AGE_MS.
// Both cuts are primary-key range deletes from the oldest end; the newest row
// always survives so the chain head is never lost.
export function pruneSignalLog(db, roomId, now, { maxRows = SIGNAL_LOG_MAX_ROWS, maxAgeMs = SIGNAL_LOG_MAX_AGE_MS } = {}) {
  try {
    ensureSignalLogSchema(db);
    const head = db.prepare("SELECT MAX(seq) AS seq FROM room_signal_log WHERE room_id=?").get(roomId)?.seq ?? 0;
    if (head === 0) return 0;
    let cut = head - maxRows; // delete seq <= cut
    const fresh = db.prepare("SELECT seq FROM room_signal_log WHERE room_id=? AND ts_ms>=? ORDER BY seq LIMIT 1").get(roomId, now - maxAgeMs);
    cut = Math.max(cut, (fresh?.seq ?? head) - 1);
    cut = Math.min(cut, head - 1);
    if (cut <= 0) return 0;
    return Number(db.prepare("DELETE FROM room_signal_log WHERE room_id=? AND seq<=?").run(roomId, cut).changes);
  } catch {
    return 0;
  }
}

// Recompute the chain over the retained rows. The oldest retained row's
// prev_hash is the anchor (its predecessor was pruned), so pruning is never
// reported as tampering; any edit, deletion in the middle or reorder is.
export function verifySignalChain(db, roomId, { limit = SIGNAL_LOG_MAX_ROWS } = {}) {
  ensureSignalLogSchema(db);
  const rows = db.prepare("SELECT * FROM room_signal_log WHERE room_id=? ORDER BY seq LIMIT ?").all(roomId, limit);
  let prev = null, expectSeq = null;
  for (const row of rows) {
    const prevHash = row.prev_hash == null ? null : Buffer.from(row.prev_hash);
    const anchored = prev === null ? true : Buffer.compare(prev, prevHash ?? Buffer.alloc(0)) === 0;
    const contiguous = expectSeq === null || row.seq === expectSeq;
    const same = Buffer.compare(computeSignalHash({ roomId: row.room_id, seq: row.seq, tsMs: row.ts_ms, type: row.type,
      actorId: row.actor_id, targetId: row.target_id, ref: row.ref, parentSeq: row.parent_seq, detail: JSON.parse(row.detail), prevHash }), Buffer.from(row.hash)) === 0;
    if (!anchored || !contiguous || !same) return { ok: false, checked: rows.length, brokenAt: row.seq, oldestSeq: rows[0].seq, headSeq: rows.at(-1).seq };
    prev = Buffer.from(row.hash); expectSeq = row.seq + 1;
  }
  return { ok: true, checked: rows.length, brokenAt: null, oldestSeq: rows[0]?.seq ?? null, headSeq: rows.at(-1)?.seq ?? null };
}
