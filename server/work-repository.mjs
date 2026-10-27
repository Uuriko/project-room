// Canonical work payloads. References identify exact content, not merely a
// mutable row. The caller owns the transaction containing event + carrier.
import { createHash } from 'node:crypto';

export const WORK_REPOSITORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_entities (
  room_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY(room_id, work_id)
);
CREATE TRIGGER IF NOT EXISTS work_entities_room_gone AFTER DELETE ON rooms
BEGIN DELETE FROM work_entities WHERE room_id=OLD.id; END;
CREATE VIEW IF NOT EXISTS work_projection_items AS
  SELECT rooms.id AS room_id, item.key AS key,
    CASE WHEN json_extract(item.value, '$._workEntity')=1
      THEN (SELECT body FROM work_entities w WHERE w.room_id=rooms.id
        AND w.work_id=item.key AND w.digest=json_extract(item.value, '$.digest'))
      ELSE item.value END AS value
  FROM rooms, json_each(rooms.projection, '$.workItems') AS item;
`;
const modes = new WeakMap();
export function configureWorkRepository(db, enabled) { modes.set(db, enabled === true); }
export const isWorkReference = value => value?._workEntity === 1;
const digestOf = text => createHash('sha256').update(text).digest('hex');
const corrupt = () => { throw new Error('work_projection_corrupt: missing or mismatched work record'); };

export function hydrateWorkItems(db, roomId, state) {
  const entries = Object.entries(state?.workItems ?? {});
  if (!entries.some(([, value]) => isWorkReference(value))) return state;
  const rows = new Map(db.prepare('SELECT work_id,revision,digest,body FROM work_entities WHERE room_id=?').all(roomId).map(row => [row.work_id, row]));
  const items = {};
  for (const [id, value] of entries) {
    if (!isWorkReference(value)) { items[id] = value; continue; }
    const row = rows.get(id);
    if (!row || value.id !== id || row.revision !== value.revision || row.digest !== value.digest || digestOf(row.body) !== value.digest) corrupt();
    const item = JSON.parse(row.body);
    if (item.id !== id || item.revision !== value.revision) corrupt();
    items[id] = item;
  }
  return { ...state, workItems: items };
}

export function referenceWorkItems(db, roomId, input, { enabled = modes.get(db) === true } = {}) {
  const state = hydrateWorkItems(db, roomId, input);
  if (!enabled) {
    if (modes.has(db) || Object.values(input?.workItems ?? {}).some(isWorkReference)) db.prepare('DELETE FROM work_entities WHERE room_id=?').run(roomId);
    return state;
  }
  if (!state?.workItems) return state;
  const existing = new Map(db.prepare('SELECT work_id,digest FROM work_entities WHERE room_id=?').all(roomId).map(row => [row.work_id, row.digest]));
  const write = db.prepare('INSERT INTO work_entities(room_id,work_id,revision,digest,body) VALUES(?,?,?,?,?) ON CONFLICT(room_id,work_id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,body=excluded.body');
  const refs = {};
  for (const [id, item] of Object.entries(state.workItems)) {
    if (item?.id !== id || !Number.isSafeInteger(item.revision) || item.revision < 0) corrupt();
    const body = JSON.stringify(item), digest = digestOf(body);
    if (existing.get(id) !== digest) write.run(roomId, id, item.revision, digest, body);
    existing.delete(id);
    refs[id] = { _workEntity: 1, id, revision: item.revision, digest };
  }
  const remove = db.prepare('DELETE FROM work_entities WHERE room_id=? AND work_id=?');
  for (const id of existing.keys()) remove.run(roomId, id);
  return { ...state, workItems: refs };
}

export function readWorkItem(db, roomId, workId) {
  const row = db.prepare("SELECT item.value FROM rooms,json_each(rooms.projection,'$.workItems') AS item WHERE rooms.id=? AND item.key=?").get(roomId, workId);
  if (!row) return null;
  const item = JSON.parse(row.value);
  return hydrateWorkItems(db, roomId, { workItems: { [workId]: item } }).workItems[workId];
}
