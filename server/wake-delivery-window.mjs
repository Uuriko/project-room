// Staged bounded reads over the two existing wake journals. No DDL on reads.
import { createHash } from 'node:crypto';
import { ServiceError } from './service-error.mjs';
export const WAKE_INDEX_INSTALL_LIMITS = Object.freeze({ rows: 32768, keyBytes: 4 * 1024 * 1024, storedBytes: 64 * 1024 * 1024 });
export const WAKE_INDEX_POLICY = 'wake-delivery-ordered.v1';
export const WAKE_INDEX_RECEIPT = 'oa_wake_delivery_indexes_v1';
export const WAKE_INDEXES = Object.freeze([
  { table: 'agent_wake_signals', scoped: false, name: 'agent_wake_signals_ordered_pending', sql: 'CREATE INDEX agent_wake_signals_ordered_pending ON agent_wake_signals(agent_id,created_at,signal_id) WHERE delivered_at IS NULL' },
  { table: 'agent_work_wakes', scoped: false, name: 'agent_work_wakes_ordered_pending', sql: 'CREATE INDEX agent_work_wakes_ordered_pending ON agent_work_wakes(agent_id,created_at,signal_id) WHERE delivered_at IS NULL AND invalidated_at IS NULL' },
  { table: 'agent_wake_signals', scoped: true, name: 'agent_wake_signals_ordered_room_pending', sql: 'CREATE INDEX agent_wake_signals_ordered_room_pending ON agent_wake_signals(agent_id,room_id,created_at,signal_id) WHERE delivered_at IS NULL' },
  { table: 'agent_work_wakes', scoped: true, name: 'agent_work_wakes_ordered_room_pending', sql: 'CREATE INDEX agent_work_wakes_ordered_room_pending ON agent_work_wakes(agent_id,room_id,created_at,signal_id) WHERE delivered_at IS NULL AND invalidated_at IS NULL' }
]);
export const WAKE_WINDOW_LIMITS = Object.freeze({ rows: 128, bytes: 128 * 1024, fieldBytes: 8192 });
const unavailable = () => { throw new ServiceError(503, 'storage_unavailable', 'Wake delivery input requires reconciliation; no continuation was advanced', { 'Retry-After': '30' }); };
const catalog = new WeakMap();
const catalogKey = db => db.storage ?? db;
export function forgetWakeIndexState(db) { catalog.delete(catalogKey(db)); }
export function wakeIndexState(db) {
  const cached = catalog.get(catalogKey(db));
  let rows;
  if (cached) {
    rows = cached.map(tuple => db.prepare('SELECT rowid AS catalogId,name,type,tbl_name,CASE WHEN length(CAST(sql AS BLOB))<=? THEN sql ELSE NULL END AS sql FROM sqlite_master WHERE rowid=?')
      .get(tuple.sql.length, tuple.catalogId));
    // Point checks bind the exact existing index tuple. They are an access-
    // plan validity check, never proof of historical DDL continuity.
    if (rows.some((row, n) => JSON.stringify(row) !== JSON.stringify(cached[n]))) { forgetWakeIndexState(db); return 'conflict'; }
  } else {
    rows = db.prepare(`SELECT rowid AS catalogId,name,type,tbl_name,CASE WHEN length(CAST(sql AS BLOB))<=? THEN sql ELSE NULL END AS sql FROM sqlite_master WHERE name IN (${WAKE_INDEXES.map(() => '?').join(',')})`)
      .all(Math.max(...WAKE_INDEXES.map(index => index.sql.length)), ...WAKE_INDEXES.map(index => index.name));
  }
  const states = WAKE_INDEXES.map(index => {
    const row = rows.find(value => value?.name === index.name);
    return !row ? 'absent' : row.type === 'index' && row.tbl_name === index.table && row.sql === index.sql ? 'installed' : 'conflict';
  });
  if (states.every(state => state === 'installed')) {
    if (!cached) catalog.set(catalogKey(db), WAKE_INDEXES.map(index => rows.find(row => row.name === index.name)));
    return 'installed';
  }
  return states.every(state => state === 'absent') ? 'absent' : 'conflict';
}
export function readWakeIndexReceipt(db) {
  let row;
  try { row = db.prepare(`SELECT action,target_kind,target_id,result,plan_hash,request_id,CASE WHEN typeof(reason)='text' AND length(CAST(reason AS BLOB))<=500 THEN reason ELSE NULL END AS reason,
    CASE WHEN typeof(counts_json)='text' AND length(CAST(counts_json AS BLOB))<=8192 THEN counts_json ELSE NULL END AS counts_json
    FROM operator_actions WHERE id=?`).get(WAKE_INDEX_RECEIPT); }
  catch (error) { if (/no such table: (?:main\.)?operator_actions\b/.test(String(error?.message))) return null; throw error; }
  if (!row) return null;
  // A present malformed receipt cannot authorize bounded reads.
  if (row.action !== 'wake_delivery_indexes_execute' || row.target_kind !== 'database'
    || row.target_id !== 'wake_delivery' || row.result !== 'ok' || !/^[a-f0-9]{64}$/.test(row.plan_hash ?? '')
    || typeof row.request_id !== 'string' || !row.request_id || row.counts_json === null) unavailable();
  let saved; try { saved = JSON.parse(row.counts_json); } catch { unavailable(); }
  if (!saved || Object.keys(saved).sort().join(',') !== 'inputHash,receipt' || !/^[a-f0-9]{64}$/.test(saved.inputHash ?? '')
    || saved.receipt?.policy !== WAKE_INDEX_POLICY || saved.receipt?.planHash !== row.plan_hash
    || saved.receipt?.result?.installed !== true || JSON.stringify(saved.receipt?.indexes) !== JSON.stringify(WAKE_INDEXES.map(index => index.sql))) unavailable();
  const receipt = saved.receipt;
  const closed = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...names].sort().join(',');
  if (!closed(receipt, ['ok', 'scope', 'target', 'policy', 'sourceRevision', 'indexes', 'installed', 'admitted', 'limits', 'planHash', 'result'])
    || receipt.ok !== true || receipt.scope !== 'database' || receipt.target !== 'wake_delivery' || receipt.installed !== false
    || typeof receipt.sourceRevision !== 'string' || !/^(?:unstamped|[a-f0-9]{40})$/.test(receipt.sourceRevision)
    || !closed(receipt.result, ['installed']) || !closed(receipt.admitted, Object.keys(WAKE_INDEX_INSTALL_LIMITS))
    || JSON.stringify(receipt.limits) !== JSON.stringify(WAKE_INDEX_INSTALL_LIMITS)
    || Object.entries(WAKE_INDEX_INSTALL_LIMITS).some(([key, max]) => !Number.isSafeInteger(receipt.admitted[key]) || receipt.admitted[key] < 0 || receipt.admitted[key] > max)
    || !/^[A-Za-z0-9:_-]{1,128}$/.test(row.request_id) || row.reason === null
    || createHash('sha256').update(JSON.stringify({ reason: row.reason, requestId: row.request_id, planHash: row.plan_hash })).digest('hex') !== saved.inputHash) unavailable();
  return { row, saved };
}
export function boundedWakeDeliveryActive(db) {
  const original = readWakeIndexReceipt(db);
  // Support deployment alone keeps legacy reads without optional catalog work.
  // Unreceipted indexes are never adopted; the explicit operator plan diagnoses them.
  if (!original) return false;
  if (wakeIndexState(db) === 'installed') return true;
  unavailable();
}
const fields = Object.freeze({
  agent_wake_signals: ['signal_id', 'agent_id', 'kind', 'room_id', 'message_id', 'created_at', 'delivered_at'],
  agent_work_wakes: ['signal_id', 'agent_id', 'room_id', 'member_id', 'work_item_id', 'work_revision', 'event_id', 'actor_id', 'pointer', 'created_at', 'delivered_at', 'invalidated_at']
});
// Source admission precedes wide TEXT / pointer transfer. The ordered partial
// index bounds physical traversal even when every candidate is later filtered.
export function readWakeWindow(db, table, agentId, after = null, roomId = null, order = 'oldest') {
  if (!['oldest', 'newest'].includes(order) || order === 'newest' && roomId === null) unavailable();
  const newest = order === 'newest';
  const index = WAKE_INDEXES.find(value => value.table === table && value.scoped === (roomId !== null)); if (!index) unavailable();
  const columns = fields[table], text = columns.filter(column => !['created_at', 'delivered_at', 'invalidated_at', 'work_revision'].includes(column));
  const nullable = new Set(table === 'agent_wake_signals' ? ['room_id', 'message_id'] : []);
  const bytes = text.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+');
  const fieldLimit = { signal_id: 128, agent_id: 64, kind: 32, room_id: 128, message_id: 1024, member_id: 128, work_item_id: 128, event_id: 128, actor_id: 128, pointer: WAKE_WINDOW_LIMITS.fieldBytes };
  const valid = text.map(column => `(typeof(${column})='text'${nullable.has(column) ? ` OR ${column} IS NULL` : ''}) AND COALESCE(length(CAST(${column} AS BLOB)),0)<=${fieldLimit[column]}`).join(' AND ');
  const predicate = table === 'agent_work_wakes' ? 'delivered_at IS NULL AND invalidated_at IS NULL' : 'delivered_at IS NULL';
  const range = after ? ` AND (created_at,signal_id)${newest ? '<' : '>'}(?,?)` : '';
  const bindings = [agentId, ...(roomId !== null ? [roomId] : []), ...(after ? [after.createdAt, after.signalId] : [])];
  const scalars = db.prepare(`SELECT rowid AS rid,created_at,${bytes}+128 AS sourceBytes,
    CASE WHEN ${valid} AND typeof(created_at)='integer' AND created_at>=0${table === 'agent_work_wakes' ? " AND typeof(work_revision)='integer'" : ''} THEN 1 ELSE 0 END AS valid
    FROM ${table} INDEXED BY ${index.name} WHERE agent_id=?${roomId !== null ? ' AND room_id=?' : ''} AND ${predicate}${range}
    ORDER BY created_at ${newest ? 'DESC' : 'ASC'},signal_id ${newest ? 'DESC' : 'ASC'} LIMIT ?`).all(...bindings, WAKE_WINDOW_LIMITS.rows + 1);
  const admitted = []; let used = 0;
  for (const scalar of scalars.slice(0, WAKE_WINDOW_LIMITS.rows)) {
    if (scalar.valid !== 1 || !Number.isSafeInteger(scalar.rid) || !Number.isSafeInteger(scalar.created_at)
      || !Number.isSafeInteger(scalar.sourceBytes) || scalar.sourceBytes > WAKE_WINDOW_LIMITS.bytes) unavailable();
    if (used + scalar.sourceBytes > WAKE_WINDOW_LIMITS.bytes) break;
    used += scalar.sourceBytes; admitted.push(scalar);
  }
  // A legal row always fits individually; no zero-progress partial window.
  if (scalars.length && !admitted.length) unavailable();
  const get = db.prepare(`SELECT ${columns.map(column => text.includes(column) ? `CAST(${column} AS BLOB) AS ${column}` : column).join(',')} FROM ${table} WHERE rowid=?`);
  const rows = admitted.map(scalar => {
    const row = get.get(scalar.rid);
    try { for (const column of text) if (row?.[column] !== null) row[column] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(row[column]); } catch { unavailable(); }
    if (!row || row.created_at !== scalar.created_at || row.agent_id !== agentId || roomId !== null && row.room_id !== roomId) unavailable();
    return row;
  });
  const last = rows.at(-1);
  return { rows, more: scalars.length > admitted.length, through: last ? { createdAt: last.created_at, signalId: last.signal_id } : after,
    admitted: { rows: rows.length, bytes: used } };
}
export function compareWakePosition(a, b) {
  return a.createdAt - b.createdAt || Buffer.compare(Buffer.from(a.signalId, 'utf8'), Buffer.from(b.signalId, 'utf8'));
}
