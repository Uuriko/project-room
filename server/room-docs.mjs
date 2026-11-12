// Room docs (Linear parity: Docs). OFF unless ROOM_DOCS=1.
// Markdown documents with slug ids, shared by every room member, with full
// revision history. Writes carry baseRev (0 to create); a write against a
// stale revision is refused so concurrent agents never clobber each other.
export const ROOM_DOC_TABLES = Object.freeze(["room_docs", "room_doc_revisions"]);
export const roomDocsEnabled = (env = process.env) => env?.ROOM_DOCS === "1";
export const DOC_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_TITLE = 200;
export const MAX_BODY = 50_000;

const ensure = db => db.exec(`CREATE TABLE IF NOT EXISTS room_docs (room_id TEXT NOT NULL, doc_id TEXT NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL, rev INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (room_id, doc_id));
  CREATE TABLE IF NOT EXISTS room_doc_revisions (room_id TEXT NOT NULL, doc_id TEXT NOT NULL, rev INTEGER NOT NULL, title TEXT NOT NULL,
  body TEXT NOT NULL, author TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (room_id, doc_id, rev))`);

const out = r => ({ docId: r.doc_id, title: r.title, body: r.body, rev: r.rev, updatedBy: r.updated_by ?? r.author,
  updatedAt: new Date(r.updated_at ?? r.at).toISOString() });

// Reads never create schema. Lazy initialization belongs to the first write.
const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

// Stable keyset order: editing a document cannot move it behind the cursor.
// This is a live traversal, not a snapshot; restart to see new ids <= after.
export function listDocs(db, { roomId, limit = 100, after = "" }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || (after !== "" && !DOC_ID.test(after))) throw new TypeError("Invalid document page");
  const rows = hasTable(db, "room_docs")
    ? db.prepare("SELECT doc_id, title, rev, updated_by, updated_at FROM room_docs WHERE room_id = ? AND doc_id > ? ORDER BY doc_id LIMIT ?")
      .all(roomId, after, limit + 1) : [];
  const hasMore = rows.length > limit;
  const docs = rows.slice(0, limit).map(r => ({ docId: r.doc_id, title: r.title, rev: r.rev, updatedBy: r.updated_by, updatedAt: new Date(r.updated_at).toISOString() }));
  return { docs, hasMore, nextAfter: hasMore ? docs.at(-1).docId : null };
}

export function getDoc(db, { roomId, docId, rev = null }) {
  if (!hasTable(db, rev === null ? "room_docs" : "room_doc_revisions")) return null;
  const r = rev === null
    ? db.prepare("SELECT * FROM room_docs WHERE room_id = ? AND doc_id = ?").get(roomId, docId)
    : db.prepare("SELECT * FROM room_doc_revisions WHERE room_id = ? AND doc_id = ? AND rev = ?").get(roomId, docId, rev);
  return r ? out(r) : null;
}

// Returns { doc } or { conflict: currentRev }. One store transaction, so a
// write and its revision row land together or not at all.
export function writeDoc(store, { roomId, docId, title, body, baseRev, author, now = Date.now() }) {
  const db = store.db;
  ensure(db);
  const conflict = store.transaction(() => {
    const cur = db.prepare("SELECT rev FROM room_docs WHERE room_id = ? AND doc_id = ?").get(roomId, docId);
    const currentRev = cur?.rev ?? 0;
    if (currentRev !== baseRev) return currentRev;
    const rev = currentRev + 1;
    db.prepare(`INSERT INTO room_docs (room_id, doc_id, title, body, rev, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (room_id, doc_id) DO UPDATE SET title = excluded.title, body = excluded.body, rev = excluded.rev,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(roomId, docId, title, body, rev, author, now);
    db.prepare("INSERT INTO room_doc_revisions (room_id, doc_id, rev, title, body, author, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(roomId, docId, rev, title, body, author, now);
    return null;
  });
  return conflict === null ? { doc: getDoc(db, { roomId, docId }) } : { conflict };
}
