import { messageRepository } from "./message-repository.mjs";
// Public read-only face for rooms.
//
// Rooms are private by default. The room owner may explicitly opt a room
// into a public, no-login, read-only face: a sanitized snapshot (title,
// purpose, member handles, recent non-DM messages) served as HTML at
// /p/{code} and JSON at /api/public/rooms/{code} (+ paginated
// /api/public/rooms/{code}/feed).
//
// Sanitization is a strict field-by-field rebuild — never a passthrough:
//   - DMs (messages with toMemberId) never appear: not counted, not hinted.
//   - Members are handles (displayName) only: no emails, no member ids, no
//     identity links, no permission lists.
//   - Message bodies are shown as written (the owner opted in) but capped
//     in length; deleted bodies (null) are skipped; attachments omitted.
//   - No invite codes, keys, secrets, or share-link codes anywhere.
//
// The module is shaped like ShareLinks/DmConsents: it takes the RoomStore
// (db handle, transactions, room state) and exports its schema for
// store.mjs to apply. Local ServiceError avoids the store.mjs import cycle.
//
// RR-D6 snapshot generation: the sanitized face/feed payloads are derived
// ONCE per room-content version and memoised on the instance (see
// _snapshot). The memo key is a hash of the room's projection BYTES — not
// the room sequence alone: RR-C3 §3.2/#932 establish that repair, archive,
// and history-replacement writes can change read output without advancing
// the sequence, so a sequence-only key could serve a stale snapshot; a
// content key re-derives on any byte change. The visibility gates (code
// enabled, operator unpublish, archived) are still re-checked from
// SQL/state on EVERY request before the memo is served. Nothing here is a
// shared or edge cache, and no ETag is emitted (RR-C3 Contract E §3.5
// keeps public toggle-controlled reads no-store with no etag in v1):
// the memo lives in the serving process, carries only already-sanitized
// public fields, and a disable, rotate, unpublish, or archive takes
// effect on the very next request.

import { createHash, randomBytes } from "node:crypto";
import { LEGAL_FOOTER_LINKS } from "./legal-pages.mjs";
import { refreshListedRoom } from "./public-read-model.mjs";
import { isUnpublished } from "./legal-store.mjs"; // operator unpublish hides a room or receipt from every public read

class ServiceError extends Error {
  constructor(status, code, message, headers = null) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const roomPublicFaceSchema = `
  CREATE TABLE IF NOT EXISTS room_public_settings (
    room_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    public_code TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    rotated_at INTEGER
  );
`;

export const PUBLIC_CODE_PREFIX = "pub1.";
export const MAX_FACE_MESSAGES = 50;
export const MAX_FEED_LIMIT = 100;
export const MAX_BODY_CHARS = 2000;
// RR-D6: bounds for the per-instance snapshot memo. The face payload is
// capped by MAX_FACE_MESSAGES; the feed list is memoised only up to this
// many visible messages (a larger room derives its feed per request,
// exactly as before) so a memo entry stays small even for a huge room.
export const MAX_SNAPSHOT_ROOMS = 64;
export const MAX_SNAPSHOT_FEED_MESSAGES = 2000;

const nowMs = () => Date.now();

const newPublicCode = () => PUBLIC_CODE_PREFIX + randomBytes(24).toString("base64url");

const handleOf = (state, memberId) => {
  const member = state?.members?.[memberId];
  if (!member || member.active === false) return null;
  const name = typeof member.displayName === "string" ? member.displayName.trim() : "";
  return name || null;
};

const visiblePublicMessage = m => m && m.toMemberId == null && typeof m.body === "string" && m.body.length > 0;

const capBody = body => body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + " …" : body;

export class PublicFace {
  constructor(store) {
    if (!store || !store.db) fail(500, "face_store_missing", "PublicFace requires a store with a db handle");
    this.store = store;
    this.db = store.db;
    // RR-D6: roomId -> { key, face, feed } derived snapshots.
    this._snapshots = new Map();
  }

  _roomState(roomId) {
    const room = this.store.room(roomId);
    if (!room) fail(404, "room_not_found", "No such room");
    return room.state;
  }

  _requireOwner(state, memberId) {
    if (memberId !== state?.room?.ownerId) fail(403, "owner_only", "Only the room owner may change the public face");
  }

