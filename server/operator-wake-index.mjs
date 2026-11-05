// One explicit, bounded-admission installation for existing wake-source indexes.
import { createHash } from 'node:crypto';
import { appendOperatorAction } from './operator-actions.mjs';
import { ServiceError } from './service-error.mjs';
import { agentHeartbeatSchema } from './agent-heartbeats.mjs';
import { workWakeSchema } from './work-wakes.mjs';
import { SOURCE_REVISION } from './version.mjs';
import { WAKE_INDEXES, WAKE_INDEX_INSTALL_LIMITS, WAKE_INDEX_POLICY, WAKE_INDEX_RECEIPT, wakeIndexState, forgetWakeIndexState, boundedWakeDeliveryActive, readWakeIndexReceipt } from './wake-delivery-window.mjs';
export const WAKE_INDEX_LIMITS = WAKE_INDEX_INSTALL_LIMITS;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw new ServiceError(409, code, message); };
function parse(input, execute) {
  const fields = execute ? ['reason', 'requestId', 'planHash', 'reinstall'] : ['reason', 'reinstall'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))
    || input.reinstall !== undefined && typeof input.reinstall !== 'boolean'
    || typeof input.reason !== 'string' || !input.reason.trim() || Buffer.byteLength(input.reason) > 500
    || execute && (typeof input.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(input.requestId) || !/^[a-f0-9]{64}$/.test(input.planHash ?? '')))
    throw new ServiceError(422, 'invalid_request', 'Use a reason and, for execute, the exact planHash and stable requestId');
  return { reason: input.reason.trim(), ...(execute ? { requestId: input.requestId, planHash: input.planHash } : {}), ...(input.reinstall === true ? { reinstall: true } : {}) };
}
function inspect(store, repair = null) {
  const state = wakeIndexState(store.db); if (state === 'conflict') fail('wake_index_conflict', 'Partial or conflicting wake indexes require reconciliation');
  const admitted = { rows: 0, keyBytes: 0, storedBytes: 0 };
  const hash = createHash('sha256').update(JSON.stringify({ policy: WAKE_INDEX_POLICY, source: SOURCE_REVISION, state, indexes: WAKE_INDEXES, limits: WAKE_INDEX_LIMITS, ...(repair ? { reinstall: true, originalReceiptHash: repair } : {}) }));
  for (const index of WAKE_INDEXES.filter(value => !value.scoped)) {
    const schema = index.table === 'agent_wake_signals' ? agentHeartbeatSchema : workWakeSchema;
    const expected = schema.trim().split(/;\s*(?=CREATE|$)/).find(sql => sql.startsWith('CREATE TABLE IF NOT EXISTS ' + index.table + ' '));
    const normalize = sql => sql?.replace(/IF NOT EXISTS /g, '').replace(/\s+/g, ' ').trim();
    const definition = store.db.prepare("SELECT CASE WHEN length(CAST(sql AS BLOB))<=? THEN sql ELSE NULL END AS sql FROM sqlite_master WHERE type='table' AND name=?").get(Buffer.byteLength(expected) + 64, index.table);
    if (!expected || normalize(definition?.sql) !== normalize(expected)) fail('wake_index_conflict', 'Wake source table definition requires reconciliation');
    // PK ordering is already indexed. Scalar admission, across ALL states,
    // runs before key text or CREATE INDEX; engine installation remains linear.
    const text = index.table === 'agent_wake_signals' ? ['signal_id', 'agent_id', 'kind', 'room_id', 'message_id']
      : ['signal_id', 'agent_id', 'room_id', 'member_id', 'work_item_id', 'event_id', 'actor_id', 'pointer'];
    const nullable = new Set(index.table === 'agent_wake_signals' ? ['room_id', 'message_id'] : []);
    const sum = columns => columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+');
    const valid = text.map(column => `(typeof(${column})='text'${nullable.has(column) ? ` OR ${column} IS NULL` : ''})`).join(' AND ');
    const rows = store.db.prepare(`SELECT ${sum(['agent_id', 'signal_id', 'agent_id', 'room_id', 'signal_id'])}+128 AS keyBytes,${sum(text)}+128 AS storedBytes,
      CASE WHEN ${valid} AND typeof(created_at)='integer' AND created_at>=0 AND created_at<=9007199254740991 AND typeof(delivered_at) IN ('null','integer')${index.table === 'agent_work_wakes' ? " AND typeof(invalidated_at) IN ('null','integer') AND typeof(work_revision)='integer'" : ''} THEN 1 ELSE 0 END AS valid
      FROM ${index.table} INDEXED BY sqlite_autoindex_${index.table}_1 ORDER BY signal_id LIMIT ?`).all(WAKE_INDEX_LIMITS.rows + 1);
    for (const row of rows) {
      if (row.valid !== 1 || !Number.isSafeInteger(row.keyBytes) || !Number.isSafeInteger(row.storedBytes)) fail('wake_index_budget_exceeded', 'Wake index scalar types require reconciliation');
      admitted.rows++; admitted.keyBytes += row.keyBytes; admitted.storedBytes += row.storedBytes;
    }
    if (admitted.rows > WAKE_INDEX_LIMITS.rows || admitted.keyBytes > WAKE_INDEX_LIMITS.keyBytes || admitted.storedBytes > WAKE_INDEX_LIMITS.storedBytes)
      fail('wake_index_budget_exceeded', 'Wake index installation exceeds fixed admission; nothing was built');
    const keys = store.db.prepare(`SELECT hex(CAST(agent_id AS BLOB)) AS agentKey,hex(CAST(signal_id AS BLOB)) AS signalKey,CASE WHEN room_id IS NULL THEN NULL ELSE hex(CAST(room_id AS BLOB)) END AS roomKey,created_at,delivered_at${index.table === 'agent_work_wakes' ? ',invalidated_at' : ''} FROM ${index.table} INDEXED BY sqlite_autoindex_${index.table}_1 ORDER BY signal_id LIMIT ?`).all(WAKE_INDEX_LIMITS.rows + 1);
    if (keys.length !== rows.length) fail('plan_changed', 'Wake index dependencies changed');
    keys.forEach((key, at) => hash.update(JSON.stringify([index.table, key, rows[at]])));
  }
  return { ok: true, scope: 'database', target: 'wake_delivery', policy: WAKE_INDEX_POLICY, sourceRevision: SOURCE_REVISION,
    indexes: WAKE_INDEXES.map(index => index.sql), ...(repair ? { reinstall: true, originalReceiptHash: repair } : {}), installed: state === 'installed', admitted, limits: WAKE_INDEX_LIMITS, planHash: hash.digest('hex') };
}
export function operatorWakeIndex(store, input, execute = false, requestId = null) {
  if (store.readOnly) fail('read_only', 'This store is read-only');
  const request = parse(input, execute), inputHash = digest(JSON.stringify(request));
  try { return store.transaction(() => {
    const original = readWakeIndexReceipt(store.db);
    const repairId = request.reinstall ? 'oa_wake_delivery_indexes_repair_' + digest(request.requestId ?? '') : null;
    if (execute && request.reinstall) {
      const prior = store.db.prepare('SELECT action,target_kind,target_id,result,request_id,plan_hash,CASE WHEN length(CAST(counts_json AS BLOB))<=8192 THEN counts_json ELSE NULL END AS counts_json FROM operator_actions WHERE id=?').get(repairId);
      if (prior) {
        if (!original) fail('wake_index_conflict', 'Reinstall retry requires the verified original receipt');
        boundedWakeDeliveryActive(store.db);
        let saved; try { saved = JSON.parse(prior.counts_json); } catch { throw new ServiceError(503, 'storage_unavailable', 'Wake reinstall receipt requires reconciliation'); }
        if (prior.action !== 'wake_delivery_indexes_reinstall' || prior.target_kind !== 'database' || prior.target_id !== 'wake_delivery' || prior.result !== 'ok'
          || !saved || Object.keys(saved).sort().join(',') !== 'inputHash,receipt' || saved.receipt?.reinstall !== true || saved.receipt?.result?.installed !== true
          || saved.receipt?.planHash !== prior.plan_hash || prior.plan_hash !== request.planHash || saved.receipt?.originalReceiptHash !== digest(original.row.counts_json))
          throw new ServiceError(503, 'storage_unavailable', 'Wake reinstall receipt requires reconciliation');
        if (prior.request_id !== request.requestId || saved.inputHash !== inputHash) fail('idempotency_conflict', 'Reinstall request records different input');
        return { ...saved.receipt, duplicate: true };
      }
    }
    if (execute && !request.reinstall && original) {
      boundedWakeDeliveryActive(store.db);
      if (original.row.request_id !== request.requestId || original.saved.inputHash !== inputHash) fail('idempotency_conflict', 'Wake indexes already record different installation input');
      return { ...original.saved.receipt, duplicate: true };
    }
    if (request.reinstall && (!original || wakeIndexState(store.db) !== 'absent'))
      fail('wake_index_conflict', 'Explicit reinstall requires all four indexes absent and the verified original receipt');
    if (execute && request.reinstall && request.requestId === original.row.request_id) fail('idempotency_conflict', 'Use a distinct requestId for explicit reinstallation');
    const repair = request.reinstall ? digest(original.row.counts_json) : null;
    const plan = inspect(store, repair);
    if (!execute) {
      appendOperatorAction(store, { action: request.reinstall ? 'wake_delivery_indexes_reinstall_plan' : 'wake_delivery_indexes_plan', targetKind: 'database', targetId: 'wake_delivery', reason: request.reason, planHash: plan.planHash, counts: plan.admitted, result: 'ok', requestId });
      return plan;
    }
    if (plan.installed) fail('wake_index_conflict', 'An index pair without its original success receipt is not adopted');
    if (plan.planHash !== request.planHash) fail('plan_changed', 'Wake index dependencies changed; inspect a fresh plan');
    for (const index of WAKE_INDEXES) store.db.exec(index.sql);
    forgetWakeIndexState(store.db);
    if (wakeIndexState(store.db) !== 'installed') fail('wake_index_conflict', 'Wake index verification failed');
    const receipt = { ...plan, result: { installed: true } };
    store.db.prepare('INSERT INTO operator_actions(id,at,action,target_kind,target_id,reason,plan_hash,counts_json,result,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(repairId ?? WAKE_INDEX_RECEIPT, store.now(), request.reinstall ? 'wake_delivery_indexes_reinstall' : 'wake_delivery_indexes_execute', 'database', 'wake_delivery', request.reason, plan.planHash, JSON.stringify({ inputHash, receipt }), 'ok', request.requestId);
    boundedWakeDeliveryActive(store.db);
    return { ...receipt, duplicate: false };
  }); } catch (error) { forgetWakeIndexState(store.db); throw error; }
}
