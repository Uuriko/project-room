// Conditional GET support for the room snapshot read (RR-D5).
//
// The crux: can a validator for GET /api/rooms/{roomId} be checked WITHOUT
// loading the whole projection? At the store shape this module was built
// against, `rooms.sequence` alone is NOT a sound validator: several writers
// replace the projection without bumping the sequence (message archive /
// restore in server/messages-store.mjs, the legacy message-shape upgrade,
// operator projection repair, projection rehydration in server/store.mjs),
// and history import can replace the whole log at the same head sequence.
// Any rooms-row UPDATE, however, is a complete witness: every one of those
// paths writes the rooms row. So this module maintains a per-room read
// version with an AFTER UPDATE trigger on rooms — one indexed upsert per
// rooms write, next to the projection write the caller already pays for —
// and the validator head is then a handful of primary-key reads:
//
//   rooms(sequence, archived_at)          — PK read, no projection column
//   room_read_versions(version)           — PK read (the trigger counter)
//   cursors(sequence) for the viewer      — PK read; snapshot serves it and
//                                           catchUpCursor derives from it
//   messages_backfill_cursor(applied_seq, parity_at_seq)
//                                         — PK read; the windowed read's
//                                           repository answers move with it
//   revoked-identity signature            — the withIdentityRevoked overlay
//                                           reads agent_identities.revoked_at
//                                           through identity_links, a side
//                                           table no room event advances
//   viewer's bond identity                — identity_links PK read; bond and
//                                           peer-DM visibility derive from it
//
// Everything else in the snapshot payload is a pure function of the stored
// projection and event log at `sequence` (dm-consent changes, redactions and
// consent receipts all append sequenced events or update the rooms row), so
// (readVersion, sequence) plus the viewer/variant tuple below is exact: the
// ETag changes if and only if the served bytes can change. The one variant
// that is never cacheable is the work view with help context — its payload
// carries `evaluatedAt`, a wall-clock stamp — so snapshotValidator returns
// null there and the route stays an explicit no-op for it.
//
// Registered in server/writer-fence.mjs unfencedAdditiveTables: purely
// additive, intentionally outside the writer fence — older writers have no
// code path to the table, and the trigger keeps it exact under every writer,
// including writers that predate this module.
import { createHash } from "node:crypto";
import { ServiceError } from "./service-error.mjs";

export const ROOM_READ_VERSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS room_read_versions (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id),
  version INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS room_read_version_bump AFTER UPDATE ON rooms
BEGIN
  INSERT INTO room_read_versions(room_id, version) VALUES(NEW.id, 1)
  ON CONFLICT(room_id) DO UPDATE SET version = version + 1;
END;
`;

// The snapshot is per-viewer and per-variant, so shared caches must never
// serve it across credentials; private + no-cache keeps the stored copy
// while forcing the revalidation this module exists to make cheap.
export const SNAPSHOT_CACHE_CONTROL = "private, no-cache";

const ensuredDbs = new WeakSet();

// Idempotent (CREATE ... IF NOT EXISTS), following the additive-schema
// pattern of ensureIdentityLinkCodeSchema / ensureOperatorActionsSchema.
// Ensured lazily on the validator path so store-only fixtures and the
// Durable Object store both converge without a schema-version bump.
export function ensureRoomReadVersionSchema(db) {
  if (!db || typeof db.exec !== "function" || ensuredDbs.has(db)) return;
  db.exec(ROOM_READ_VERSION_SCHEMA);
  ensuredDbs.add(db);
}

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

// The cheap validator head: primary-key reads only. No statement selects
// the rooms.projection column, so the projection text is never loaded,
// parsed, or hydrated to answer "did it change?".
export function readSnapshotHead(db, roomId, memberId) {
  ensureRoomReadVersionSchema(db);
  const room = db.prepare("SELECT sequence, archived_at AS archivedAt FROM rooms WHERE id=?").get(roomId);
  if (!room) return null;
  const readVersion = db.prepare("SELECT version FROM room_read_versions WHERE room_id=?").get(roomId)?.version ?? 0;
  const cursor = db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get(roomId, memberId)?.sequence ?? 0;
  let backfillApplied = 0, backfillParity = 0;
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages_backfill_cursor'").get()) {
    const backfill = db.prepare("SELECT applied_seq AS applied, parity_at_seq AS parity FROM messages_backfill_cursor WHERE room_id=?").get(roomId);
    backfillApplied = backfill?.applied ?? 0;
    backfillParity = backfill?.parity ?? 0;
  }
  const revoked = db.prepare(`SELECT l.member_id AS memberId FROM identity_links l
    JOIN agent_identities i ON i.identity_id=l.identity_id
    WHERE l.room_id=? AND i.revoked_at IS NOT NULL ORDER BY l.member_id`).all(roomId)
    .map(row => row.memberId).join(",");
  return { sequence: room.sequence, archivedAt: room.archivedAt ?? null, readVersion, cursor, backfillApplied, backfillParity, revoked };
}

// Strong ETag for one snapshot variant, in the quoted 32-hex shape the edge
// layer already uses for static assets (cloudflare/edge-public.mjs).
export function snapshotEtag(parts) {
  return `"${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}"`;
}

// RFC 7232 weak comparison for If-None-Match: a stored copy matches when
// any listed tag weakly equals the current one; "*" matches any current
// representation. The payloads compared here are byte-stable per ETag, so
// weak comparison cannot serve different bytes under one tag.
export function ifNoneMatchMatches(header, etag) {
  if (typeof header !== "string" || typeof etag !== "string" || !etag) return false;
  for (const raw of header.split(",")) {
    const value = raw.trim();
    if (value === "*") return true;
    if ((value.startsWith("W/") ? value.slice(2) : value) === etag) return true;
  }
  return false;
}

// The validator for one snapshot request, or null when the variant is not
// cacheable (help context stamps evaluatedAt = now into the payload).
// Auth runs first, inside the same read transaction, with the same errors
// in the same order store.snapshot() would raise: a 304 never answers a
// caller the 200 path would have refused.
export function snapshotValidator(store, token, roomId, expectedSessionBinding = null, variant = {}) {
  if (variant.helpContext) return null;
  return store.readTransaction(() => {
    const auth = store.authenticate(token, roomId, expectedSessionBinding);
    const head = readSnapshotHead(store.db, roomId, auth.member.id);
    if (!head) fail(404, "room_not_found", "Room not found");
    const etag = snapshotEtag({
      v: 1, roomId, ...head,
      bondIdentity: store.bonds.identityForMember(roomId, auth.member.id),
      viewer: {
        memberId: auth.member.id,
        accountId: auth.account?.id ?? null,
        authEpoch: auth.account?.authEpoch ?? null,
        sessionBinding: auth.sessionBinding ?? null,
        sessionRevision: auth.sessionRevision ?? null
      },
      variant: {
        view: variant.view ?? "full",
        windowed: variant.windowed === true,
        auditView: variant.auditView ?? "full",
        offerContext: variant.offerContext === true
      }
    });
    return { etag, sequence: head.sequence, readVersion: head.readVersion };
  });
}
