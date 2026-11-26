import { createHash } from "node:crypto";

export const previewBytes = 384 * 1024;
export const patchBytes = 192 * 1024;
export const outputBytes = 24 * 1024;
export const previewJsonBytes = (previewBytes + patchBytes + outputBytes) * 6 + 4096;
export const WORKSPACE_PREVIEW_TABLES = Object.freeze(["room_workspace_previews", "room_workspace_directed_previews"]);
const [shared, directed] = WORKSPACE_PREVIEW_TABLES;
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
  let patchStorage = Boolean(db.prepare("SELECT 1 FROM pragma_table_info('room_workspace_previews') WHERE name='patch'").get());
  if (create && !patchStorage) {
    db.exec("ALTER TABLE room_workspace_previews ADD COLUMN patch TEXT; ALTER TABLE room_workspace_previews ADD COLUMN patch_digest TEXT");
    patchStorage = true;
  }
  let outputStorage = Boolean(db.prepare("SELECT 1 FROM pragma_table_info('room_workspace_previews') WHERE name='run_output'").get());
  if (create && !outputStorage) {
    db.exec("ALTER TABLE room_workspace_previews ADD COLUMN run_output TEXT; ALTER TABLE room_workspace_previews ADD COLUMN output_digest TEXT");
    outputStorage = true;
  }
  // Earlier runtimes only know the shared table. A rollback must never turn a
  // directed artifact into a room-wide one.
  if (create) db.exec(`CREATE TABLE IF NOT EXISTS ${directed} (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, id TEXT NOT NULL,
    publisher_id TEXT NOT NULL, title TEXT NOT NULL, base TEXT NOT NULL, head TEXT NOT NULL,
    digest TEXT NOT NULL, html TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    patch TEXT, patch_digest TEXT, run_output TEXT, output_digest TEXT, recipient_id TEXT NOT NULL,
    PRIMARY KEY(room_id,id)
  )`);
  const hasDirected = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(directed));
  const sharedFields = fields + ", NULL AS recipientId"
    + (patchStorage ? ", patch_digest AS patchDigest" : ", NULL AS patchDigest")
    + (outputStorage ? ", output_digest AS outputDigest" : ", NULL AS outputDigest");
  const directedFields = fields + ", recipient_id AS recipientId, patch_digest AS patchDigest, output_digest AS outputDigest";
  return {
    list(roomId, viewerId) {
      const first = `SELECT ${sharedFields} FROM ${shared} WHERE room_id=?`;
      if (!hasDirected) return db.prepare(first + ` ORDER BY updatedAt DESC,id DESC LIMIT ${roomLimit}`).all(roomId);
      return db.prepare(first + ` UNION ALL SELECT ${directedFields} FROM ${directed}
        WHERE room_id=? AND (publisher_id=? OR recipient_id=?) ORDER BY updatedAt DESC,id DESC LIMIT ${roomLimit}`)
        .all(roomId, roomId, viewerId, viewerId);
    },
    get(roomId, id, viewerId, part) {
      const patch = patchStorage ? "patch" : "NULL AS patch";
      const output = outputStorage ? "run_output AS output" : "NULL AS output";
      const body = part === "changes" ? patch : part === "output" ? output : part === "preview" ? "html" : `html,${patch},${output}`;
      const visible = db.prepare(`SELECT ${sharedFields}${part === "metadata" ? "" : "," + body} FROM ${shared} WHERE room_id=? AND id=?`).get(roomId, id);
      if (visible || !hasDirected) return visible;
      const scope = viewerId === undefined ? "" : " AND (publisher_id=? OR recipient_id=?)";
      const directedBody = part === "changes" ? "patch" : part === "output" ? "run_output AS output" : part === "preview" ? "html" : "html,patch,run_output AS output";
      return db.prepare(`SELECT ${directedFields}${part === "metadata" ? "" : "," + directedBody} FROM ${directed} WHERE room_id=? AND id=?${scope}`)
        .get(roomId, id, ...(viewerId === undefined ? [] : [viewerId, viewerId]));
    },
    publish(roomId, publisherId, input, now, reject) {
      const existing = this.get(roomId, input.id);
      if (existing && existing.publisherId !== publisherId) reject(403, "preview_owner_required", "Only the publisher can update this preview");
      const recipientId = input.recipientId ?? null;
      if (existing && existing.recipientId !== recipientId)
        reject(409, "preview_audience_changed", "Use a new workspace preview ID to change who can see it");
      const html = input.html;
      const title = input.title.trim();
      const digest = createHash("sha256").update(html).digest("hex");
      const sameSource = existing?.head === input.head && existing.base === input.base;
      const patch = input.patch ?? (sameSource ? existing.patch : null);
      const patchDigest = patch === null ? null : createHash("sha256").update(patch).digest("hex");
      const output = input.output ?? (sameSource && existing.digest === digest ? existing.output : null);
      const outputDigest = output === null ? null : createHash("sha256").update(output).digest("hex");
      if (existing?.digest === digest && existing.title === title && sameSource && existing.patchDigest === patchDigest
        && existing.outputDigest === outputDigest)
        return { ...metadata(existing), changed: false };
      if ((existing?.revision ?? 0) !== input.expectedRevision)
        reject(409, "preview_changed", "Read the latest preview revision before publishing");
      if (!existing) {
        const counts = db.prepare(`SELECT count(*) AS total, sum(publisher_id=?) AS owned FROM (
          SELECT publisher_id FROM ${shared} WHERE room_id=? UNION ALL SELECT publisher_id FROM ${directed} WHERE room_id=?
        )`).get(publisherId, roomId, roomId);
        if (counts.total >= roomLimit || counts.owned >= ownerLimit)
          reject(409, "preview_limit", "Remove an earlier workspace preview before publishing a new one");
      }
      const table = recipientId ? directed : shared;
      db.prepare(`INSERT INTO ${table}
        (room_id,id,publisher_id,title,base,head,digest,html,revision,updated_at,patch,patch_digest,run_output,output_digest${recipientId ? ",recipient_id" : ""}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?${recipientId ? ",?" : ""})
        ON CONFLICT(room_id,id) DO UPDATE SET title=excluded.title,base=excluded.base,head=excluded.head,
        digest=excluded.digest,html=excluded.html,revision=excluded.revision,updated_at=excluded.updated_at,
        patch=excluded.patch,patch_digest=excluded.patch_digest,run_output=excluded.run_output,output_digest=excluded.output_digest`)
        .run(roomId, input.id, publisherId, title, input.base, input.head, digest, html, input.expectedRevision + 1, now, patch, patchDigest, output, outputDigest, ...(recipientId ? [recipientId] : []));
      return { ...metadata(this.get(roomId, input.id)), changed: true };
    },
    remove(roomId, publisherId, input, owner, reject) {
      const existing = this.get(roomId, input.id);
      if (!existing || (existing.recipientId && ![existing.publisherId, existing.recipientId].includes(publisherId)))
        return { removed: true, changed: false };
      if (existing.publisherId !== publisherId && (!owner || existing.recipientId))
        reject(403, "preview_owner_required", "Only the publisher or room owner can remove this preview");
      if (existing.revision !== input.expectedRevision) reject(409, "preview_changed", "Read the latest preview revision before removing it");
      db.prepare(`DELETE FROM ${existing.recipientId ? directed : shared} WHERE room_id=? AND id=?`).run(roomId, input.id);
      return { removed: true, changed: true, publisherId: existing.publisherId, recipientId: existing.recipientId };
    },
  };
}

function metadata({ html: _html, patch: _patch, output: _output, ...value }) { return value; }

export function validPreviewSelection(id) {
  return typeof id === "string" && previewId.test(id);
}

export function validatePreviewInput(input, removing) {
  if (!input || !validPreviewSelection(input.id)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return false;
  if (removing) return Object.keys(input).length === 2;
  const fields = ["id", "expectedRevision", "title", "html", "base", "head", "patch", "output", "recipientId"];
  const bounded = (key, max) => !Object.hasOwn(input, key)
    || typeof input[key] === "string" && Buffer.byteLength(input[key]) <= max;
  return Object.keys(input).every(key => fields.includes(key))
    && (!Object.hasOwn(input, "recipientId") || typeof input.recipientId === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(input.recipientId))
    && bounded("patch", patchBytes) && bounded("output", outputBytes) && typeof input.title === "string" && input.title.trim().length > 0
    && input.title.length <= 150 && typeof input.html === "string"
    && input.html.trim().length > 0 && Buffer.byteLength(input.html) <= previewBytes
    && typeof input.base === "string" && gitId.test(input.base)
    && typeof input.head === "string" && gitId.test(input.head);
}