  // ---- owner controls ------------------------------------------------------
  enable(roomId, ownerMemberId) {
    return this.store.transaction(() => {
      const state = this._roomState(roomId);
      this._requireOwner(state, ownerMemberId);
      const at = nowMs();
      const existing = this.db.prepare("SELECT * FROM room_public_settings WHERE room_id=?").get(roomId);
      const code = existing?.public_code ?? newPublicCode();
      this.db.prepare(
        `INSERT INTO room_public_settings (room_id, enabled, public_code, created_at, rotated_at)
         VALUES (?,?,?,? ,NULL)
         ON CONFLICT(room_id) DO UPDATE SET enabled=1, public_code=excluded.public_code,
           created_at=CASE WHEN room_public_settings.public_code IS NULL THEN excluded.created_at ELSE room_public_settings.created_at END`
      ).run(roomId, 1, code, at);
      refreshListedRoom(this.store, roomId);
      return Object.freeze({ roomId, enabled: true, publicCode: code });
    });
  }

  disable(roomId, ownerMemberId) {
    return this.store.transaction(() => {
      const state = this._roomState(roomId);
      this._requireOwner(state, ownerMemberId);
      this.db.prepare(
        `INSERT INTO room_public_settings (room_id, enabled, public_code, created_at, rotated_at)
         VALUES (?,0,NULL,?,NULL)
         ON CONFLICT(room_id) DO UPDATE SET enabled=0, public_code=NULL`
      ).run(roomId, nowMs());
      refreshListedRoom(this.store, roomId);
      return Object.freeze({ roomId, enabled: false, publicCode: null });
    });
  }

  rotate(roomId, ownerMemberId) {
    return this.store.transaction(() => {
      const state = this._roomState(roomId);
      this._requireOwner(state, ownerMemberId);
      const existing = this.db.prepare("SELECT * FROM room_public_settings WHERE room_id=?").get(roomId);
      if (!existing || !existing.enabled || !existing.public_code) {
        fail(409, "face_not_enabled", "Enable the public face before rotating its code");
      }
      const code = newPublicCode();
      this.db.prepare(
        "UPDATE room_public_settings SET public_code=?, rotated_at=? WHERE room_id=?"
      ).run(code, nowMs(), roomId);
      return Object.freeze({ roomId, enabled: true, publicCode: code });
    });
  }

  status(roomId, viewerMemberId) {
    const state = this._roomState(roomId);
    this._requireOwner(state, viewerMemberId);
    const row = this.db.prepare("SELECT * FROM room_public_settings WHERE room_id=?").get(roomId);
    return Object.freeze({
      roomId,
      enabled: !!(row && row.enabled),
      publicCode: row?.public_code ?? null,
      createdAt: row?.created_at ?? null,
      rotatedAt: row?.rotated_at ?? null
    });
  }

  // ---- public reads -----------------------------------------------------------
  _resolveCode(code) {
    if (typeof code !== "string" || !code.startsWith(PUBLIC_CODE_PREFIX)) fail(404, "face_not_found", "No such public face");
    const row = this.db.prepare(
      "SELECT * FROM room_public_settings WHERE public_code=? AND enabled=1"
    ).get(code);
    if (!row) fail(404, "face_not_found", "No such public face");
    // Operator unpublish overrides the owner's decision to share via this code.
    if (isUnpublished(this.db, "room", row.room_id)) fail(404, "face_not_found", "No such public face");
    return row;
  }

  // Public reads also stop at an archived room, like the other public doors.
  _publicState(row, room = null) {
    const state = room ? room.state : this._roomState(row.room_id);
    if (typeof state?.room?.archivedAt === "string" && state.room.archivedAt) fail(404, "face_not_found", "No such public face");
    return state;
  }

  // Strict sanitizer: rebuilds the public snapshot field-by-field.
  sanitize(state, { messageLimit = MAX_FACE_MESSAGES } = {}) {
    const room = state?.room ?? {};
    const members = state?.members ?? {};
    const handles = Object.keys(members)
      .map(id => handleOf(state, id))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const messages = (Array.isArray(state?.messages) ? state.messages : [])
      // v1 channel caveat: the core projection has no channel field, so
      // every non-DM message is treated as public. Per-channel public
      // flags are explicitly out of v1 (see DESIGN.md).
      .filter(m => m && m.toMemberId == null && typeof m.body === "string" && m.body.length > 0)
      .slice(-messageLimit)
      .map(m => {
        const body = m.body.length > MAX_BODY_CHARS ? m.body.slice(0, MAX_BODY_CHARS) + " …" : m.body;
        return Object.freeze({
          at: m.createdAt ?? null,
          from: handleOf(state, m.authorId) ?? "unknown",
          body
        });
      });
    return Object.freeze({
      room: Object.freeze({
        title: typeof room.title === "string" ? room.title.slice(0, 200) : "",
        purpose: typeof room.purpose === "string" ? room.purpose.slice(0, 2000) : "",
        openedAt: room.createdAt ?? null
      }),
      members: Object.freeze(handles),
      messages: Object.freeze(messages),
      fetchedAt: nowMs()
    });
  }

