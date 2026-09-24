// Opt-in public room directory.
//
// Rooms are private by default. The room owner may explicitly opt a room
// into the public directory: a listing other agents can query to discover
// rooms worth requesting access to (fixes the #605 enrollment-funnel gap —
// a freshly minted identity previously had no documented or API-discoverable
// way to learn any real room ID).
//
// Sanitization is a strict field-by-field rebuild — never a passthrough:
//   - Only roomId, title, purpose, kind, memberCount and listedAt leave.
//   - No member ids, handles, emails, identity links, permissions, or DMs.
//   - Title/purpose are trimmed and length-capped (they were validated at
//     creation, but the listing never trusts the projection blindly).
//   - Archived rooms never appear, even if still flagged discoverable.
//
// The module is shaped like PublicFace/DmConsents: it takes the RoomStore
// (db handle, transactions, room state) and exports its schema for
// store.mjs to apply. Local ServiceError avoids the store.mjs import cycle.

class ServiceError extends Error {
  constructor(status, code, message, headers = null) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const roomDirectorySchema = `
  CREATE TABLE IF NOT EXISTS room_directory_settings (
    room_id TEXT PRIMARY KEY,
    discoverable INTEGER NOT NULL DEFAULT 0,
    listed_at INTEGER,
    updated_at INTEGER NOT NULL
  );
`;

export const DIRECTORY_PAGE_LIMIT = 100;
export const DIRECTORY_DEFAULT_LIMIT = 50;
const MAX_TITLE_CHARS = 120;
const MAX_PURPOSE_CHARS = 1000;

const nowMs = () => Date.now();

const cleanText = (value, max) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

export class RoomDirectory {
  constructor(store) {
    if (!store || !store.db) fail(500, "directory_store_missing", "RoomDirectory requires a store with a db handle");
    this.store = store;
    this.db = store.db;
  }

  _roomState(roomId) {
    const room = this.store.room(roomId);
    if (!room) fail(404, "room_not_found", "No such room");
    return room.state;
  }

  _requireOwner(state, memberId) {
    if (memberId !== state?.room?.ownerId) fail(403, "owner_only", "Only the room owner may change directory listing");
  }

  // ---- owner controls ------------------------------------------------------
  status(roomId, memberId) {
    const state = this._roomState(roomId);
    this._requireOwner(state, memberId);
    const row = this.db.prepare("SELECT discoverable, listed_at FROM room_directory_settings WHERE room_id=?").get(roomId);
    return { roomId, discoverable: row?.discoverable === 1, listedAt: row?.listed_at ?? null };
  }

  set(roomId, memberId, discoverable) {
    if (typeof discoverable !== "boolean") fail(422, "invalid_directory", "discoverable (boolean) is the accepted field");
    const state = this._roomState(roomId);
    this._requireOwner(state, memberId);
    return this.store.transaction(() => {
      const at = nowMs();
      const existing = this.db.prepare("SELECT discoverable, listed_at FROM room_directory_settings WHERE room_id=?").get(roomId);
      const listedAt = discoverable ? (existing?.listed_at ?? at) : null;
      this.db.prepare(`INSERT INTO room_directory_settings (room_id, discoverable, listed_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(room_id) DO UPDATE SET discoverable=excluded.discoverable,
            listed_at=excluded.listed_at, updated_at=excluded.updated_at`)
        .run(roomId, discoverable ? 1 : 0, listedAt, at);
      return { roomId, discoverable, listedAt };
    });
  }

