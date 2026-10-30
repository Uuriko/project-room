// FTS5 room-message search (PERF-50 D2-a): a unicode61 external-content
// index over the MSG-1 `messages` table replaces the per-query substring
// scan in store.search(). The index is a derived store: `messages` is the
// source of truth, triggers keep the index in step inside the same
// transaction as every row write (post, edit, delete/redact — a tombstone
// stores body NULL, which indexes as no terms), and creation runs a full
// 'rebuild' so a drifted or newly created index converges from the table
// itself. Nothing here is authoritative: store.search() only takes the
// FTS path when messageSearchCoversRoom() proves the table carries
// exactly the room's live (non-archived) messages, and it falls back to
// the legacy scan whenever the index is unavailable (a SQLite build
// without FTS5, e.g. an unverified Workers build) or a query has no
// indexable term (punctuation-only needles keep substring semantics).
//
// The index is created LAZILY, on first search use — the abuse-rate
// buckets precedent. A fresh store must not create it: the shard
// classification (server/room-shard-tables.mjs) requires replay-skipped
// tables to be absent from a fresh store, and the NDJSON backup replay
// cannot load FTS shadow rows (they are read-only index internals), so
// the tables sit in REPLAY_SKIPPED_TABLES and a restore rebuilds the
// index from `messages` the first time the restored store is searched.
//
// Match semantics change by design (D2): terms are ANDed instead of one
// exact-phrase substring, case and diacritics fold in the tokenizer
// (unicode61 remove_diacritics 2: `zurich` finds `Zürich`, `cafe` finds
// `CAFÉ`), and results stay chronological with the existing cursor
// contract — BM25 only orders the ranked probe below, which the search
// quality tests use to prove precision@10. Whole-token matching means a
// needle that is only a substring of a token (`deploy` in `deployment`)
// no longer matches; that parity add-on is the parked trigram leg (D2-b).
import { archiveMarker } from "./messages-store.mjs";

export const MESSAGE_SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  body,
  content='messages',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_after_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_after_update AFTER UPDATE OF body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_after_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
`;

const ensuredDbs = new WeakSet();

// Create the index (table + triggers) and rebuild it from `messages`,
// once per database handle. Runs outside any read transaction (DDL and
// the rebuild are writes). Returns false — and search falls back to the
// legacy scan — on a read-only handle or a SQLite build without FTS5.
export function ensureMessageSearchIndex(db) {
  if (ensuredDbs.has(db)) return true;
  try {
    db.exec(MESSAGE_SEARCH_SCHEMA);
    ensuredDbs.add(db);
    return true;
  } catch {
    return false;
  }
}

// Terms of a search needle. Combining marks stay inside a term: the JS
// fold of `İ` is `i` + U+0307, and splitting there would shard the term
// into `i` + `stanbul`, which matches nothing (the #5035 pinned needle).
// The FTS tokenizer folds each extracted term again (case + diacritics),
// so the raw term text is safe to quote as a phrase.
export function messageSearchTerms(query) {
  return [...String(query).toLowerCase().matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map(m => m[0]);
}

export function messageSearchMatch(query) {
  const terms = messageSearchTerms(query);
  if (!terms.length) return null;
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

// Candidate rows for a room, oldest first (seq, then insertion order for
// the `:channel` copies that share a posting seq). Returns null when the
// caller must use the legacy scan: no indexable term, or the index is
// missing/unreadable in this SQLite build.
export function messageSearchCandidates(db, roomId, query) {
  const match = messageSearchMatch(query);
  if (match == null) return null;
  if (!ensureMessageSearchIndex(db)) return null;
  try {
    return db.prepare(
      `SELECT m.message_id AS messageId, m.body AS body, m.record_json AS recordJson
       FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.room_id = ?
       ORDER BY m.seq ASC, m.rowid ASC`
    ).all(match, roomId);
  } catch {
    return null;
  }
}

// BM25-ranked candidate ids, best first. Not the served order (search
// results are chronological, cursor contract unchanged); this is the
// ranking the D2 spike measured precision@10 against, kept executable so
// the quality pin in tests/message-search-fts.test.js measures the same
// thing the spike did.
export function messageSearchRankedIds(db, roomId, query, limit = 10) {
  const match = messageSearchMatch(query);
  if (match == null) return null;
  if (!ensureMessageSearchIndex(db)) return null;
  try {
    return db.prepare(
      `SELECT m.message_id AS messageId
       FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.room_id = ?
       ORDER BY bm25(messages_fts) ASC, m.seq ASC LIMIT ?`
    ).all(match, roomId, limit).map(row => row.messageId);
  } catch {
    return null;
  }
}

// The FTS path is complete for a room only when the messages table's
// non-archived rows are exactly the projection's messages. The command
// path double-writes every message event (MSG-1), but initialize/import
// writes reach the table only through the budgeted backfill; while a
// room is behind, the count differs and search keeps the legacy scan, so
// no message the scan would find can go missing. The archived segment
// needs no gate: candidates and today's archived leg read the same rows.
export function messageSearchCoversRoom(db, roomId, liveCount) {
  try {
    const { throughSeq, retainedJson } = archiveMarker(db, roomId);
    const row = throughSeq
      ? db.prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE room_id = ?
         AND NOT (seq <= ? AND message_id NOT IN (SELECT value FROM json_each(?)))`
      ).get(roomId, throughSeq, retainedJson)
      : db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id = ?").get(roomId);
    return row?.n === liveCount;
  } catch {
    return false;
  }
}