  // RR-D6: the memo key for one room's current content. Preferred: a hash
  // of the projection bytes read straight from the rooms row (the
  // composite-validator lesson of RR-C3 §3.3 applied to an in-process
  // memo: content bytes subsume sequence, archivedAt, and every
  // history-replacement write, because all of them rewrite the row).
  // Stores without a readable rooms.projection (minimal/fake stores)
  // fall back to the room sequence; stores that can name neither get no
  // memo and derive on every call, exactly as before this change.
  _snapshotKey(row, room) {
    // A store whose rooms table is unreadable answers that once; the
    // failure is cached (false) instead of re-thrown on every request.
    if (this._projectionBytesStmt === undefined) {
      try { this._projectionBytesStmt = this.db.prepare("SELECT projection FROM rooms WHERE id=?"); }
      catch { this._projectionBytesStmt = false; }
    }
    if (this._projectionBytesStmt) {
      try {
        const found = this._projectionBytesStmt.get(row.room_id);
        if (typeof found?.projection === "string") {
          return "h:" + createHash("sha256").update(found.projection).digest("hex");
        }
      } catch { this._projectionBytesStmt = false; }
    }
    return Number.isSafeInteger(room?.sequence) ? `s:${room.sequence}` : null;
  }

  // RR-D6: the derived snapshot for one room at one content key, or null
  // when the store cannot key its content (see _snapshotKey). Derivation
  // runs the same repository reads the per-request paths used to run, so
  // the memoised payload is byte-for-byte what a fresh derivation from
  // the same content builds; `fetchedAt` is re-stamped at serve time,
  // never memoised.
  _snapshot(row, room) {
    const key = this._snapshotKey(row, room);
    if (key === null) return null;
    const hit = this._snapshots.get(row.room_id);
    if (hit && hit.key === key) {
      this._snapshots.delete(row.room_id);
      this._snapshots.set(row.room_id, hit);
      return hit;
    }
    const state = room.state;
    const repository = messageRepository(this.store, row.room_id, state);
    const face = this.sanitize({ ...state, messages: repository.recent(MAX_FACE_MESSAGES, visiblePublicMessage) });
    let feed = null;
    const all = [];
    let overflow = false;
    for (const message of repository.records()) {
      if (!visiblePublicMessage(message)) continue;
      if (all.length >= MAX_SNAPSHOT_FEED_MESSAGES) { overflow = true; break; }
      all.push(message);
    }
    if (!overflow) {
      feed = Object.freeze(all.map(m => Object.freeze({
        id: m.id,
        at: m.createdAt ?? null,
        from: handleOf(state, m.authorId) ?? "unknown",
        body: capBody(m.body)
      })));
    }
    const snap = { key, face, feed };
    this._snapshots.set(row.room_id, snap);
    while (this._snapshots.size > MAX_SNAPSHOT_ROOMS) {
      this._snapshots.delete(this._snapshots.keys().next().value);
    }
    return snap;
  }

  faceByCode(code) {
    const row = this._resolveCode(code);
    const room = this.store.room(row.room_id);
    if (!room) fail(404, "room_not_found", "No such room");
    const state = this._publicState(row, room);
    const snap = this._snapshot(row, room);
    if (snap) return Object.freeze({ ...snap.face, fetchedAt: nowMs() });
    const messages = messageRepository(this.store, row.room_id, state).recent(MAX_FACE_MESSAGES, m => m && m.toMemberId == null && typeof m.body === "string" && m.body.length > 0);
    return this.sanitize({ ...state, messages });
  }

