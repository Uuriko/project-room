// Public read-only face for rooms.
//
// Rooms are private by default. The room owner may explicitly opt a room
// into a public, no-login, read-only face: a sanitized snapshot (title,
// purpose, member handles, recent non-DM messages) served as HTML at
// /p/{code} and JSON at /api/public/rooms/{code} (+ paginated
// /api/public/rooms/{code}/feed).
//
// Sanitization is a strict field-by-field rebuild — never a passthrough:
//   - DMs (messages with toMemberId or toMemberIds) never appear: not counted, not hinted.
//   - Members are handles (displayName) only: no emails, no member ids, no
//     identity links, no permission lists.
//   - Message bodies are shown as written (the owner opted in) but capped
//     in length; deleted bodies (null) are skipped; attachments omitted.
//   - No invite codes, keys, secrets, or share-link codes anywhere.
//
// The module is shaped like ShareLinks/DmConsents: it takes the RoomStore
// (db handle, transactions, room state) and exports its schema for
// store.mjs to apply. Local ServiceError avoids the store.mjs import cycle.

import { randomBytes } from "node:crypto";
import { LEGAL_FOOTER_LINKS } from "./legal-pages.mjs";
import { refreshListedRoom } from "./public-read-model.mjs";

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

const nowMs = () => Date.now();

const newPublicCode = () => PUBLIC_CODE_PREFIX + randomBytes(24).toString("base64url");

const handleOf = (state, memberId) => {
  const member = state?.members?.[memberId];
  if (!member || member.active === false) return null;
  const name = typeof member.displayName === "string" ? member.displayName.trim() : "";
  return name || null;
};

export class PublicFace {
  constructor(store) {
    if (!store || !store.db) fail(500, "face_store_missing", "PublicFace requires a store with a db handle");
    this.store = store;
    this.db = store.db;
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
    return row;
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
      .filter(m => m && m.toMemberId == null && m.toMemberIds == null && typeof m.body === "string" && m.body.length > 0)
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

  faceByCode(code) {
    const row = this._resolveCode(code);
    const state = this._roomState(row.room_id);
    return this.sanitize(state);
  }

  feedByCode(code, { after = null, limit = 50 } = {}) {
    const row = this._resolveCode(code);
    const state = this._roomState(row.room_id);
    if (after !== null && typeof after !== "string") fail(422, "invalid_feed_cursor", "after must be a message cursor");
    let n = Number(limit);
    if (!Number.isSafeInteger(n) || n < 1) n = 50;
    n = Math.min(n, MAX_FEED_LIMIT);
    const messages = (Array.isArray(state?.messages) ? state.messages : [])
      // v1 channel caveat: the core projection has no channel field, so
      // every non-DM message is treated as public. Per-channel public
      // flags are explicitly out of v1 (see DESIGN.md).
      .filter(m => m && m.toMemberId == null && m.toMemberIds == null && typeof m.body === "string" && m.body.length > 0);
    // M-15: an unrecognized cursor fails closed — silently restarting from
    // the first message would make clients re-read from the top (duplicate
    // processing, potential infinite re-poll loop).
    const start = after === null || after === undefined ? 0 : (() => {
      const at = messages.findIndex(m => m.id === after);
      if (at < 0) fail(422, "invalid_feed_cursor", "unknown feed cursor — re-fetch from the start");
      return at + 1;
    })();
    const page = messages.slice(Math.max(0, start), Math.max(0, start) + n);
    return Object.freeze({
      messages: Object.freeze(page.map(m => Object.freeze({
        id: m.id,
        at: m.createdAt ?? null,
        from: handleOf(state, m.authorId) ?? "unknown",
        body: m.body.length > MAX_BODY_CHARS ? m.body.slice(0, MAX_BODY_CHARS) + " …" : m.body
      }))),
      next: page.length ? page[page.length - 1].id : after,
      hasMore: start + n < messages.length,
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
<style>:root{color-scheme:dark;--bg:#202127;--panel:#191a20;--panel-raised:#292b33;--panel-hover:#34363f;--line:#393b45;--line-soft:#30323a;--text:#eeedf1;--muted:#aaaab7;--blue:#a9b9ff;--blue-strong:#5555bd;--blue-strong-hover:#6a6ad4;--on-accent:#ffffff;--amber:#ffbf69;--green:#4fd09b;--red:#ff7b7b;--violet:#ad8cff;--card:#191a20;--border:#393b45;--shadow:0 20px 70px rgb(0 0 0 / 32%);--radius-sm:.35rem;--radius-md:.45rem;--radius-lg:.85rem;--radius-xl:1rem;--space-1:.25rem;--space-2:.5rem;--space-3:.75rem;--space-4:1rem;--space-5:1.5rem;--space-6:2rem;--text-xs:.75rem;--text-sm:.875rem;--text-md:1rem;--text-lg:1.25rem;--font-sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
[data-theme="light"]{color-scheme:light;--bg:#f4f3f8;--panel:#fffbff;--panel-raised:#e8e7ef;--panel-hover:#dddce6;--line:#c9c8d4;--line-soft:#dddce6;--text:#1c1b22;--muted:#5c5b6a;--blue:#33339a;--blue-strong:#3f3fad;--blue-strong-hover:#33338f;--on-accent:#ffffff;--amber:#8a4b00;--green:#0f6b45;--red:#a32020;--violet:#5b3d99;--card:#fffbff;--border:#c9c8d4;--shadow:0 16px 40px rgb(28 27 34 / 12%)}
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
