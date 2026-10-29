// Internal at-rest references, never a wire format or authorization API.
// Qualified commands may reference unchanged certified entities and their own
// pending writes. Legacy records without reducer history remain inline.
export const MESSAGE_ENTITY_REF = '_entity';
export const isMessageEntityRef = value => value?._entity === 1;

// Arming wiring for the entity projection (default OFF). The production
// constructors (cloudflare/room.mjs, cloudflare/room-shard.mjs, server.mjs)
// spread this into their RoomStore options. With ROOM_MESSAGE_ENTITY_PROJECTION
// unset the result is {} and behaviour is byte-identical to the dormant
// defaults. Arming a deployment does not arm any room's writes by itself:
// prepareMessageWrite emits entity refs only while the room holds a current
// parity certification (server/message-command-service.mjs), so the per-room
// backfill + certification runbook must complete before a room's writes can
// go entity-ref, and a revoked certification falls back to inline writes.
export const MESSAGE_ENTITY_PROJECTION_ENV = 'ROOM_MESSAGE_ENTITY_PROJECTION';
export const MESSAGE_PROJECTION_WINDOW_ENV = 'ROOM_MESSAGE_PROJECTION_WINDOW';
// Default resident window when armed: the operator archive door's keep-newest
// default (ARCHIVE_DEFAULT_KEEP, server/operator-archive.mjs).
export const DEFAULT_MESSAGE_PROJECTION_WINDOW = 2000;

export function messageProjectionArmingFromEnv(env = {}) {
  const rawWindow = env[MESSAGE_PROJECTION_WINDOW_ENV];
  if (env[MESSAGE_ENTITY_PROJECTION_ENV] !== '1') {
    if (rawWindow !== undefined && rawWindow !== '') {
      throw new Error(`${MESSAGE_PROJECTION_WINDOW_ENV} requires ${MESSAGE_ENTITY_PROJECTION_ENV}=1`);
    }
    return {};
  }
  const window = rawWindow === undefined || rawWindow === ''
    ? DEFAULT_MESSAGE_PROJECTION_WINDOW : Number(rawWindow);
  if (!Number.isSafeInteger(window) || window < 1) {
    throw new Error(`${MESSAGE_PROJECTION_WINDOW_ENV} must be a positive integer`);
  }
  return { messageProjectionWindow: window, messageEntityProjection: true };
}
const BATCH_SIZE = 256;

export function referenceMessageEntities(db, roomId, messages, pendingIds = []) {
  const ready = new Set(pendingIds);
  const ids = messages.map(message => message.id);
  for (let start = 0; start < ids.length; start += BATCH_SIZE) {
    const rows = db.prepare(`SELECT message_id FROM messages WHERE room_id=?
      AND message_id IN (SELECT value FROM json_each(?))
      AND record_json IS NOT NULL AND reducer_extras_json IS NOT NULL`)
      .all(roomId, JSON.stringify(ids.slice(start, start + BATCH_SIZE)));
    for (const row of rows) ready.add(row.message_id);
  }
  return messages.map(message => ready.has(message.id)
    ? { id: message.id, [MESSAGE_ENTITY_REF]: 1 } : message);
}

function decodeEntity(row) {
  let record, extras;
  try {
    record = JSON.parse(row.record_json);
    extras = JSON.parse(row.reducer_extras_json);
  } catch {
    throw new Error('projection_corrupt: invalid message entity');
  }
  if (!record || record.id !== row.message_id || record.body !== row.body
    || !extras || typeof extras !== 'object' || Array.isArray(extras)
    || Object.keys(extras).some(key => key !== 'editHistory')
    || (Object.hasOwn(extras, 'editHistory') && !Array.isArray(extras.editHistory))) {
    throw new Error('projection_corrupt: invalid message entity');
  }
  return { ...record, ...extras };
}

export function hydrateMessageEntities(db, roomId, messages) {
  const ids = messages.filter(isMessageEntityRef).map(message => message.id);
  if (!ids.length) return messages;
  const records = new Map();
  for (let start = 0; start < ids.length; start += BATCH_SIZE) {
    const rows = db.prepare(`SELECT message_id,body,record_json,reducer_extras_json FROM messages
      WHERE room_id=? AND message_id IN (SELECT value FROM json_each(?))`)
      .all(roomId, JSON.stringify(ids.slice(start, start + BATCH_SIZE)));
    for (const row of rows) records.set(row.message_id, decodeEntity(row));
  }
  return messages.map(message => {
    if (!isMessageEntityRef(message)) return message;
    if (typeof message.id !== 'string' || !records.has(message.id)
      || Object.keys(message).some(key => key !== 'id' && key !== MESSAGE_ENTITY_REF)) {
      throw new Error('projection_corrupt: missing message entity');
    }
    return records.get(message.id);
  });
}