  feedByCode(code, { after = null, limit = 50 } = {}) {
    const row = this._resolveCode(code);
    const room = this.store.room(row.room_id);
    if (!room) fail(404, "room_not_found", "No such room");
    const state = this._publicState(row, room);
    if (after !== null && typeof after !== "string") fail(422, "invalid_feed_cursor", "after must be a message cursor");
    let n = Number(limit);
    if (!Number.isSafeInteger(n) || n < 1) n = 50;
    n = Math.min(n, MAX_FEED_LIMIT);
    const snap = this._snapshot(row, room);
    if (snap?.feed) {
      // The memoised list is the visible-message set repository.records()
      // yields at this sequence, in the same order — paging it is the same
      // result the per-request scan produced, and a cursor naming any
      // message outside the visible set is rejected identically.
      let start = 0;
      if (after !== null) {
        const idx = snap.feed.findIndex(m => m.id === after);
        if (idx === -1) fail(422, "invalid_feed_cursor", "unknown feed cursor — re-fetch from the start");
        start = idx + 1;
      }
      const page = snap.feed.slice(start, start + n);
      return Object.freeze({
        messages: Object.freeze(page),
        next: page.length ? page[page.length - 1].id : after,
        hasMore: start + page.length < snap.feed.length,
        fetchedAt: nowMs()
      });
    }
    const repository = messageRepository(this.store, row.room_id, state);
    const visible = message => message && message.toMemberId == null && typeof message.body === 'string' && message.body.length > 0;
    if (after !== null && !visible(repository.get(after))) fail(422, 'invalid_feed_cursor', 'unknown feed cursor — re-fetch from the start');
    const page = [];
    let hasMore = false;
    for (const message of repository.records({afterId:after})) {
      if (!visible(message)) continue;
      if (page.length === n) { hasMore = true; break; }
      page.push(message);
    }
    return Object.freeze({
      messages: Object.freeze(page.map(m => Object.freeze({
        id: m.id,
        at: m.createdAt ?? null,
        from: handleOf(state, m.authorId) ?? "unknown",
        body: m.body.length > MAX_BODY_CHARS ? m.body.slice(0, MAX_BODY_CHARS) + " …" : m.body
      }))),
      next: page.length ? page[page.length - 1].id : after,
      hasMore,
      fetchedAt: nowMs()
    });
  }

  faceHtml(code) {
    const face = this.faceByCode(code);
    const esc = s => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    const items = face.messages.map(m =>
      `<article><header><strong>${esc(m.from)}</strong><time>${esc(m.at ?? "")}</time></header><p>${esc(m.body)}</p></article>`
    ).join("\n");
    const members = face.members.map(h => `<li>${esc(h)}</li>`).join("");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(face.room.title || "Project Room")}</title>
<style>:root{color-scheme:dark;--bg:#202127;--panel:#191a20;--panel-raised:#292b33;--panel-hover:#34363f;--line:#393b45;--line-soft:#30323a;--line-control:#8a8a96;--text:#eeedf1;--muted:#aaaab7;--blue:#a9b9ff;--blue-strong:#5555bd;--blue-strong-hover:#6a6ad4;--on-accent:#ffffff;--amber:#ffbf69;--green:#4fd09b;--red:#ff7b7b;--violet:#ad8cff;--card:#191a20;--border:#393b45;--shadow:0 20px 70px rgb(0 0 0 / 32%);--control-min-target-coarse:2.75rem;--radius-sm:.35rem;--radius-md:.45rem;--radius-lg:.85rem;--radius-xl:1rem;--space-1:.25rem;--space-2:.5rem;--space-3:.75rem;--space-4:1rem;--space-5:1.5rem;--space-6:2rem;--text-xs:.75rem;--text-sm:.875rem;--text-md:1rem;--text-lg:1.25rem;--font-sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
[data-theme="light"]{color-scheme:light;--bg:#f4f3f8;--panel:#fffbff;--panel-raised:#e8e7ef;--panel-hover:#dddce6;--line:#c9c8d4;--line-soft:#dddce6;--line-control:#6e6e7a;--text:#1c1b22;--muted:#5c5b6a;--blue:#33339a;--blue-strong:#3f3fad;--blue-strong-hover:#33338f;--on-accent:#ffffff;--amber:#8a4b00;--green:#0f6b45;--red:#a32020;--violet:#5b3d99;--card:#fffbff;--border:#c9c8d4;--shadow:0 16px 40px rgb(28 27 34 / 12%)}
body{font-family:var(--font-sans);max-width:44rem;margin:2rem auto;padding:0 1rem;background:var(--bg);color:var(--text)}
a{color:var(--blue)}a:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
header.page{border-bottom:1px solid var(--line);margin-bottom:1rem}article{border-bottom:1px solid var(--line-soft);padding:.6rem 0}
article header{display:flex;gap:.75rem;font-size:.85rem;color:var(--muted)}article p{white-space:pre-wrap;margin:.3rem 0 0}
ul.members{display:flex;flex-wrap:wrap;gap:.4rem;list-style:none;padding:0}ul.members li{border:1px solid var(--line);border-radius:1rem;padding:.15rem .7rem;font-size:.85rem}
footer{margin-top:2rem;font-size:.8rem;color:var(--muted)}</style></head><body>
<header class="page"><h1>${esc(face.room.title || "Project Room")}</h1><p>${esc(face.room.purpose)}</p></header>
<section><h2>Members</h2><ul class="members">${members}</ul></section>
<section><h2>Recent activity</h2>${items || "<p>No public messages yet.</p>"}</section>
<footer>Public read-only face · updates as the room works<p>${LEGAL_FOOTER_LINKS}</p></footer>
</body></html>`;
  }
}
