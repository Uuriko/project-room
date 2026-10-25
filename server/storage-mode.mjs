// Per-room storage switch. `blob` keeps the whole projection. `slim` keeps a
// hot window and the counters, and the messages and work tables hold the
// records. A room flips only after its bodies verify and every projected
// message matches the messages table. Nothing flips on its own.
import { messagesBackfillCaughtUp } from "./messages-store.mjs";
import { storedProjection } from "./projection-at-rest.mjs";

export const STORAGE_MODE_COLUMN = "ALTER TABLE rooms ADD COLUMN storage_mode TEXT NOT NULL DEFAULT 'blob'";
export const SLIM_MESSAGE_WINDOW = 50;
const TERMINAL_WORK = new Set(["done", "closed", "cancelled", "canceled", "superseded", "rejected", "dropped"]);

export function ensureStorageModeColumn(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(rooms)").all().map(column => column.name));
  if (!columns.has("storage_mode")) db.exec(STORAGE_MODE_COLUMN);
}

export function readStorageMode(db, roomId) {
  const row = db.prepare("SELECT storage_mode FROM rooms WHERE id=?").get(roomId);
  return row?.storage_mode === "slim" ? "slim" : "blob";
}

function storedBody(message) {
  if (!message || message.deletedAt || message.body == null) return null;
  return typeof message.body === "string" ? message.body : null;
}

// The messages table and the projection have to describe the same text
// before any of it leaves the room row.
function dualReadMismatch(db, roomId, messages) {
  const read = db.prepare("SELECT body FROM messages WHERE room_id=? AND message_id=?");
  for (const message of messages) {
    const row = read.get(roomId, message?.id);
    if (!row || row.body !== storedBody(message)) return message?.id ?? "";
  }
  return null;
}

function openWorkCount(state) {
  return Object.values(state.workItems ?? {}).filter(item => item && typeof item === "object" && !TERMINAL_WORK.has(item.state)).length;
}

export function writeSlimCounters(store, roomId) {
  const state = store.room(roomId).state;
  const counts = store.db.prepare("SELECT COUNT(*) AS messageCount, COALESCE(MAX(seq), 0) AS lastSeq FROM messages WHERE room_id=?").get(roomId);
  const next = {
    ...state,
    messageCount: counts.messageCount,
    lastSeq: counts.lastSeq,
    openWorkCount: openWorkCount(state)
  };
  // Ids only. room() hydrates the text from the messages table.
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(
    storedProjection(store.db, roomId, next, { enabled: false, messageEntities: true }), roomId);
  store._projectionCache?.clear?.();
}

// Keep a slim room's stored projection on the hot window. A failed archive
// leaves the command's own write in place; the next command tries again.
export function maintainSlimProjection(store, roomId) {
  if (readStorageMode(store.db, roomId) !== "slim") return;
  const length = store.room(roomId).state.messages?.length ?? 0;
  if (length > SLIM_MESSAGE_WINDOW) {
    const archived = store.archiveMessages(roomId, { keepNewest: SLIM_MESSAGE_WINDOW, dryRun: false });
    if (!archived.ok) return;
  }
  writeSlimCounters(store, roomId);
}

// Refuse, and change nothing, unless body verification, the messages
// backfill, parity, and the dual-read all pass.
export function flipRoomToSlim(store, roomId) {
  return store.transaction(() => {
    if (readStorageMode(store.db, roomId) !== "blob") return { ok: false, reason: "already_slim" };
    store.room(roomId, { verifyBodyHashes: true });
    if (!messagesBackfillCaughtUp(store.db, roomId)) return { ok: false, reason: "messages_backfill" };
    const mismatch = dualReadMismatch(store.db, roomId, store.room(roomId).state.messages ?? []);
    if (mismatch !== null) return { ok: false, reason: "dual_read", messageId: mismatch };
    const parity = store.checkMessagesParity({ roomId });
    if (!parity?.ok) return { ok: false, reason: parity?.reason ?? "messages_parity" };
    const before = Buffer.byteLength(store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId).projection);
    const archived = store.archiveMessages(roomId, { keepNewest: SLIM_MESSAGE_WINDOW, dryRun: false });
    if (!archived.ok) return { ok: false, reason: archived.reason ?? "archive_refused", messageId: archived.messageId };
    writeSlimCounters(store, roomId);
    store.db.prepare("UPDATE rooms SET storage_mode='slim' WHERE id=?").run(roomId);
    const projectionBytes = Buffer.byteLength(store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId).projection);
    return { ok: true, archived: archived.archived ?? 0, before, projectionBytes };
  });
}
