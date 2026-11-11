// Explicit database-wide attachment index adoption. Startup never builds it.
import { createHash } from 'node:crypto';
import { attachmentSchema, attachmentLiveIndexSql, attachmentLiveIndexState } from './attachment-schema.mjs';
import { appendOperatorAction } from './operator-actions.mjs';
import { ServiceError } from './service-error.mjs';
import { SOURCE_REVISION } from './version.mjs';

export const ATTACHMENT_INDEX_LIMITS = Object.freeze({ rows: 32768, keyBytes: 4 * 1024 * 1024, storedBytes: 64 * 1024 * 1024 });
const POLICY = 'attachment-live-index.v1';
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const digest = value => createHash('sha256').update(value).digest('hex');
const textColumns = ['room_id', 'id', 'uploader_id', 'filename', 'media_type', 'sha256', 'state'];
const variableColumns = [...textColumns, 'bytes', 'message_id'];
const byteSum = columns => columns.map(column => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+');
const scalarSql = `SELECT ${byteSum(['room_id', 'id', 'state'])} AS keyBytes,
  ${byteSum(variableColumns)} AS storedBytes,
  CASE WHEN ${textColumns.map(column => `typeof(${column})='text'`).join(' AND ')}
    AND typeof(message_id) IN ('text','null') AND typeof(bytes) IN ('blob','null')
    AND state IN ('staged','committed','discarded','expired','deleted') THEN 1 ELSE 0 END AS valid
  FROM room_attachments INDEXED BY sqlite_autoindex_room_attachments_1 ORDER BY room_id,id LIMIT ?`;

function parse(input, execute) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['reason', 'reverse', ...(execute ? ['planHash', 'requestId'] : [])].includes(key))
    || typeof input.reason !== 'string' || !input.reason.trim() || Buffer.byteLength(input.reason) > 500
    || input.reverse !== undefined && typeof input.reverse !== 'boolean')
    fail(422, 'invalid_request', 'Use a reason and optional reverse boolean for this database-wide attachment operation');
  if (execute && (typeof input.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.planHash)))
    fail(422, 'invalid_request', 'Execute requires the exact attachment index planHash');
  if (execute && (typeof input.requestId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(input.requestId)))
    fail(422, 'request_id_required', 'Use a stable requestId and preserve the exact input on retry');
  return { reason: input.reason.trim(), reverse: input.reverse === true,
    ...(execute ? { planHash: input.planHash, requestId: input.requestId } : {}) };
}
function inspect(store, reverse) {
  const db = store.db;
  for (const [type, name, expected] of [['table', 'room_attachments', attachmentSchema.split(';')[0]],
    ['index', 'room_attachments_owner', attachmentSchema.split(';')[1].trim()]]) {
    const row = db.prepare('SELECT CASE WHEN length(CAST(sql AS BLOB))<=? THEN sql ELSE NULL END AS sql FROM sqlite_master WHERE type=? AND name=?')
      .get(Buffer.byteLength(expected), type, name);
    if (row?.sql !== expected) fail(409, 'attachment_index_conflict', 'Attachment table or owner index requires operator reconciliation');
  }
  const indexState = attachmentLiveIndexState(db);
  if (indexState === 'conflict') fail(409, 'attachment_index_conflict', 'The optional attachment index has a conflicting definition; nothing was replaced');
  // Admission returns only scalar lengths/booleans, across ALL rooms and states.
  // The PK order prevents a full sort. Payloads never cross the SQL boundary.
  const rows = db.prepare(scalarSql).all(ATTACHMENT_INDEX_LIMITS.rows + 1);
  let keyBytes = 0, storedBytes = 0;
  for (const row of rows) {
    keyBytes += row.keyBytes; storedBytes += row.storedBytes;
    if (row.valid !== 1 || !Number.isSafeInteger(row.keyBytes) || !Number.isSafeInteger(row.storedBytes))
      fail(409, 'attachment_index_budget_exceeded', 'Attachment scalar types require reconciliation; the optional index was not changed');
  }
  if (rows.length > ATTACHMENT_INDEX_LIMITS.rows || keyBytes > ATTACHMENT_INDEX_LIMITS.keyBytes || storedBytes > ATTACHMENT_INDEX_LIMITS.storedBytes)
    fail(409, 'attachment_index_budget_exceeded', 'This database exceeds optional attachment index admission; attachment quotas and the existing path are unchanged');
  // Only admitted key text is read, hex-encoded to bind exact SQLite bytes
  // even if a retained TEXT value contains invalid UTF-8. Returned key text
  // is bounded by twice the admitted key bytes. This binds index dependencies and lengths,
  // not payload content; it is not a new attachment-integrity certificate.
  const hash = createHash('sha256').update(JSON.stringify({ policy: POLICY, source: SOURCE_REVISION,
    ddl: attachmentLiveIndexSql, table: attachmentSchema, indexState, reverse, limits: ATTACHMENT_INDEX_LIMITS }));
  const keys = db.prepare('SELECT hex(CAST(room_id AS BLOB)) AS roomKey,hex(CAST(id AS BLOB)) AS idKey,state FROM room_attachments INDEXED BY sqlite_autoindex_room_attachments_1 ORDER BY room_id,id LIMIT ?')
    .all(ATTACHMENT_INDEX_LIMITS.rows + 1);
  if (keys.length !== rows.length) fail(409, 'plan_changed', 'Attachment input changed during inspection');
  for (let index = 0; index < keys.length; index++) hash.update(JSON.stringify([keys[index], rows[index].keyBytes, rows[index].storedBytes]));
  return { scope: 'database', target: 'room_attachments', sourceRevision: SOURCE_REVISION, policy: POLICY,
    reverse, installed: indexState === 'installed', admitted: { rows: rows.length, keyBytes, storedBytes },
    limits: ATTACHMENT_INDEX_LIMITS, ddlHash: digest(attachmentLiveIndexSql), planHash: hash.digest('hex') };
}
export function operatorAttachmentIndex(store, input, execute = false, requestId = null) {
  if (store.readOnly) fail(409, 'read_only', 'This store is read-only');
  const request = parse(input, execute);
  return store.transaction(() => {
    const id = execute ? 'oa_attachment_live_index_' + digest(request.requestId) : null;
    const inputHash = execute ? digest(JSON.stringify(request)) : null;
    if (execute) {
      const prior = store.db.prepare('SELECT counts_json FROM operator_actions WHERE id=?').get(id);
      if (prior) {
        const saved = JSON.parse(prior.counts_json);
        if (saved.inputHash !== inputHash) fail(409, 'idempotency_conflict', 'This requestId already records different attachment index input');
        return { ...saved.receipt, duplicate: true };
      }
    }
    const plan = inspect(store, request.reverse);
    if (execute && plan.planHash !== request.planHash) fail(409, 'plan_changed', 'Attachment index dependencies changed; inspect a fresh plan');
    const changed = execute && plan.installed === request.reverse;
    if (changed) store.db.exec(request.reverse ? 'DROP INDEX room_attachments_live' : attachmentLiveIndexSql);
    const installed = attachmentLiveIndexState(store.db);
    if (installed === 'conflict' || execute && (installed === 'installed') === request.reverse)
      fail(409, 'attachment_index_conflict', 'Attachment index verification failed; the operation was rolled back');
    const receipt = { ok: true, ...plan, ...(execute ? { result: { changed, installed: installed === 'installed' } } : {}) };
    if (execute) {
      store.db.prepare(`INSERT INTO operator_actions
        (id,at,action,target_kind,target_id,reason,plan_hash,counts_json,result,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(id, store.now(), 'attachment_index_execute', 'database', 'room_attachments', request.reason,
          plan.planHash, JSON.stringify({ inputHash, receipt }), 'ok', request.requestId);
    } else appendOperatorAction(store, { action: 'attachment_index_plan', targetKind: 'database', targetId: 'room_attachments',
      reason: request.reason, planHash: plan.planHash, counts: plan.admitted, result: 'ok', requestId });
    return receipt;
  });
}
