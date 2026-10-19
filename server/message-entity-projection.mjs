// Internal at-rest references, never a wire format or authorization API.
// Qualified commands may reference unchanged certified entities and their own
// pending writes. Legacy records without reducer history remain inline.
export const MESSAGE_ENTITY_REF = '_entity';
export const isMessageEntityRef = value => value?._entity === 1;
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