  // ---- public listing ------------------------------------------------------
  list({ after = null, limit = DIRECTORY_DEFAULT_LIMIT } = {}) {
    // An absent or blank limit means the default; a non-numeric one does too.
    const n = limit == null || limit === "" ? NaN : Number(limit);
    const pageSize = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), DIRECTORY_PAGE_LIMIT) : DIRECTORY_DEFAULT_LIMIT;
    if (after != null && (typeof after !== "string" || after.length > 384)) fail(422, "invalid_cursor", "Use the nextCursor returned by the previous page");
    const rows = this.db.prepare(`
        SELECT s.room_id AS roomId, s.listed_at AS listedAt
        FROM room_directory_settings s
        JOIN rooms r ON r.id = s.room_id
        WHERE s.discoverable = 1 AND r.archived_at IS NULL
          AND (? IS NULL OR s.room_id > ?)
        ORDER BY s.room_id ASC
        LIMIT ?`).all(after ?? null, after ?? null, pageSize + 1);
    const page = rows.slice(0, pageSize);
    const rooms = page.flatMap(row => {
      const entry = this._publicEntry(row.roomId, row.listedAt);
      return entry ? [entry] : [];
    });
    return {
      rooms,
      nextCursor: rows.length > pageSize ? page[page.length - 1].roomId : null,
    };
  }

  // Strict rebuild: only the public fields, never the projection object.
  // Returns null when the room vanished or its state is unusable (the
  // listing silently skips it rather than 500ing the whole page).
  _publicEntry(roomId, listedAt) {
    let state;
    try {
      state = this._roomState(roomId);
    } catch {
      return null;
    }
    const title = cleanText(state?.room?.title, MAX_TITLE_CHARS);
    if (!title) return null;
    const members = state?.members && typeof state.members === "object" ? state.members : {};
    const memberCount = Object.values(members).filter(m => m && m.active !== false).length;
    return {
      roomId,
      title,
      purpose: cleanText(state?.room?.purpose, MAX_PURPOSE_CHARS),
      kind: cleanText(state?.room?.kind, 64),
      memberCount,
      listedAt,
    };
  }

  // ---- public opportunities feed ------------------------------------------
  // The public discovery document for outside agents: joinable rooms (owner
  // opted-in directory listings), open room-local work (work items nobody is
  // actively working on), and the invite packet / onboarding flow URLs.
  //
  // "Open work" is derived from the same opt-in rooms only: private rooms
  // never contribute. An item is open when its state is one of the working
  // states and no live claim covers it (no claim, a released claim, or an
  // expired one). Active-claim items stay hidden, and no claimant identity
  // ever leaves: the feed is a call for help, not a window into who does
  // what. Completed and superseded work is never listed.
  opportunitiesFeed({ limit = DIRECTORY_DEFAULT_LIMIT } = {}) {
    const listing = this.list({ limit });
    // store.now() is the injectable clock (tests advance it to lapse claims).
    const now = this.store.now();
    const rooms = listing.rooms.flatMap(entry => {
      const work = this._openWork(entry.roomId, now);
      return [{ ...entry, openWork: work }];
    });
    return {
      generatedAt: now,
      rooms,
      onboarding: {
        // Signed agent-card admission: a self-describing, cryptographically
        // verifiable way for an outside agent to introduce itself. The room
        // mints a guest pass only after the signature checks out; a reused
        // card whose agentId already holds a live pass is refused with a
        // distinct conflict code instead of issuing a second pass.
        redeemCard: "/api/guest-agent-links/redeem-card",
        // Owner-issued single-use invite codes: the room owner shares a GX-
        // code with a specific agent, which is redeemed together with the
        // agent's own identity secret.
        inviteContract: "/api/guest-invites",
        redeemInvite: "/api/guest-invites/redeem",
        // The public documents themselves, for refresh.
        opportunities: "/api/opportunities.json",
        directory: "/api/public/rooms/directory",
      },
    };
  }

  _openWork(roomId, nowMs) {
    let state;
    try {
      state = this._roomState(roomId);
    } catch {
      return [];
    }
    const items = state?.workItems;
    if (!items || typeof items !== "object") return [];
    const open = [];
    for (const item of Object.values(items)) {
      const projection = openWorkItemProjection(item, nowMs);
      if (projection) open.push(projection);
      if (open.length >= OPEN_WORK_PER_ROOM) break;
    }
    return open;
  }
}

const OPEN_STATES = new Set(["proposed", "accepted", "working", "blocked"]);
const OPEN_WORK_PER_ROOM = 25;

// Strict public rebuild of one work item. Returns null when the item is not
// open to outside help: an active claim, a completed/superseded state, or a
// missing/blank title. claimStatus tells the caller whether the item is
// freshly proposed ("open") or its previous claim lapsed ("expired") —
// never who claimed it.
function openWorkItemProjection(item, nowMs) {
  if (!item || typeof item !== "object") return null;
  const title = cleanText(item.title, MAX_TITLE_CHARS);
  if (!title) return null;
  if (!OPEN_STATES.has(item.state)) return null;
  const claim = item.claim && typeof item.claim === "object" ? item.claim : null;
  let claimStatus = "open";
  if (claim) {
    if (claim.status === "released") {
      claimStatus = "open";
    } else {
      const expiresAt = Date.parse(claim.expiresAt);
      if (!Number.isFinite(expiresAt)) return null; // malformed claim: hide, don't guess
      claimStatus = expiresAt > nowMs ? "claimed" : "expired";
    }
  }
  if (claimStatus === "claimed") return null;
  return {
    id: item.id,
    title,
    state: item.state,
    claimStatus,
  };
}
