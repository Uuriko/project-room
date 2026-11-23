import { createHash } from "node:crypto";

export const previewBytes = 384 * 1024;
export const previewJsonBytes = previewBytes * 6 + 4096;
const roomLimit = 24;
const ownerLimit = 6;
const fields = "id, publisher_id AS publisherId, title, base, head, digest, revision, updated_at AS updatedAt";
const previewId = /^[a-f0-9]{32}$/;
const gitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function workspacePreviews(db, { create = true } = {}) {
  const installed = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_workspace_previews'").get();
  if (!installed && !create) return null;
  if (!installed) db.exec(`CREATE TABLE IF NOT EXISTS room_workspace_previews (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, id TEXT NOT NULL,
    publisher_id TEXT NOT NULL, title TEXT NOT NULL, base TEXT NOT NULL, head TEXT NOT NULL,
    digest TEXT NOT NULL, html TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(room_id,id)
  )`);
  return {
    list(roomId) {
      return db.prepare(`SELECT ${fields} FROM room_workspace_previews WHERE room_id=?
        ORDER BY updated_at DESC,id DESC LIMIT ${roomLimit}`).all(roomId);
    },
    get(roomId, id) {
      return db.prepare(`SELECT ${fields},html FROM room_workspace_previews WHERE room_id=? AND id=?`).get(roomId, id);
    },
    publish(roomId, publisherId, input, now, reject) {
      const existing = this.get(roomId, input.id);
      if (existing && existing.publisherId !== publisherId) reject(403, "preview_owner_required", "Only the publisher can update this preview");
      const html = input.html;
      const title = input.title.trim();
      const digest = createHash("sha256").update(html).digest("hex");
      if (existing?.digest === digest && existing.title === title && existing.head === input.head && existing.base === input.base)
        return metadata(existing);
      if ((existing?.revision ?? 0) !== input.expectedRevision)
        reject(409, "preview_changed", "Read the latest preview revision before publishing");
      if (!existing) {
        const room = this.list(roomId);
        if (room.length >= roomLimit || room.filter(row => row.publisherId === publisherId).length >= ownerLimit)
          reject(409, "preview_limit", "Remove an earlier workspace preview before publishing a new one");
      }
      db.prepare(`INSERT INTO room_workspace_previews VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(room_id,id) DO UPDATE SET title=excluded.title,base=excluded.base,head=excluded.head,
        digest=excluded.digest,html=excluded.html,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(roomId, input.id, publisherId, title, input.base, input.head, digest, html, input.expectedRevision + 1, now);
      return metadata(this.get(roomId, input.id));
    },
    remove(roomId, publisherId, input, owner, reject) {
      const existing = this.get(roomId, input.id);
      if (!existing) return { removed: true };
      if (existing.publisherId !== publisherId && !owner)
        reject(403, "preview_owner_required", "Only the publisher or room owner can remove this preview");
      if (existing.revision !== input.expectedRevision) reject(409, "preview_changed", "Read the latest preview revision before removing it");
      db.prepare("DELETE FROM room_workspace_previews WHERE room_id=? AND id=?").run(roomId, input.id);
      return { removed: true };
    },
  };
}

function metadata({ html: ignored, ...value }) { return value; }

export function validPreviewSelection(id) {
  return typeof id === "string" && previewId.test(id);
}

export function validatePreviewInput(input, removing) {
  if (!input || !validPreviewSelection(input.id)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return false;
  if (removing) return Object.keys(input).length === 2;
  return Object.keys(input).length === 6 && typeof input.title === "string" && input.title.trim().length > 0
    && input.title.length <= 150 && typeof input.html === "string"
    && input.html.trim().length > 0 && Buffer.byteLength(input.html) <= previewBytes
    && typeof input.base === "string" && gitId.test(input.base)
    && typeof input.head === "string" && gitId.test(input.head);
}
