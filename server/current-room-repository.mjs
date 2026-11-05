import {syncCurrentRoomPublication} from './public-read-model.mjs';
import {verifyRoomAssistantIndexes} from './room-assistant-schema.mjs';
import {prepareClaimOverlap,matchClaimOverlap} from '../src/claim-overlap.js';
import {conflictingClaim} from './claim-scopes.mjs';
import {boardStateForWorkItem} from './work-item-state.mjs';
import {roomWorkClaimConfig} from './work-claims.mjs';
import {CURRENT_INBOX_DISCOVERY_INDEXES} from './current-inbox-indexes.mjs';
import {emptyWorkPrivacy,validateWorkPrivacy,applyWorkPrivacyRequest,deriveWorkPrivacy,workRequestPrefix,workRequestKey,workRequestValue} from './current-work-privacy.mjs';
import {CURRENT_LEGACY_WORK_INDEXES,CURRENT_LEGACY_WORK_GUARDS,assertLegacyWorkReconciled} from './current-legacy-work-gate.mjs';
import {currentWorkCapacity,assertCurrentWorkCapacity,CURRENT_WORK_CAPACITY_INDEXES} from './current-work-capacity.mjs';
import {CURRENT_WRITER_FORMAT} from './current-room-format.mjs';
import {workRoleHolder} from './work-context.mjs';
import {currentWorkSummary} from './current-work-summary.mjs';
import {archiveRetains,recoverArchiveMarker} from './current-room-archive.mjs';
import {messageRowForWrite} from './messages-store.mjs';
import {messageProofHash,assertMessageWrite,recordMessageWrite,MESSAGE_PROOF_FIELDS} from './write-integrity.mjs';
import { RESTORE_CONTROL_DEFINITIONS, RESTORE_CONTROL_GUARDS, RESTORE_CONTROL_SCHEMA, inRestoreContext, withExactRestoreGuards } from './restore-admission.mjs';
import { messageInHistory, historyFloor as deriveHistoryFloor, historyActivationTuple, historyActivationValue } from './history-visibility.mjs';
import { bindCurrentRecordContext } from '../src/current-record-context.js';
// Current serving metadata, never replay staging. Version/fences are storage
// compatibility and prospective write integrity, not authority against a DBA.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { emptyRoomState, memberHistoryVisibility, validId, MAX_MESSAGE_BODY_CHARS } from '../src/events.js';
import { MESSAGE_EDIT_HISTORY_LIMITS } from '../src/message-reducers.js';
import { messageProofMatches, MESSAGE_PROOF_SELECT, recordProjectionWrite } from './write-integrity.mjs';
import { decodeMessageEntity } from './message-entity-projection.mjs';
import { referenceWorkItems } from './work-repository.mjs';
import { syncMessageRows, materializeCurrentMessageRows, affectedMessageIds } from './messages-store.mjs';
import { ServiceError } from './service-error.mjs';

export const CURRENT_ROOM_TABLES = Object.freeze(['current_room_records','current_room_record_proofs','current_room_head','current_room_writer_permit']);
export {CURRENT_WRITER_FORMAT} from './current-room-format.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
// The rooms row holds only this fixed-size commitment; entities live in their own records.
const serializeCurrentCarrier = (revision, headHash) =>
  JSON.stringify({normalizedCurrent:{version:1,headRevision:revision,headHash}});
const corrupt = message => { throw Error('current_room_corrupt: ' + message); };
const refuse = message => { throw new ServiceError(409,'current_room_context_unavailable',message); };
// Internal distinction only: callers retain the existing public refusal unless
// an authenticated aggregate reader explicitly maps its exhausted quota.
export class CurrentReadBudgetExceeded extends ServiceError {
  constructor() { super(409, 'current_room_context_unavailable', 'Current record context exceeds bounded input; use a smaller addressed request'); }
}
const MAX_INPUT = 256 * 1024, MAX_RECORD = 128 * 1024;
// One cumulative canonical-message input reservation per current read scope.
// The body occurs twice: UTF-8 text (<=3 bytes/unit) and JSON (<=6 bytes/unit).
// History keeps the original producer limits; metadata keeps its 128KiB cap.
export const CURRENT_MESSAGE_INPUT_BYTES = 9 * MAX_MESSAGE_BODY_CHARS + 6 * MESSAGE_EDIT_HISTORY_LIMITS.totalChars + MAX_RECORD;
const encodedBodyBytes = body => typeof body === 'string' ? Buffer.byteLength(JSON.stringify(body)) - 2 : 0;
function messageGeometry(row, message) {
  const history = message.editHistory ?? [];
  if (typeof message.body === 'string' && message.body.length > MAX_MESSAGE_BODY_CHARS
    || !Array.isArray(history) || history.length > MESSAGE_EDIT_HISTORY_LIMITS.entries) refuse('Canonical message body/history exceeds the accepted producer limits');
  let historyUnits = 0, historyBytes = 0;
  for (const entry of history) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || entry.body != null && typeof entry.body !== 'string'
      || typeof entry.body === 'string' && entry.body.length > MESSAGE_EDIT_HISTORY_LIMITS.bodyChars) refuse('Canonical message history exceeds the accepted producer limits');
    historyUnits += (typeof entry.body === 'string' ? entry.body.length : 0) + MESSAGE_EDIT_HISTORY_LIMITS.entryOverheadChars;
    historyBytes += encodedBodyBytes(entry.body);
  }
  if (historyUnits > MESSAGE_EDIT_HISTORY_LIMITS.totalChars) refuse('Canonical message history exceeds the accepted producer limits');
  const bytes = MESSAGE_PROOF_FIELDS.reduce((sum, key) => sum + (row[key] == null ? 0 : Buffer.byteLength(String(row[key]))), 0);
  const metadataBytes = bytes - (row.body == null ? 0 : Buffer.byteLength(row.body)) - encodedBodyBytes(message.body) - historyBytes;
  if (metadataBytes < 0 || metadataBytes > MAX_RECORD || bytes > CURRENT_MESSAGE_INPUT_BYTES) refuse('Canonical message metadata exceeds bounded input');
  return {bytes, metadataBytes};
}
const MESSAGE_HEADER_FIELDS = Object.freeze(['message_id','seq','channel_id','thread_root_id','reply_to_id','to_member_id','work_item_id','author_id','created_at','deleted_at']);
const messageHeader = row => Object.fromEntries(MESSAGE_HEADER_FIELDS.map(key => [key, row[key] ?? null]));
const messageWitness = row => ({sequence: row.seq, entityHash: row.entity_hash ?? messageProofHash(row), header: messageHeader(row)});
const headerSource = (header, entityHash) => ({headerOnly: true, row: {...header, entity_hash: entityHash}, value: {
  id: header.message_id, authorId: header.author_id, channelId: header.channel_id,
  replyToId: header.reply_to_id, toMemberId: header.to_member_id, workItemId: header.work_item_id,
  createdAt: header.created_at, ...(header.deleted_at ? {deletedAt: header.deleted_at} : {})
}});
// These dependencies are never returned as messages or persisted. Their private
// and ancestry fields are authenticated by the protected witness, not by a
// caller-supplied/stale scalar hash. Old witnesses require a full verified read.
function readCurrentMessageHeader(db, roomId, id, b) {
  const witness = readCurrentRecord(db, roomId, 'messageWitness', id, b);
  if (witness?.header === undefined) {
    b.ancestorReads = (b.ancestorReads ?? 0) + 1;
    if (b.ancestorReads > 32) refuse('Legacy reply ancestry exceeds bounded proof work');
    // Keep the SAME cumulative metadata/receipt budget. Only body proof work
    // uses a separate finite 32-entity ceiling, one loaded entity at a time.
    const unit = {...b, messageBytes: 0};
    let source;
    try { source = readCurrentMessage(db, roomId, id, unit); }
    finally {
      b.bytes = unit.bytes; b.records = unit.records;
      b.ancestorBytes = (b.ancestorBytes ?? 0) + (unit.messageBytes ?? 0);
    }
    if ((b.ancestorBytes ?? 0) > 32 * CURRENT_MESSAGE_INPUT_BYTES) refuse('Legacy reply ancestry exceeds bounded proof work');
    return source ? headerSource(messageHeader(source.row), source.row.entity_hash) : undefined;
  }
  const size = db.prepare(`SELECT ${MESSAGE_HEADER_FIELDS.map(key => `length(CAST(${key} AS BLOB)) AS ${key}`).join(',')},length(CAST(entity_hash AS BLOB)) AS entity_hash FROM messages WHERE room_id=? AND message_id=?`).get(roomId, id);
  if (!size) corrupt('witnessed canonical message missing');
  const bytes = Object.values(size).reduce((n, value) => n + (value ?? 0), 0);
  if (bytes > MAX_RECORD) refuse('Canonical message header exceeds bounded input');
  charge(b, bytes + 256, 2);
  const row = db.prepare(`SELECT ${MESSAGE_HEADER_FIELDS.join(',')},entity_hash FROM messages WHERE room_id=? AND message_id=?`).get(roomId, id);
  if (witness.sequence !== row.seq || witness.entityHash !== row.entity_hash || !isDeepStrictEqual(witness.header, messageHeader(row))) corrupt('message header proof changed');
  return headerSource(witness.header, witness.entityHash);
}
function admitCanonicalMessageWrite(row, current) {
  if (current.candidate) return; // Historical candidate replay is not a new command.
  const bytes = MESSAGE_PROOF_FIELDS.reduce((sum, key) => sum + (row[key] == null ? 0 : Buffer.byteLength(String(row[key]))), 0);
  if (bytes > CURRENT_MESSAGE_INPUT_BYTES) throw new ServiceError(422, 'current_message_entity_too_large',
    `Message entity is ${bytes} bytes; the derived maximum is ${CURRENT_MESSAGE_INPUT_BYTES} bytes. No changes were saved`);
  if (bytes > MAX_RECORD) messageGeometry(row, decodeMessageEntity(row));
}
const maps = new Set(['members','channels','workItems','replyRequests','agentHalts','helpOffers','bonds']);
const omitted = new Set(['messages','messageAuthority','eventLog','seenEvents','seenIdempotencyKeys']);
const normalized = sql => sql?.trim().replace(/;$/,'').replace(/IF NOT EXISTS /g,'').replace(/\s+/g,' ');
const schemaCache=new WeakMap(),auditSchemaLocations=new WeakMap(),formatScopes=new WeakMap();
const definitions = [
  ['current_room_records',`CREATE TABLE IF NOT EXISTS current_room_records (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, domain TEXT NOT NULL, record_key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=0), payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 1 AND 131072),
    payload_sha256 TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(room_id,domain,record_key))`],
  ['current_room_record_proofs',`CREATE TABLE IF NOT EXISTS current_room_record_proofs (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, domain TEXT NOT NULL, record_key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=0), present INTEGER NOT NULL CHECK(present IN (0,1)),
    payload_sha256 TEXT NOT NULL, receipt_id TEXT NOT NULL, PRIMARY KEY(room_id,domain,record_key))`],
  ['current_room_head',`CREATE TABLE IF NOT EXISTS current_room_head (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE, format_version INTEGER NOT NULL CHECK(format_version=1),
    sequence INTEGER NOT NULL, event_id TEXT NOT NULL, revision INTEGER NOT NULL,
    head_sha256 TEXT NOT NULL, counts_json TEXT NOT NULL, receipt_id TEXT NOT NULL)`],
  ['current_room_writer_permit',`CREATE TABLE IF NOT EXISTS current_room_writer_permit (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), room_id TEXT, receipt_id TEXT)`]
];
export const CURRENT_ROOM_SCHEMA = definitions.map(([,sql])=>sql+';').join('\n') + '\n' + RESTORE_CONTROL_SCHEMA
  + '\nINSERT OR IGNORE INTO current_room_writer_permit VALUES(1,0,NULL,NULL);';
const permitFor = row => `(SELECT enabled=1 AND room_id=${row}.room_id FROM current_room_writer_permit WHERE singleton=1) IS 1`;
const guardDefinitions = [...CURRENT_LEGACY_WORK_GUARDS];
for (const table of ['current_room_records','current_room_record_proofs','current_room_head','messages','work_entities','dm_consents','room_attachments','events','commands','rooms']) {
  for (const operation of ['INSERT','UPDATE','DELETE']) {
    const rows=operation==='UPDATE'?['OLD','NEW']:[operation==='DELETE'?'OLD':'NEW'];
    const key=row=>`${row}.${table==='rooms'?'id':'room_id'}`;
    const scoped = CURRENT_ROOM_TABLES.includes(table) ? '1'
      : rows.map(row=>`(EXISTS(SELECT 1 FROM current_room_head WHERE room_id=${key(row)}) OR EXISTS(SELECT 1 FROM current_room_record_proofs WHERE room_id=${key(row)} AND domain='migrationFence' AND record_key='active' AND present=1))`).join(' OR ');
    const admitted = rows.map(row=> table==='rooms'
      ? `(SELECT enabled=1 AND room_id=${key(row)} FROM current_room_writer_permit WHERE singleton=1) IS 1`
      : permitFor(row)).join(' AND ');
    const marker = table==='rooms' && operation!=='DELETE'
      ? ` SELECT CASE WHEN EXISTS(SELECT 1 FROM current_room_head WHERE room_id=NEW.id) AND (json_valid(NEW.projection) IS NOT 1 OR json_extract(NEW.projection,'$.normalizedCurrent.version') IS NOT 1
        OR (SELECT count(*) FROM json_each(NEW.projection))<>1) THEN RAISE(ABORT,'unsupported current room carrier') END;` : '';
    const name=`current_room_guard_${table}_${operation.toLowerCase()}`;
    guardDefinitions.push([name,`CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${operation} ON ${table}
      WHEN ${scoped} BEGIN SELECT CASE WHEN NOT (${admitted}) THEN RAISE(ABORT,'unsupported current room writer') END;${marker} END`]);
  }
}
guardDefinitions.push(['current_room_permit_update',`CREATE TRIGGER IF NOT EXISTS current_room_permit_update BEFORE UPDATE ON current_room_writer_permit BEGIN
  SELECT CASE WHEN NEW.singleton IS NOT 1 OR NEW.enabled NOT IN (0,1) OR
    (NEW.enabled=0 AND (NEW.room_id IS NOT NULL OR NEW.receipt_id IS NOT NULL)) OR
    (NEW.enabled=1 AND (OLD.enabled IS NOT 0 OR NOT EXISTS(SELECT 1 FROM operator_actions a
      WHERE a.id=NEW.receipt_id AND a.action='current_room_writer_admission' AND json_extract(a.counts_json,'$.format')='${CURRENT_WRITER_FORMAT}' AND a.target_kind='room' AND a.target_id=NEW.room_id
      AND json_extract(a.counts_json,'$.roomId')=NEW.room_id AND json_extract(a.counts_json,'$.permitId')=NEW.receipt_id
      AND json_extract(a.counts_json,'$.headHash')=coalesce((SELECT head_sha256 FROM current_room_head WHERE room_id=NEW.room_id),'new'))
      OR EXISTS(SELECT 1 FROM operator_actions WHERE id=NEW.receipt_id||'_closed'))) OR
    (NEW.enabled=0 AND OLD.enabled=1 AND NOT EXISTS(SELECT 1 FROM operator_actions WHERE id=OLD.receipt_id||'_closed'
      AND action='current_room_writer_closed' AND target_id=OLD.room_id))
    THEN RAISE(ABORT,'unsupported current room permit') END; END`],
  ['current_room_permit_insert',`CREATE TRIGGER IF NOT EXISTS current_room_permit_insert BEFORE INSERT ON current_room_writer_permit BEGIN
    SELECT CASE WHEN NEW.enabled IS NOT 0 OR NEW.room_id IS NOT NULL OR NEW.receipt_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM current_room_writer_permit WHERE enabled<>0)
      THEN RAISE(ABORT,'unsupported current room permit') END; END`],
  ['current_room_permit_delete',`CREATE TRIGGER IF NOT EXISTS current_room_permit_delete BEFORE DELETE ON current_room_writer_permit BEGIN
    SELECT RAISE(ABORT,'unsupported current room permit'); END`]);
// Independent selectors: current request metadata and immutable opening events.
export const CURRENT_REQUEST_OPENING_PREDICATE = "json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.requestKind')='reply' AND json_extract(body,'$.data.requestPolicyVersion')=1";
export const CURRENT_REQUEST_PARTY_INDEXES = ['requester','recipient'].map(role =>
  `CREATE INDEX IF NOT EXISTS current_request_party_${role} ON current_room_records(room_id,json_extract(payload,'$.${role}Id'),record_key) WHERE domain='replyRequests';`
).join('\n') + ['requester','recipient'].map(role =>
  `CREATE INDEX IF NOT EXISTS current_request_opening_${role} ON events(room_id,json_extract(body,'${role==='requester'?'$.actorId':'$.data.toMemberId'}'),sequence) WHERE ${CURRENT_REQUEST_OPENING_PREDICATE};`
).join('\n');
export const CURRENT_PUBLIC_WORK_PREDICATE = "CASE WHEN json_valid(body) THEN json_extract(body,'$.publicTask.enabled')=1 AND json_extract(body,'$.state') IN ('proposed','accepted','working','blocked') ELSE 0 END";
export const CURRENT_PUBLIC_WORK_INDEX_SQL = `CREATE INDEX IF NOT EXISTS current_public_work_keys ON work_entities(room_id,work_id) WHERE ${CURRENT_PUBLIC_WORK_PREDICATE}`;
export const CURRENT_ROOM_GUARDS = [...guardDefinitions,...RESTORE_CONTROL_GUARDS].map(([,sql])=>sql+';').join('\n') + CURRENT_LEGACY_WORK_INDEXES + CURRENT_WORK_CAPACITY_INDEXES + CURRENT_INBOX_DISCOVERY_INDEXES + CURRENT_REQUEST_PARTY_INDEXES + CURRENT_PUBLIC_WORK_INDEX_SQL + ';\n' + `
CREATE INDEX IF NOT EXISTS current_redaction_message_events ON events(room_id,CASE WHEN json_type(body,'$.data.messageId')='text' AND json_extract(body,'$.data.messageId')<>'' THEN json_extract(body,'$.data.messageId') ELSE id END,sequence);
CREATE INDEX IF NOT EXISTS current_redaction_code_drops ON room_code_drops(room_id,message_id,id);
CREATE INDEX IF NOT EXISTS current_room_attachments_message ON room_attachments(room_id,message_id,id);
CREATE INDEX IF NOT EXISTS current_native_claim_expiry ON current_room_records(room_id,json_extract(payload,'$.work.claim.expiresAtMs'),record_key) WHERE domain='workSummary' AND json_extract(payload,'$.work.claim.status')='active';
CREATE INDEX IF NOT EXISTS current_native_claim_held ON current_room_records(room_id,json_extract(payload,'$.work.claim.holderId'),json_extract(payload,'$.work.claim.expiresAtMs'),record_key) WHERE domain='workSummary' AND json_extract(payload,'$.work.state')='accepted' AND json_extract(payload,'$.work.claim.status')='active';
CREATE INDEX IF NOT EXISTS current_native_work_held ON current_room_records(room_id,COALESCE(json_extract(payload,'$.work.claim.holderId'),json_extract(payload,'$.work.accountableMemberId')),record_key) WHERE domain='workSummary' AND json_extract(payload,'$.work.state') IN ('working','blocked');
CREATE INDEX IF NOT EXISTS current_native_work_proposals ON events(room_id,json_extract(body,'$.data.workItemId'),sequence) WHERE json_extract(body,'$.type')='work.proposed';
CREATE INDEX IF NOT EXISTS current_work_summary_keys ON current_room_record_proofs(room_id,record_key) WHERE domain='workSummary' AND present=1;
CREATE INDEX IF NOT EXISTS current_reply_request_keys ON current_room_record_proofs(room_id,record_key) WHERE domain='replyRequests' AND present=1;
CREATE INDEX IF NOT EXISTS current_messages_public_seq ON messages(room_id,seq DESC,message_id DESC) WHERE to_member_id IS NULL OR to_member_id='';
CREATE INDEX IF NOT EXISTS current_messages_channel_public_seq ON messages(room_id,channel_id,seq DESC,message_id DESC) WHERE to_member_id IS NULL OR to_member_id='';
CREATE INDEX IF NOT EXISTS current_messages_incoming_seq ON messages(room_id,to_member_id,seq DESC,message_id DESC);
CREATE INDEX IF NOT EXISTS current_messages_outgoing_seq ON messages(room_id,author_id,seq DESC,message_id DESC) WHERE to_member_id IS NOT NULL AND to_member_id<>'';
CREATE INDEX IF NOT EXISTS current_messages_pair_seq ON messages(room_id,author_id,to_member_id,seq DESC,message_id DESC);
CREATE INDEX IF NOT EXISTS current_messages_public_seq_live ON messages(room_id,seq DESC,message_id DESC) WHERE (to_member_id IS NULL OR to_member_id='') AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS current_messages_channel_public_seq_live ON messages(room_id,channel_id,seq DESC,message_id DESC) WHERE (to_member_id IS NULL OR to_member_id='') AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS current_messages_incoming_seq_live ON messages(room_id,to_member_id,seq DESC,message_id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS current_messages_outgoing_seq_live ON messages(room_id,author_id,seq DESC,message_id DESC) WHERE (to_member_id IS NOT NULL AND to_member_id<>'') AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS current_messages_pair_seq_live ON messages(room_id,author_id,to_member_id,seq DESC,message_id DESC) WHERE deleted_at IS NULL;
`;
// The pre-release format5 runtime was deployed before any normalized adoption.
// Upgrade only that exact, unused namespace. Populated native state and pending
// restore require their own explicit recovery; legacy rooms/auth are untouched.
export function upgradeUnusedCurrentFormat5(db) {
  if (!db.isTransaction) throw Error('Current format transition requires a transaction');
  const permit=db.prepare("SELECT sql FROM sqlite_master WHERE name='current_room_permit_update'").get();
  if (!permit || !permit.sql.includes('normalized-current-v1-native-work-5')) return false;
  const owned=[...definitions,...RESTORE_CONTROL_DEFINITIONS,...guardDefinitions,...RESTORE_CONTROL_GUARDS];
  const rows=db.prepare('SELECT name,sql FROM sqlite_master WHERE name IN ('+owned.map(()=>'?').join(',')+')').all(...owned.map(([name])=>name));
  if (rows.length!==owned.length || owned.some(([name,sql])=>normalized(rows.find(row=>row.name===name)?.sql)!==normalized(sql.replaceAll(CURRENT_WRITER_FORMAT,'normalized-current-v1-native-work-5'))))
    throw Error('Previous current format schema requires reconciliation');
  for (const table of ['current_room_head','current_room_records','current_room_record_proofs','current_restore_audit_scratch'])
    if (db.prepare('SELECT 1 FROM '+table+' LIMIT 1').get()) throw Error('Populated previous current format requires explicit recovery');
  const gate=db.prepare('SELECT * FROM current_room_writer_permit').all();
  const restore=db.prepare('SELECT * FROM current_restore_admission').all();
  if (gate.length!==1 || gate[0].singleton!==1 || gate[0].enabled!==0 || gate[0].room_id!==null || gate[0].receipt_id!==null
    || restore.length!==1 || restore[0].singleton!==1 || restore[0].state!=='clear' || restore[0].restore_id!==null || restore[0].phase!=='clear'
    || restore[0].revision!==0 || restore[0].source_seal!==null || restore[0].coverage!==null)
    throw Error('Previous current format has unfinished authority');
  for (const [name,sql] of [...guardDefinitions,...RESTORE_CONTROL_GUARDS].filter(([,sql])=>sql.includes(CURRENT_WRITER_FORMAT))) {
    db.exec('DROP TRIGGER '+name);db.exec(sql);
  }
  verifyCurrentRoomSchema(db);
  return true;
}
export function verifyCurrentRoomSchema(db) {
  // Cache lookup locations only. Every invocation checks the complete ORIGINAL
  // audit-owned set, exact names/cardinality/normalized SQL, and closed permit.
  // Serving indexes/budgets and writer_v/history inventories stay with their
  // existing independent verifiers; this is not a schema trust epoch.
  const expected=new Map([...definitions,...RESTORE_CONTROL_DEFINITIONS,...guardDefinitions,...RESTORE_CONTROL_GUARDS]
    .map(([name,sql])=>[name,normalized(sql)]));
  let saved=auditSchemaLocations.get(db);
  let rows;
  try {
    rows=saved
      ?db.prepare('SELECT rowid,name,sql FROM sqlite_master WHERE rowid IN ('+saved.map(()=>'?').join(',')+')').all(...saved.map(row=>row.rowid))
      :db.prepare('SELECT rowid,name,sql FROM sqlite_master WHERE name IN ('+[...expected].map(()=>'?').join(',')+')').all(...expected.keys());
    // Restore may legally reinstall its exact guards at new catalog rowids.
    // A location miss never changes authority: retry the ORIGINAL full set.
    if(saved&&(rows.length!==expected.size||rows.some(row=>saved.find(location=>location.rowid===row.rowid)?.name!==row.name||expected.get(row.name)!==normalized(row.sql)))) {
      auditSchemaLocations.delete(db);saved=null;
      rows=db.prepare('SELECT rowid,name,sql FROM sqlite_master WHERE name IN ('+[...expected].map(()=>'?').join(',')+')').all(...expected.keys());
    }
    const locations=saved?new Map(saved.map(row=>[row.rowid,row.name])):null;
    const changed=rows.find(row=>!Number.isSafeInteger(row.rowid)||row.rowid<1
      ||!expected.has(row.name)||expected.get(row.name)!==normalized(row.sql)
      ||locations&&locations.get(row.rowid)!==row.name);
    if(rows.length!==expected.size || changed) {
      const missing=[...expected.keys()].find(name=>!rows.some(row=>row.name===name));
      auditSchemaLocations.delete(db);
      corrupt('schema requires reconciliation: '+(changed?.name??missing??'owned definition cardinality'));
    }
  } catch(error) { auditSchemaLocations.delete(db);throw error; }
  if(!saved)auditSchemaLocations.set(db,rows.map(({rowid,name})=>({rowid,name})));
  const permit=db.prepare('SELECT singleton,enabled,room_id,receipt_id FROM current_room_writer_permit').all();
  if(permit.length!==1 || permit[0].singleton!==1 || permit[0].enabled!==0 || permit[0].room_id!==null || permit[0].receipt_id!==null) {
    auditSchemaLocations.delete(db);
    corrupt('writer permit is not closed');
  }
}

export function withCurrentRoomWriter(db,roomId,operation) {
  if(!db.isTransaction)throw Error('Current room writer requires existing transaction');
  const previous=db.prepare('SELECT enabled,room_id,receipt_id FROM current_room_writer_permit WHERE singleton=1').get();
  if(previous.enabled!==0) {
    if(previous.enabled!==1 || previous.room_id!==roomId || formatScopes.get(db)!==roomId)throw Error('Current room writer scope collision');
    return operation();
  }
  if(previous.room_id!==null||previous.receipt_id!==null)corrupt('unclosed format writer');
  const permitId='oa_cwa_'+hash(randomUUID()),headHash=db.prepare('SELECT head_sha256 FROM current_room_head WHERE room_id=?').get(roomId)?.head_sha256??'new';
  db.prepare('INSERT INTO operator_actions(id,at,action,target_kind,target_id,counts_json,result) VALUES(?,?,?,?,?,?,?)')
    .run(permitId,Date.now(),'current_room_writer_admission','room',roomId,JSON.stringify({roomId,permitId,headHash,format:CURRENT_WRITER_FORMAT}),'opened');
  db.prepare('UPDATE current_room_writer_permit SET enabled=1,room_id=?,receipt_id=? WHERE singleton=1').run(roomId,permitId);
  formatScopes.set(db,roomId);
  try { const result=operation();if(result?.then)throw Error('Current room writer must remain synchronous');return result; }
  finally { formatScopes.delete(db);if(db.isTransaction){
    db.prepare('INSERT INTO operator_actions(id,at,action,target_kind,target_id,counts_json,result) VALUES(?,?,?,?,?,?,?)')
      .run(permitId+'_closed',Date.now(),'current_room_writer_closed','room',roomId,JSON.stringify({permitId}),'closed');
    db.prepare('UPDATE current_room_writer_permit SET enabled=0,room_id=NULL,receipt_id=NULL WHERE singleton=1').run();
  }}
}
export function isCurrentRoom(db,roomId) {
  if(db.prepare('SELECT 1 FROM current_room_head WHERE room_id=?').get(roomId))return true;
  const prefix=Buffer.from('{"normalizedCurrent":');
  if(db.prepare('SELECT 1 FROM rooms WHERE id=? AND substr(CAST(projection AS BLOB),1,?)=?').get(roomId,prefix.length,prefix))
    corrupt('closed current marker lacks its independent head');
  return false;
}
const budget = (maxRecords=200) => ({bytes:0,records:0,maxRecords,receipts:new Map()});
function charge(b,n,rows=1) {
  if(!Number.isSafeInteger(n)||n<0)corrupt('invalid scalar size');
  b.bytes+=n;b.records+=rows;
  if(b.bytes>MAX_INPUT||b.records>(b.maxRecords??200))throw new CurrentReadBudgetExceeded();
}
export const chargeCurrentReadBudget=(b,bytes,records=1)=>charge(b,bytes,records);
export const remainingCurrentReadBytes=b=>Math.max(0,MAX_INPUT-(b?.bytes??0));
function receipt(db,id,b) {
  if(b.receipts.has(id))return b.receipts.get(id);
  // Audit units retain independent input accounting while reusing at most four
  // bounded immutable envelopes inside this one consistent census transaction.
  const cached=b.auditReceipts?.get(id);
  if(cached){
    charge(b,cached.bytes+256);b.receipts.set(id,cached.value);
    b.auditReceipts.delete(id);b.auditReceipts.set(id,cached);
    return cached.value;
  }
  const size=db.prepare('SELECT length(CAST(counts_json AS BLOB)) AS bytes FROM operator_actions WHERE id=? AND action=?')
    .get(id,'current_room_transition');
  if(!size||size.bytes>MAX_RECORD)corrupt('missing transition receipt');charge(b,size.bytes+256);
  const row=db.prepare('SELECT counts_json FROM operator_actions WHERE id=? AND action=?').get(id,'current_room_transition');
  const value=JSON.parse(row.counts_json);b.receipts.set(id,value);
  if(b.auditReceipts){
    b.auditReceipts.set(id,{bytes:size.bytes,value});
    if(b.auditReceipts.size>4)b.auditReceipts.delete(b.auditReceipts.keys().next().value);
  }
  return value;
}
const headValue = row => [1,row.room_id,row.sequence,row.event_id,row.revision,JSON.parse(row.counts_json)];
function admitCurrentSchema(db,b) {
  if(b.schemaVerified)return;
  const expected=new Map([...definitions,...RESTORE_CONTROL_DEFINITIONS,...guardDefinitions,...RESTORE_CONTROL_GUARDS].map(([name,sql])=>[name,normalized(sql)]));
  // Include the exact owned visibility indexes as well as mutation guards.
  for(const sql of CURRENT_ROOM_GUARDS.split(';').map(sql=>sql.trim()).filter(sql=>sql.startsWith('CREATE INDEX')))
    expected.set(/CREATE INDEX IF NOT EXISTS ([a-z_]+)/.exec(sql)[1],normalized(sql));
  let saved=schemaCache.get(db),rows;
  if(saved)rows=db.prepare(`SELECT rowid,name,sql FROM sqlite_master WHERE rowid IN (${saved.map(()=>'?').join(',')})`).all(...saved);
  else rows=db.prepare(`SELECT rowid,name,sql FROM sqlite_master WHERE name IN (${[...expected].map(()=>'?').join(',')})`).all(...expected.keys());
  charge(b,rows.reduce((bytes,row)=>bytes+Buffer.byteLength(row.sql??'')+128,0),rows.length);
  if(saved&&(rows.length!==expected.size||rows.some(row=>expected.get(row.name)!==normalized(row.sql)))) {
    schemaCache.delete(db);saved=null;
    rows=db.prepare(`SELECT rowid,name,sql FROM sqlite_master WHERE name IN (${[...expected].map(()=>'?').join(',')})`).all(...expected.keys());
    charge(b,rows.reduce((bytes,row)=>bytes+Buffer.byteLength(row.sql??'')+128,0),rows.length);
  }
  if(rows.length!==expected.size||rows.some(row=>expected.get(row.name)!==normalized(row.sql)))corrupt('owned serving schema changed');
  if(!saved)schemaCache.set(db,rows.map(row=>row.rowid));
  const permit=db.prepare('SELECT singleton,enabled,room_id,receipt_id FROM current_room_writer_permit').all();charge(b,256,permit.length);
  const scope=formatScopes.get(db);
  if(permit.length!==1||permit[0].singleton!==1||permit[0].enabled!==(scope?1:0)||permit[0].room_id!==(scope??null)||(!scope&&permit[0].receipt_id!==null))corrupt('unregistered format writer permit');
  b.schemaVerified=true;
  b.verifiedSchema=rows.map(({rowid,name,sql})=>[rowid,name,sql]);
}
export function readCurrentHead(db,roomId,b=contextBudgets.get(db)??budget()) {
  const scalar=db.prepare('SELECT length(CAST(counts_json AS BLOB)) AS bytes FROM current_room_head WHERE room_id=?').get(roomId);
  if(!scalar){isCurrentRoom(db,roomId);return null;}admitCurrentSchema(db,b);if(scalar.bytes>4096)corrupt('oversized head');charge(b,scalar.bytes+1024);
  const row=db.prepare('SELECT * FROM current_room_head WHERE room_id=?').get(roomId);
  if(row.format_version!==1||hash(JSON.stringify(headValue(row)))!==row.head_sha256)corrupt('head commitment changed');
  const saved=receipt(db,row.receipt_id,b);
  if(saved.roomId!==roomId||saved.headHash!==row.head_sha256)corrupt('head receipt changed');
  const carrier=db.prepare('SELECT sequence,projection FROM rooms WHERE id=?').get(roomId);
  charge(b,512);
  if(!carrier||carrier.sequence!==row.sequence||carrier.projection!==serializeCurrentCarrier(row.revision,row.head_sha256))
    corrupt('carrier differs from independent head');
  return {...row,counts:JSON.parse(row.counts_json)};
}
export function readCurrentRecord(db,roomId,domain,key,b=contextBudgets.get(db)??budget()) {
  if(!b.schemaVerified&&!readCurrentHead(db,roomId,b))corrupt('record namespace is not initialized');
  if(typeof key!=='string'||Buffer.byteLength(key)>200)refuse('Current record identity is too large');
  const reuse=workSummaryReuseScopes.get(db),reuseKey=domain+'\0'+key;
  const reusable=reuse?.roomId===roomId&&(domain==='metadata'&&key==='room'||domain==='members'&&(key===reuse.viewerId||key===reuse.ownerId));
  if(reusable&&reuse.authority.has(reuseKey))return structuredClone(reuse.authority.get(reuseKey));
  charge(b,1024,2);
  const proof=db.prepare('SELECT revision,present,payload_sha256,receipt_id FROM current_room_record_proofs WHERE room_id=? AND domain=? AND record_key=?').get(roomId,domain,key);
  const scalar=db.prepare('SELECT revision,payload_bytes,length(CAST(payload AS BLOB)) AS bytes,payload_sha256 FROM current_room_records WHERE room_id=? AND domain=? AND record_key=?').get(roomId,domain,key);
  if(!proof){if(scalar)corrupt('payload lacks independent membership proof');return undefined;}
  const saved=receipt(db,proof.receipt_id,b);
  if(saved.roomId!==roomId||!saved.records?.some(tuple=>isDeepStrictEqual(tuple,[domain,key,proof.revision,proof.present,proof.payload_sha256])))
    corrupt('record witness receipt changed');
  if(proof.present===0){if(scalar)corrupt('tombstoned payload exists');return undefined;}
  if(proof.present!==1||!scalar||scalar.revision!==proof.revision||scalar.payload_sha256!==proof.payload_sha256
    ||scalar.payload_bytes!==scalar.bytes||scalar.bytes<1||scalar.bytes>MAX_RECORD)corrupt('record differs from membership proof');
  charge(b,scalar.bytes);
  const {payload}=db.prepare('SELECT payload FROM current_room_records WHERE room_id=? AND domain=? AND record_key=?').get(roomId,domain,key);
  if(hash(payload)!==proof.payload_sha256)corrupt('record payload changed');
  const value=JSON.parse(payload);
  if(reusable){
    if(domain==='metadata'&&key==='room')reuse.ownerId=value.ownerId;
    if(reuse.authority.size>=3&&!reuse.authority.has(reuseKey))corrupt('work summary authority cache exceeded');
    reuse.authority.set(reuseKey,structuredClone(value));
  }
  return value;
}
function fieldsOf(state) {
  const out=new Map();
  for(const [key,value] of Object.entries(state)) {
    if(omitted.has(key))continue;
    if(maps.has(key)&&value!==null&&typeof value==='object'&&!Array.isArray(value)) {
      out.set(JSON.stringify(['shape',key]),'object');
      for(const [id,item] of Object.entries(value))out.set(JSON.stringify([key,id]),item);
    } else out.set(JSON.stringify(['metadata',key]),value);
  }
  return out;
}
function saveTransition(db,roomId,sequence,eventId,oldHead,changes,counts,{publishHead=true,initial=false}={}) {
  if(changes.length>128)refuse('Too many current metadata changes in one transition');
  const revision=(oldHead?.revision??-1)+1,head={room_id:roomId,sequence,event_id:eventId,revision,counts_json:JSON.stringify(counts)};
  const headHash=hash(JSON.stringify(headValue(head)));
  const tuples=[],writes=[];
  for(const {domain,key,value} of changes) {
    const prior=initial?undefined:db.prepare('SELECT revision FROM current_room_record_proofs WHERE room_id=? AND domain=? AND record_key=?').get(roomId,domain,key);
    const recordRevision=(prior?.revision??-1)+1,present=value===undefined?0:1,payload=present?JSON.stringify(value):'',digest=hash(payload);
    if(present&&(Buffer.byteLength(payload)>MAX_RECORD))refuse('Current metadata record exceeds bounded input');
    tuples.push([domain,key,recordRevision,present,digest]);writes.push({domain,key,recordRevision,present,payload,digest});
  }
  // A cleaned, unpublished generation may be recaptured at the same source
  // head. Bind the actual transition tuples, not only equal control counts.
  const receiptId='oa_current_'+hash(JSON.stringify([roomId,sequence,revision,headHash,oldHead?.receipt_id??null,tuples]));
  const saved=JSON.stringify({version:1,roomId,headHash,records:tuples});
  if(Buffer.byteLength(saved)>MAX_RECORD)refuse('Current transition receipt exceeds bounded input');
  if(initial){
    const records=writes.filter(row=>row.present).map(({domain,key,recordRevision,payload,digest})=>[roomId,domain,key,recordRevision,Buffer.byteLength(payload),digest,payload]);
    const proofs=writes.map(({domain,key,recordRevision,present,digest})=>[roomId,domain,key,recordRevision,present,digest,receiptId]);
    for(const [table,rows]of [['current_room_records',records],['current_room_record_proofs',proofs]])for(let offset=0;offset<rows.length;offset+=12){
      const batch=rows.slice(offset,offset+12);db.prepare(`INSERT INTO ${table} VALUES ${batch.map(row=>'('+row.map(()=>'?').join(',')+')').join(',')}`).run(...batch.flat());
    }
  }else{
  for(const {domain,key,recordRevision,present,payload,digest} of writes) {
    if(present)db.prepare(`INSERT INTO current_room_records VALUES(?,?,?,?,?,?,?) ON CONFLICT(room_id,domain,record_key)
      DO UPDATE SET revision=excluded.revision,payload_bytes=excluded.payload_bytes,payload_sha256=excluded.payload_sha256,payload=excluded.payload`)
      .run(roomId,domain,key,recordRevision,Buffer.byteLength(payload),digest,payload);
    else db.prepare('DELETE FROM current_room_records WHERE room_id=? AND domain=? AND record_key=?').run(roomId,domain,key);
    db.prepare(`INSERT INTO current_room_record_proofs VALUES(?,?,?,?,?,?,?) ON CONFLICT(room_id,domain,record_key)
      DO UPDATE SET revision=excluded.revision,present=excluded.present,payload_sha256=excluded.payload_sha256,receipt_id=excluded.receipt_id`)
      .run(roomId,domain,key,recordRevision,present,digest,receiptId);
  }
  }
  db.prepare('INSERT INTO operator_actions(id,at,action,target_kind,target_id,counts_json,result) VALUES(?,?,?,?,?,?,?)')
    .run(receiptId,Date.now(),'current_room_transition','room',roomId,saved,'committed');
  if(publishHead)db.prepare(`INSERT INTO current_room_head VALUES(?,1,?,?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET
    sequence=excluded.sequence,event_id=excluded.event_id,revision=excluded.revision,head_sha256=excluded.head_sha256,counts_json=excluded.counts_json,receipt_id=excluded.receipt_id`)
    .run(roomId,sequence,eventId,revision,headHash,head.counts_json,receiptId);
  return publishHead?serializeCurrentCarrier(revision,headHash):
    {...head,format_version:1,head_sha256:headHash,receipt_id:receiptId,counts:JSON.parse(head.counts_json)};
}
export function initializeCurrentRoom(store,state,events,{adoptExisting=null}={}) {
  const db=store.db,roomId=state.room.id;
  return withCurrentRoomWriter(db,roomId,()=>{
    // Fresh room or explicitly operator-authorized one-time current-state adoption.
    const existing=db.prepare('SELECT sequence FROM rooms WHERE id=?').get(roomId);
    if(adoptExisting){if(!existing||existing.sequence!==adoptExisting.sequence)throw Error('Current room adoption head changed');assertCurrentCandidateEmpty(store,roomId);}
    else if(existing)throw Error('Current room initialization requires a new room');
    const sequence=adoptExisting?.sequence??events.length,eventId=adoptExisting?.eventId??events.at(-1)?.id??'';
    assertLegacyWorkReconciled(db,roomId);
    if(!adoptExisting){
      db.prepare('INSERT INTO rooms(id,sequence,projection,archived_at) VALUES(?,?,?,NULL)').run(roomId,sequence,'{}');
      const insert=db.prepare('INSERT INTO events VALUES(?,?,?,?)');
      events.forEach((event,index)=>{insert.run(roomId,index+1,event.id,JSON.stringify(event));syncMessageRows(db,{roomId,sequence:index+1,event,state});});
    }
    const messageRows=adoptExisting?materializeCurrentMessageRows(db,roomId,state,{adoptAbsentInlineProofs:adoptExisting.adoptAbsentInlineProofs===true}):db.prepare('SELECT * FROM messages WHERE room_id=? ORDER BY seq,message_id').all(roomId);
    const rowById=new Map(messageRows.map(row=>[row.message_id,row]));
    for(const row of messageRows)if(!messageProofMatches(row))corrupt('initial canonical proof changed');
    if(messageRows.length!==state.messages.length+(state.messagesArchive?.count??0))corrupt('initial canonical membership differs');
    const referenced=referenceWorkItems(db,roomId,state,{enabled:true});
    const fields=fieldsOf(referenced);
    for(const [id,item] of Object.entries(state.workItems)) {
      fields.set(JSON.stringify(['workSummary',id]),currentWorkSummary(item,referenced.workItems[id]));
      fields.set(JSON.stringify(['workCapacity',id]),currentWorkCapacity(item));
    }
    const privacy=deriveWorkPrivacy(state);
    for(const [id,value] of privacy.privacy)fields.set(JSON.stringify(['workPrivacy',id]),value);
    for(const [key,value] of privacy.links)fields.set(JSON.stringify(['workRequest',key]),value);
    const counts={messages:messageRows.length,workItems:Object.keys(state.workItems).length,workCapacity:Object.keys(state.workItems).length,
      replyRequests:Object.keys(state.replyRequests??{}).length,members:Object.keys(state.members).length,roundLimitPauses:0,threadParticipants:0};
    for(const row of messageRows)fields.set(JSON.stringify(['messageWitness',row.message_id]),messageWitness(row));
    if(state.messagesArchive){
      const archive=state.messagesArchive;
      if(!Number.isSafeInteger(archive.count)||archive.count<0||!Number.isSafeInteger(archive.throughSeq)||!Array.isArray(archive.retainedIds))corrupt('invalid adoption archive');
      fields.set(JSON.stringify(['metadata','messagesArchive']),{version:1,throughSeq:archive.throughSeq,count:archive.count,retainedCount:archive.retainedIds.length});
      archive.retainedIds.forEach((id,index)=>fields.set(JSON.stringify(['archiveRetained',id]),index));
    }
    for(const message of state.messages){
      const row=rowById.get(message.id);if(!row)corrupt('initial canonical message missing');
      fields.set(JSON.stringify(['threadParticipants',(row.thread_root_id??message.id)+'\0'+message.authorId]),{threadRootId:row.thread_root_id??message.id,memberId:message.authorId});
    }
    counts.threadParticipants=[...fields.keys()].filter(key=>JSON.parse(key)[0]==='threadParticipants').length;
    counts.historyFloors=0;counts.historyExclusions=0;
    for(const memberId of Object.keys(state.members)) {
      fields.set(JSON.stringify(['historyFloors',memberId]),historyActivationTuple(db,roomId,memberId,sequence));counts.historyFloors++;
    }
    counts.metadataRecords=fields.size;counts.metadataProofs=fields.size;
    if(Object.values(state.workItems).some(item=>item.suspended_by==='round_limit'))refuse('Round-limit index is not yet qualified');
    const changes=[...fields].map(([address,value])=>{const [domain,key]=JSON.parse(address);return {domain,key,value};});
    let carrier,oldHead=null;
    for(let offset=0;offset<changes.length||offset===0;offset+=128) {
      carrier=saveTransition(db,roomId,sequence,eventId,oldHead,changes.slice(offset,offset+128),counts,{initial:true});
      oldHead={revision:(oldHead?.revision??-1)+1};
    }
    db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(carrier,roomId);
    // Existing integrity metadata protects the small marker; entity proofs stay
    // those produced by their code-owned repository writes above.
    store.ensureIntegrityRoomState();
    db.prepare('INSERT INTO integrity_room_state(room_id,sequence,projection_bytes,projection_hash,metadata_hash) VALUES(?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET sequence=excluded.sequence,projection_bytes=excluded.projection_bytes,projection_hash=NULL,metadata_hash=excluded.metadata_hash')
      .run(roomId,sequence,Buffer.byteLength(carrier),null,hash(carrier));
    return roomId;
  });
}
export function currentRoomAuthority(db,roomId,{memberId=null,activeOnly=false}={}) {
  const b=contextBudgets.get(db)??budget(),head=readCurrentHead(db,roomId,b);if(!head)return null;
  if(memberId!==null)return currentMemberAuthorityFromHead(db,roomId,head,b,memberId);
  return activeOnly?currentActiveAuthorityFromHead(db,roomId,head,b):currentAuthorityFromHead(db,roomId,head,b);
}
// Owner-only authority: protected head and room record, no member census.
// For callers that need only ownerId/sequence; cost is constant in member count.
export function currentRoomOwnerAuthority(db,roomId) {
  const b=contextBudgets.get(db)??budget(),head=readCurrentHead(db,roomId,b);if(!head)return null;
  const room=readCurrentRecord(db,roomId,'metadata','room',b);
  if(!room||!validId(room.ownerId))corrupt('missing owner authority');
  return {sequence:head.sequence,ownerId:room.ownerId};
}
// Explicit addressed authority: protected room/owner and this principal only.
// Default roster callers retain their full-census contract and budget.
function currentMemberAuthorityFromHead(db,roomId,head,b,memberId) {
  if(!validId(memberId))return {sequence:head.sequence,ownerId:null,members:{}};
  const room=readCurrentRecord(db,roomId,'metadata','room',b);
  if(!room||!validId(room.ownerId))corrupt('missing owner authority');
  const members={};
  for(const id of new Set([room.ownerId,memberId])) {
    const member=readCurrentRecord(db,roomId,'members',id,b);
    if(member!==undefined){
      if(member?.id!==id)corrupt('member authority identity differs');
      Object.defineProperty(members,id,{value:member,enumerable:true,writable:true,configurable:true});
    }
  }
  if(!Object.hasOwn(members,room.ownerId))corrupt('missing owner authority');
  return {sequence:head.sequence,ownerId:room.ownerId,members,historyVisibility:room.historyVisibility??null,historyDefaultsVersion:room.historyDefaultsVersion??null};
}
// Active-roster authority (W3200 R-01): the roster presence serves. The full
// census above counts TOTAL member records and refuses past 100, so a room
// that churned past 101 records (join, deactivate, replace) lost presence
// even at <=100 active members, although admission caps ACTIVE members at
// 100. This variant selects active records in SQL (bounded: at most 101 keys
// are ever read, deactivated records are never loaded or charged), then
// verifies each selected record through readCurrentRecord's proof/hash
// checks exactly like the census. The cap and refusal are unchanged: more
// than 100 ACTIVE members refuses with the census's error shape.
function currentActiveAuthorityFromHead(db,roomId,head,b) {
  const room=readCurrentRecord(db,roomId,'metadata','room',b);
  if(!room||!validId(room.ownerId))corrupt('missing owner authority');
  const keys=db.prepare(`SELECT r.record_key FROM current_room_records r
    JOIN current_room_record_proofs p ON p.room_id=r.room_id AND p.domain=r.domain AND p.record_key=r.record_key AND p.present=1
    WHERE r.room_id=? AND r.domain='members' AND COALESCE(json_extract(r.payload,'$.active'),1)!=0
    ORDER BY r.record_key LIMIT 101`).all(roomId);
  charge(b,keys.reduce((n,row)=>n+Buffer.byteLength(row.record_key)+32,0),keys.length);
  if(keys.length>100)refuse('Room authority requires bounded membership');
  const members={};
  for(const {record_key:key} of keys)Object.defineProperty(members,key,{value:readCurrentRecord(db,roomId,'members',key,b),enumerable:true,writable:true,configurable:true});
  if(!Object.hasOwn(members,room.ownerId)&&readCurrentRecord(db,roomId,'members',room.ownerId,b)===undefined)corrupt('missing owner authority');
  return {sequence:head.sequence,ownerId:room.ownerId,members,historyVisibility:room.historyVisibility??null,historyDefaultsVersion:room.historyDefaultsVersion??null};
}
function currentAuthorityFromHead(db,roomId,head,b) {
  const room=readCurrentRecord(db,roomId,'metadata','room',b);
  const members={};
  if(head.counts.members>100)refuse('Room authority requires bounded membership');
  const keys=db.prepare("SELECT record_key FROM current_room_record_proofs WHERE room_id=? AND domain='members' AND present=1 ORDER BY record_key LIMIT 101").all(roomId);
  charge(b,keys.reduce((n,row)=>n+Buffer.byteLength(row.record_key)+32,0),keys.length);
  if(keys.length!==head.counts.members)corrupt('complete member census differs');
  for(const {record_key:key} of keys)Object.defineProperty(members,key,{value:readCurrentRecord(db,roomId,'members',key,b),enumerable:true,writable:true,configurable:true});
  if(!room||!Object.hasOwn(members,room.ownerId))corrupt('missing owner authority');
  return {sequence:head.sequence,ownerId:room.ownerId,members,historyVisibility:room.historyVisibility??null,historyDefaultsVersion:room.historyDefaultsVersion??null};
}
export function readCurrentMessage(db,roomId,messageId,b=contextBudgets.get(db)??budget()) {
  if(!b.schemaVerified&&!readCurrentHead(db,roomId,b))corrupt('message namespace is not initialized');
  const witness=readCurrentRecord(db,roomId,'messageWitness',messageId,b);
  const scalar=db.prepare(`SELECT ${MESSAGE_PROOF_SELECT.split(',').map(key=>`length(CAST(${key} AS BLOB)) AS ${key}`).join(',')}
    FROM messages WHERE room_id=? AND message_id=?`).get(roomId,messageId);
  if(!scalar){if(witness!==undefined)corrupt('witnessed canonical message missing');return undefined;}
  if(!witness)corrupt('canonical message lacks independent membership witness');
  const bytes=Object.values(scalar).reduce((sum,value)=>sum+(value??0),0);
  if (bytes > CURRENT_MESSAGE_INPUT_BYTES || (b.messageBytes ?? 0) + bytes > CURRENT_MESSAGE_INPUT_BYTES)
    refuse('Canonical message dependencies exceed the shared bounded input reservation');
  let admittedMetadata;
  if (bytes > MAX_RECORD) {
    if ((scalar.body ?? 0) > 3 * MAX_MESSAGE_BODY_CHARS
      || (scalar.record_json ?? 0) > 6 * MAX_MESSAGE_BODY_CHARS + MAX_RECORD
      || (scalar.reducer_extras_json ?? 0) > 6 * MESSAGE_EDIT_HISTORY_LIMITS.totalChars + MAX_RECORD)
      refuse('Canonical message fields exceed bounded input');
    // Only scalar geometry crosses into JS before payload admission. The raw
    // cells already have a fixed ceiling; JSON traversal cannot scan history.
    const shape = db.prepare(`WITH valid AS MATERIALIZED (
      SELECT CASE WHEN json_valid(record_json) THEN record_json END AS record,
        CASE WHEN json_valid(reducer_extras_json) THEN reducer_extras_json END AS extras
      FROM messages WHERE room_id=? AND message_id=?),
      history AS MATERIALIZED (SELECT e.value,e.type FROM valid,json_each(extras,'$.editHistory') e)
      SELECT json_type(record) AS recordType,json_type(extras) AS extrasType,
        (SELECT count(*) FROM json_each(record) WHERE key='body') AS bodyKeys,
        json_type(record,'$.body') AS bodyType,
        CASE WHEN json_type(record,'$.body')='text' THEN length(CAST(json_quote(json_extract(record,'$.body')) AS BLOB))-2 ELSE 0 END AS bodyBytes,
        (SELECT count(*) FROM json_each(extras) WHERE key='editHistory') AS historyKeys,
        json_type(extras,'$.editHistory') AS historyType,
        (SELECT count(*) FROM history) AS historyCount,
        (SELECT coalesce(sum(CASE WHEN type='object' THEN
          CASE WHEN json_type(value,'$.body')='text' THEN length(CAST(json_quote(json_extract(value,'$.body')) AS BLOB))-2 ELSE 0 END ELSE 0 END),0) FROM history) AS historyBytes,
        (SELECT coalesce(max(CASE WHEN type='object' THEN
          CASE WHEN json_type(value,'$.body')='text' THEN length(CAST(json_quote(json_extract(value,'$.body')) AS BLOB))-2 ELSE 0 END ELSE 0 END),0) FROM history) AS historyMaxBytes,
        (SELECT count(*) FROM history WHERE CASE WHEN type='object' THEN
          (SELECT count(*) FROM json_each(history.value) WHERE key='body')>1
          OR coalesce(json_type(value,'$.body'),'null') NOT IN ('text','null') ELSE 1 END) AS invalidHistory
      FROM valid`).get(roomId, messageId);
    if (!shape || shape.recordType !== 'object' || shape.extrasType !== 'object'
      || shape.bodyKeys !== 1 || !['text', 'null'].includes(shape.bodyType)
      || shape.bodyBytes > 6 * MAX_MESSAGE_BODY_CHARS || shape.historyKeys > 1
      || shape.historyType != null && shape.historyType !== 'array'
      || shape.historyCount > MESSAGE_EDIT_HISTORY_LIMITS.entries || shape.invalidHistory
      || shape.historyMaxBytes > 6 * MESSAGE_EDIT_HISTORY_LIMITS.bodyChars
      || shape.historyBytes > 6 * (MESSAGE_EDIT_HISTORY_LIMITS.totalChars - shape.historyCount * MESSAGE_EDIT_HISTORY_LIMITS.entryOverheadChars))
      refuse('Canonical message history/shape exceeds bounded input');
    admittedMetadata = bytes - (scalar.body ?? 0) - shape.bodyBytes - shape.historyBytes;
    if (admittedMetadata < 0 || admittedMetadata > MAX_RECORD) refuse('Canonical message metadata exceeds bounded input');
    charge(b, admittedMetadata + 512, 2);
  } else charge(b,bytes+512);
  b.messageBytes = (b.messageBytes ?? 0) + bytes;
  const row=db.prepare(`SELECT ${MESSAGE_PROOF_SELECT},entity_hash FROM messages WHERE room_id=? AND message_id=?`).get(roomId,messageId);
  if(!messageProofMatches(row)||witness.sequence!==row.seq||witness.entityHash!==row.entity_hash
    ||witness.header!==undefined&&!isDeepStrictEqual(witness.header,messageHeader(row)))corrupt('message field proof changed');
  const value = decodeMessageEntity(row);
  if (admittedMetadata !== undefined) {
    const geometry = messageGeometry(row, value);
    if (geometry.bytes !== bytes || geometry.metadataBytes !== admittedMetadata) corrupt('message scalar geometry changed');
  }
  return {row,value};
}

const supported = new Set(['message.pinned','message.unpinned','member.sponsor_transferred','channel.created','work.public_set','capabilities.advertised','bond.propose','bond.accept','bond.decline','bond.revoke','bond.proposed','bond.activated','bond.revoked','dm.posted','claim.acquired','claim.renewed','claim.released','room.spend_pricing_set','room.spend_allowance_set','room.archived','room.exported','room.charter_updated','room.policy_set','room.trust_set','message.deleted','message.edited','work.superseded','ownership.transferred','reply_request.cancelled','reply_request.progressed','work_claim.updated','message.posted','work.proposed','work.accepted','work.started','work.completed','work.handoff_recorded','work.halt_cleared','work.blocked','work.blocker_resolved','verification.recorded','owner.decision_recorded']);
const contextBudgets = new WeakMap();
export function withCurrentServingWriter(db,roomId,operation) {
  if(!isCurrentRoom(db,roomId) && !db.prepare("SELECT 1 FROM current_room_record_proofs WHERE room_id=? AND domain='migrationFence' AND record_key='active' AND present=1").get(roomId))return operation();
  const previous=contextBudgets.get(db);if(!previous)contextBudgets.set(db,budget());
  try{return withCurrentRoomWriter(db,roomId,operation);}finally{if(!previous)contextBudgets.delete(db);}
}
// This existing side-table event is a reducer no-op except legacy default
// channel normalization. Consent authority stays in dm_consents, atomically
// committed with its sequenced receipt and the protected current head.
export function currentDmConsentEventContext(store,roomId) {
  const db=store.db,b=contextBudgets.get(db)??budget(),head=readCurrentHead(db,roomId,b);if(!head)return null;
  const authority=currentAuthorityFromHead(db,roomId,head,b),state=emptyRoomState();
  state.room=readCurrentRecord(db,roomId,'metadata','room',b);state.members=authority.members;
  const general=readCurrentRecord(db,roomId,'channels','general',b);if(general!==undefined)state.channels.general=general;
  bindCurrentRecordContext(state,{replyRequestCount:head.counts.replyRequests});
  return {room:{sequence:head.sequence,state},current:{head,before:fieldsOf(state),workRefs:new Map(),budget:b,messageRows:new Map()}};
}
// Keyset pages exclude expired claims in the owned expiry index. Each live
// summary has a fresh proof budget; only ten warnings and one conflict survive.
// Total work remains O(live claims) in this transaction, not constant CPU.
function currentClaimAdmission(store,roomId,actorId,item,command,b) {
  if(!item)return null;
  let admitted,atValue;
  const at=instant=>{
    if(!store.db.isTransaction)throw Error('Current claim scope expired');
    const value=typeof instant==='number'?new Date(instant).toISOString():instant;
    if(admitted&&value!==atValue)corrupt('claim admission instant changed');
    if(!admitted){atValue=value;admitted=currentClaimAdmissionAt(store,roomId,actorId,item,command,b,value);}
    return admitted;
  };
  return {overlaps(workId,repository,paths,instant){return at(instant).overlaps();},conflict(candidate,instant){return at(instant).conflict(candidate,instant);}};
}
function currentClaimAdmissionAt(store,roomId,actorId,item,command,b,instant) {
  const db=store.db,now=Date.parse(instant),receipts=new Map(),head=readCurrentHead(db,roomId,{...budget(),auditReceipts:receipts});
  const numeric=id=>/^(0|[1-9][0-9]*)$/.test(id)&&Number(id)<4294967295;
  const compare=(a,c)=>numeric(a.id)?numeric(c.id)?Number(a.id)-Number(c.id):-1:numeric(c.id)?1:a.sequence-c.sequence;
  const warningQuery=Array.isArray(command.data.paths)?prepareClaimOverlap(item.id,command.data.repository,command.data.paths,new Date(now).toISOString()):null;
  const candidate={id:item.id,claim:{...command.data,status:'active',holderId:actorId}},warnings=[];
  let selectedConflict=null,afterExpiry=now,afterKey=null,done=false;
  while(!done) {
    const pageBudget={...budget(),schemaVerified:true,auditReceipts:receipts};
    const rows=afterKey===null?[]:db.prepare(`SELECT record_key,json_extract(payload,'$.work.claim.expiresAtMs') expiry
      FROM current_room_records INDEXED BY current_native_claim_expiry
      WHERE room_id=? AND domain='workSummary' AND json_extract(payload,'$.work.claim.status')='active'
        AND json_extract(payload,'$.work.claim.expiresAtMs')=? AND record_key>?
      ORDER BY record_key LIMIT 32`).all(roomId,afterExpiry,afterKey);
    if(rows.length<32)rows.push(...db.prepare(`SELECT record_key,json_extract(payload,'$.work.claim.expiresAtMs') expiry
      FROM current_room_records INDEXED BY current_native_claim_expiry
      WHERE room_id=? AND domain='workSummary' AND json_extract(payload,'$.work.claim.status')='active'
        AND json_extract(payload,'$.work.claim.expiresAtMs')>?
      ORDER BY json_extract(payload,'$.work.claim.expiresAtMs'),record_key LIMIT ?`).all(roomId,afterExpiry,32-rows.length));
    charge(pageBudget,rows.reduce((n,row)=>n+Buffer.byteLength(row.record_key)+64,0),rows.length);
    for(const {record_key:id,expiry:indexExpiry} of rows) {
      const unit={...budget(),schemaVerified:true,auditReceipts:receipts};
      const work=readCurrentWorkSummaryForViewer(db,roomId,id,actorId,unit),expiry=Date.parse(work.claim?.expiresAt);
      if(work.claim?.status!=='active'||!Number.isFinite(expiry)||work.claim.expiresAtMs!==expiry||indexExpiry!==expiry||expiry<=now)corrupt('live claim index binding differs');
      const overlap=warningQuery?matchClaimOverlap(warningQuery,work):null;
      const conflict=warningQuery?conflictingClaim({[id]:work},candidate,now):null;
      if(overlap||conflict) {
        const opening=db.prepare("SELECT sequence,length(CAST(body AS BLOB)) bytes FROM events INDEXED BY current_native_work_proposals WHERE room_id=? AND json_extract(body,'$.type')='work.proposed' AND json_extract(body,'$.data.workItemId')=? ORDER BY sequence LIMIT 2").all(roomId,id);
        charge(unit,opening.length*256,opening.length);
        if(opening.length!==1||opening[0].bytes>MAX_RECORD)refuse('Live claim requires exact bounded original proposal evidence');
        charge(unit,opening[0].bytes);
        const event=JSON.parse(db.prepare('SELECT body FROM events WHERE room_id=? AND sequence=?').get(roomId,opening[0].sequence).body);
        if(event.type!=='work.proposed'||event.data?.workItemId!==id||event.actorId!==work.proposedById)corrupt('live claim proposal binding differs');
        const order={id,sequence:opening[0].sequence};
        if(overlap){warnings.push({...order,overlap});warnings.sort(compare);if(warnings.length>10)warnings.pop();}
        if(conflict&&(!selectedConflict||compare(order,selectedConflict)<0))selectedConflict={...order,work:conflict};
      }
      afterExpiry=indexExpiry;afterKey=id;
    }
    done=rows.length<32;
  }
  const final=readCurrentHead(db,roomId,{...budget(),auditReceipts:receipts});receipts.clear();
  if(!final||final.head_sha256!==head.head_sha256)corrupt('claim read head changed during scan');
  const previous=boardStateForWorkItem(item,now);
  if(previous==='unclaimed') {
    const size=db.prepare('SELECT length(CAST(config_json AS BLOB)) bytes FROM work_claim_config WHERE room_id=?').get(roomId);
    if(size?.bytes>MAX_RECORD)refuse('Native member capacity policy exceeds bounded input');charge(b,(size?.bytes??0)+256);
    const raw=size?JSON.parse(db.prepare('SELECT config_json FROM work_claim_config WHERE room_id=?').get(roomId).config_json):{};
    const {maxMemberOpenClaims:cap}=roomWorkClaimConfig({workClaims:raw});
    const fixed=db.prepare(`SELECT count(*) n FROM (SELECT 1 FROM current_room_records INDEXED BY current_native_work_held
      WHERE room_id=? AND domain='workSummary' AND json_extract(payload,'$.work.state') IN ('working','blocked')
        AND COALESCE(json_extract(payload,'$.work.claim.holderId'),json_extract(payload,'$.work.accountableMemberId'))=? LIMIT ?)`).get(roomId,actorId,cap).n;
    const timed=fixed>=cap?0:db.prepare(`SELECT count(*) n FROM (SELECT 1 FROM current_room_records INDEXED BY current_native_claim_held
      WHERE room_id=? AND domain='workSummary' AND json_extract(payload,'$.work.state')='accepted' AND json_extract(payload,'$.work.claim.status')='active'
        AND json_extract(payload,'$.work.claim.holderId')=? AND json_extract(payload,'$.work.claim.expiresAtMs')>? LIMIT ?)`).get(roomId,actorId,now,cap-fixed).n;
    charge(b,512);
    if(fixed+timed>=cap)throw new ServiceError(409,'too_many_open_claims',`You already hold ${cap} open claims. Release or finish one before claiming another.`);
  }
  return {
    overlaps(){return warnings.map(value=>value.overlap);},
    conflict(candidate,at){conflictingClaim({},candidate,at);return selectedConflict?.work??null;}
  };
}
export function currentCommandContext(store,roomId,command,{actorId}={}) {
  const db=store.db,b=contextBudgets.get(db)??budget(),head=readCurrentHead(db,roomId,b);if(!head)return null;
  if(['room.public_page_set','room.join_link_set','room.public_receipts_set'].includes(command.type))
    return currentInviteContext(store,roomId,{memberIds:[actorId],census:command.type==='room.public_page_set'&&command.data.enabled===true});
  // Membership additions and reactivation need the exact admitted roster for
  // capacity/name/authority checks, but no messages or unrelated work bodies.
  // Access deactivation changes members only. Held canonical work remains
  // untouched; credential, connection and reminder retirement stays in Store.
  if(command.type==='member.added'||command.type==='member.access_changed'&&command.data.active===true)
    return currentInviteContext(store,roomId,{memberIds:[actorId,command.data.memberId,command.data.referredBy],census:true});
  if(command.type==='member.access_changed'&&command.data.active===false)
    return currentInviteContext(store,roomId,{memberIds:[actorId,command.data.memberId]});
  return commandContextFromHead(store,roomId,command,head,b,{actorId});
}
function commandContextFromHead(store,roomId,command,head,b,{readMessage,readWork,actorId}={}) {
  const db=store.db;
  if(!supported.has(command.type))refuse('This command has no qualified current-record dependency plan');
  if(head.counts.roundLimitPauses!==0)refuse('Round-limit resume dependencies require qualification');
  if(command.type==='ownership.transferred'&&db.prepare('SELECT 1 FROM membership_delegation_grants WHERE room_id=? AND granted_by=? AND revoked_at IS NULL AND added_invite_member=1 LIMIT 1').get(roomId,actorId))
    refuse('Revoke membership delegation before transferring this current Room; its permission-strip dependencies require qualification');
  if(store.messageProjectionWindow!==null)refuse('Legacy automatic archive mode is not a current-record writer');
  if(db.prepare('SELECT 1 FROM activity_fanout_failures WHERE room_id=? AND recovered_at IS NULL LIMIT 1').get(roomId))
    refuse('Pending activity recovery requires an addressed recovery context');
  // Mention labels include display/identity aliases and longest-match ties.
  // Only that semantic path needs the full roster; never infer its actor from
  // caller-supplied command fields. Live and durable replay pass trusted actors.
  const fullRoster=command.type==='message.posted'&&typeof command.data.body==='string'&&command.data.body.includes('@');
  const state=emptyRoomState();
  state.members=fullRoster?currentAuthorityFromHead(db,roomId,head,b).members:currentMemberAuthorityFromHead(db,roomId,head,b,actorId).members;
  const keys=db.prepare("SELECT domain,record_key FROM current_room_record_proofs WHERE room_id=? AND domain IN ('metadata','shape') AND present=1 ORDER BY domain,record_key LIMIT 33").all(roomId);
  if(keys.length>32)refuse('Current metadata shape exceeds bounded context');charge(b,keys.length*256,keys.length);
  for(const {domain,record_key:key} of keys) {
    const value=readCurrentRecord(db,roomId,domain,key,b);
    if(domain==='metadata')state[key]=value;
    else {if(!maps.has(key)||value!=='object')corrupt('unsupported map shape');state[key]??={};}
  }
  if(!state.room||state.room.id!==roomId)corrupt('missing room singleton');
  if(state.room.publicReceipts?.enabled||state.room.starterSeeded)
    refuse('Published/starter room dependencies require qualification');
  const assistantScalar=db.prepare('SELECT length(CAST(value AS BLOB)) bytes FROM room_assistant_config WHERE room_id=?').get(roomId);
  if(assistantScalar&&(!Number.isSafeInteger(assistantScalar.bytes)||assistantScalar.bytes<2||assistantScalar.bytes>4096))refuse('Assistant configuration exceeds bounded context');
  if(assistantScalar)charge(b,assistantScalar.bytes+128);
  if(assistantScalar)verifyRoomAssistantIndexes(db);
  const assistant=assistantScalar?JSON.parse(db.prepare('SELECT value FROM room_assistant_config WHERE room_id=?').get(roomId).value):null;
  if(assistant?.coordinatorMemberId!==null&&assistant?.coordinatorMemberId!==undefined&&!validId(assistant.coordinatorMemberId))corrupt('assistant coordinator identity differs');
  if(store.humanPush?.vapid)refuse('Human push visibility dependencies require qualification');
  const messages=new Map(),workRefs=new Map();
  const loadMessage=id=>{
    if(!id||messages.has(id)&&!messages.get(id).headerOnly)return messages.get(id);
    const source=readMessage?readMessage(id,b):readCurrentMessage(db,roomId,id,b);if(source)messages.set(id,source);return source;
  };
  const wantedMessages=[command.data.messageId??command.id,`${command.data.messageId??command.id}:channel`,
    command.data.sourceMessageId,command.data.evidenceMessageId,command.data.requestMessageId,command.data.progressMessageId];
  for(const id of wantedMessages)if(typeof id==='string')loadMessage(id);
  let cursor = command.data.replyToId ?? (['message.edited','message.pinned','message.unpinned'].includes(command.type)?command.data.messageId:command.type==='message.deleted'?messages.get(command.data.messageId)?.value.replyToId:null), childSeq = Number.MAX_SAFE_INTEGER;
  for(let depth=0;cursor;depth++) {
    if(depth>=32)refuse('Reply ancestry exceeds bounded context');
    const source=messages.get(cursor)??(readMessage?loadMessage(cursor):readCurrentMessageHeader(db,roomId,cursor,b));if(!source)break;
    if(!messages.has(cursor))messages.set(cursor,source);
    if(source.row.seq>=childSeq)corrupt('reply ancestry is cyclic or out of order');childSeq=source.row.seq;
    const request=readCurrentRecord(db,roomId,'replyRequests',cursor,b);
    if(request!==undefined)(state.replyRequests??={})[cursor]=request;
    cursor=source.value.replyToId;
  }
  if(command.data.responseToRequestId) {
    const id=command.data.responseToRequestId;
    const request=readCurrentRecord(db,roomId,'replyRequests',id,b);if(request!==undefined)(state.replyRequests??={})[id]=request;
  }
  let selectedRequest;
  if(['reply_request.cancelled','reply_request.progressed'].includes(command.type)&&typeof command.data.requestMessageId==='string'){
    const id=command.data.requestMessageId;selectedRequest=readCurrentRecord(db,roomId,'replyRequests',id,b);
    if(selectedRequest!==undefined){
      const opening=loadMessage(id);
      if(selectedRequest.id!==id||!opening||opening.value.authorId!==selectedRequest.requesterId||opening.value.toMemberId!==selectedRequest.recipientId)corrupt('selected request opening binding differs');
      (state.replyRequests??={})[id]=selectedRequest;
    }
  }
  const workId=command.data.workItemId??selectedRequest?.workItemId??(['message.deleted','message.edited'].includes(command.type)?messages.get(command.data.messageId)?.value.workItemId:null);
  // Supersession compares two existing canonical contracts. Load both exact
  // protected references; the shared reducer retains all ancestry/role rules.
  const workIds = new Set([workId, ...(command.type === 'work.superseded' ? [command.data.supersededByWorkItemId] : [])]);
  for (const workId of workIds) if(typeof workId==='string') {
    const ref=readCurrentRecord(db,roomId,'workItems',workId,b);
    if(ref!==undefined) {
      let row;
      if(readWork)row=readWork(workId,b);else {
        const scalar=db.prepare('SELECT length(CAST(body AS BLOB)) AS bytes FROM work_entities WHERE room_id=? AND work_id=?').get(roomId,workId);
        if(!scalar||scalar.bytes>MAX_RECORD)corrupt('missing or oversized work payload');charge(b,scalar.bytes+256);
        row=db.prepare('SELECT revision,digest,body FROM work_entities WHERE room_id=? AND work_id=?').get(roomId,workId);
      }
      if(!row)corrupt('missing candidate work payload');
      if(ref._workEntity!==1||ref.id!==workId||ref.revision!==row.revision||ref.digest!==row.digest||hash(row.body)!==ref.digest)
        corrupt('work membership reference differs');
      const item=JSON.parse(row.body);if(item.id!==workId||item.revision!==ref.revision)corrupt('work payload identity differs');
      state.workItems[workId]=item;workRefs.set(workId,ref);
    }
  }
  if(selectedRequest?.workItemId&&!workRefs.has(selectedRequest.workItemId))corrupt('selected request work reference missing');
  const channelIds=new Set(['general',command.data.channelId,...[...messages.values()].map(m=>m.value.channelId)]);
  if(command.type==='channel.created') {
    // Creation checks both the total channel cap and name uniqueness. Admit
    // the complete, bounded catalog before the shared reducer can write.
    const channels=db.prepare("SELECT record_key FROM current_room_record_proofs WHERE room_id=? AND domain='channels' AND present=1 ORDER BY record_key LIMIT 51").all(roomId);
    if(channels.length>50)refuse('Current channel catalog exceeds its supported capacity');
    charge(b,channels.reduce((sum,row)=>sum+Buffer.byteLength(row.record_key)+32,0),channels.length);
    for(const row of channels)channelIds.add(row.record_key);
  }
  for(const id of channelIds)if(typeof id==='string') {
    const channel=readCurrentRecord(db,roomId,'channels',id,b);if(channel!==undefined)state.channels[id]=channel;
  }
  if(!fullRoster) {
    const ids=new Set([actorId,state.room.ownerId,assistant?.coordinatorMemberId,command.data.memberId,command.data.toMemberId,
      command.data.accountableMemberId,command.data.verifierMemberId,command.data.humanDecisionMakerId,command.data.producerId]);
    for(const source of messages.values()){ids.add(source.value.authorId);ids.add(source.value.toMemberId);}
    for(const request of Object.values(state.replyRequests??{})){ids.add(request.requesterId);ids.add(request.recipientId);}
    for(const item of Object.values(state.workItems))for(const id of [item.accountableMemberId,item.verifierMemberId,item.humanDecisionMakerId,
      item.proposedById,item.claim?.holderId,item.receipt?.producerId,item.receipt?.reportedById,item.handoff?.triageMemberId])ids.add(id);
    for(const id of ids)if(typeof id==='string'&&validId(id)&&!Object.hasOwn(state.members,id)){
      const member=readCurrentRecord(db,roomId,'members',id,b);
      if(member!==undefined){if(member?.id!==id)corrupt('command member identity differs');Object.defineProperty(state.members,id,{value:member,enumerable:true,writable:true,configurable:true});}
    }
  }
  const haltIds=new Set([actorId]);
  if(command.type==='work.halt_cleared'&&typeof command.data.memberId==='string')haltIds.add(command.data.memberId);
  for(const id of haltIds) {
    if(typeof id!=='string'||!validId(id))continue;
    const halt=readCurrentRecord(db,roomId,'agentHalts',id,b);
    if(halt!==undefined)(state.agentHalts??={})[id]=halt;
  }
  // Shared reducers see the complete addressed ancestry in original order.
  state.messages=[...messages.values()].sort((a,b)=>a.row.seq-b.row.seq||Buffer.compare(Buffer.from(a.value.id),Buffer.from(b.value.id))).map(source=>source.value);
  const claims=command.type==='claim.acquired'?currentClaimAdmission(store,roomId,actorId,state.workItems[workId],command,b):null;
  bindCurrentRecordContext(state,{replyRequestCount:head.counts.replyRequests,...(claims?{claimOverlaps:claims.overlaps}:{})});
  const before=fieldsOf({...state,workItems:Object.fromEntries(workRefs)});
  // A live proposal chooses its receipt ID in Bonds.prepare, after this
  // context exists. Bind that exact protected record before the reducer and
  // before diffing; accepting/revoking must retain the prior proposal fields.
  const loadedBonds = new Set();
  const loadBond = id => {
    if(loadedBonds.has(id))return;
    loadedBonds.add(id);
    if(typeof id!=='string'||!id)return;
    const prior=readCurrentRecord(db,roomId,'bonds',id,b);
    if(prior!==undefined){
      if(prior.id!==id)corrupt('selected bond identity differs');
      (state.bonds??={})[id]=prior;
      before.set(JSON.stringify(['shape','bonds']),'object');
      before.set(JSON.stringify(['bonds',id]),prior);
    }
  };
  if(['bond.accept','bond.decline','bond.revoke','bond.proposed','bond.activated','bond.revoked'].includes(command.type))loadBond(command.data.bondId);
  return {room:{sequence:head.sequence,state},current:{head,before,workRefs,budget:b,messageRows:messages,loadBond,...(claims?{claimConflict:claims.conflict}:{})},count:head.counts.messages};
}
// Trusted invitation/referral writers use the same protected current facts and
// transition writer. A name/capacity decision admits the bounded full roster;
// ordinary invitation reads and retries need only their exact principals.
export function currentInviteContext(store, roomId, { memberIds = [], census = false } = {}) {
  return store.readTransaction(() => withCurrentReadContext(store.db, roomId, b => {
    const db = store.db, head = readCurrentHead(db, roomId, b);
    if (!head) return null;
    const state = emptyRoomState();
    state.members = census ? currentAuthorityFromHead(db, roomId, head, b).members : {};
    const keys = db.prepare("SELECT domain,record_key FROM current_room_record_proofs WHERE room_id=? AND domain IN ('metadata','shape') AND present=1 ORDER BY domain,record_key LIMIT 33").all(roomId);
    if (keys.length > 32) refuse('Current metadata shape exceeds bounded context');
    charge(b, keys.length * 256, keys.length);
    for (const { domain, record_key: key } of keys) {
      const value = readCurrentRecord(db, roomId, domain, key, b);
      if (domain === 'metadata') state[key] = value;
      else { if (!maps.has(key) || value !== 'object') corrupt('unsupported map shape'); state[key] ??= {}; }
    }
    if (!state.room || state.room.id !== roomId) corrupt('missing room singleton');
    const general = readCurrentRecord(db, roomId, 'channels', 'general', b);
    if (general !== undefined) state.channels.general = general;
    for (const id of new Set([state.room.ownerId, ...memberIds])) {
      if (typeof id !== 'string' || !validId(id) || Object.hasOwn(state.members, id)) continue;
      const member = readCurrentRecord(db, roomId, 'members', id, b);
      if (member !== undefined) { if (member.id !== id) corrupt('invitation member identity differs'); state.members[id] = member; }
    }
    return { room: { sequence: head.sequence, state }, current: { head, before: fieldsOf(state), workRefs: new Map(), budget: b, messageRows: new Map() } };
  }, { maxRecords: census ? 1024 : 200 }));
}
// Exceptional owner merge: complete bounded work-summary census, indexed
// affected canonical messages and their exact ancestors. Never a sparse merge.
export function currentPairingMergeContext(store, roomId, {actorId,keptMemberId,retiredMemberId}) {
  return store.readTransaction(() => withCurrentReadContext(store.db,roomId,b=>{
    const context=currentInviteContext(store,roomId,{memberIds:[actorId,keptMemberId,retiredMemberId]});
    if(!context)return null;
    const db=store.db,{state}=context.room,{head}=context.current,refs=new Map(),messages=new Map(),nativeEvidence=new Set();
    const keys=db.prepare("SELECT record_key FROM current_room_record_proofs WHERE room_id=? AND domain='workSummary' AND present=1 ORDER BY record_key LIMIT 33").all(roomId);
    if(keys.length>32)refuse('Member merge exceeds bounded complete work census');
    if(keys.length!==head.counts.workItems)corrupt('merge work census differs');
    charge(b,keys.length*256,keys.length);
    for(const {record_key:id} of keys) {
      const summary=readCurrentRecord(db,roomId,'workSummary',id,b);
      if(!summary||summary.work?.id!==id)corrupt('merge summary identity differs');
      const item=readCurrentWorkFromVerifiedHead(db,roomId,id,b);
      const ref=readCurrentRecord(db,roomId,'workItems',id,b);
      if(!item||!isDeepStrictEqual(summary,currentWorkSummary(item,ref)))corrupt('merge summary differs from work');
      // Historical producers and post envelope bindings are immutable. The
      // legacy merge reducer cannot rewrite their cited canonical authors.
      for(const receipt of [...(item.receiptHistory??[]),item.receipt])if(receipt?.nativeText)nativeEvidence.add(receipt.nativeText.messageId);
      if(![item.accountableMemberId,item.verifierMemberId,item.claim?.holderId].includes(retiredMemberId))continue;
      state.workItems[id]=item;refs.set(id,ref);
    }
    const touched=new Set();
    for(const column of ['author_id','to_member_id']) {
      const rows=db.prepare(`SELECT message_id FROM messages WHERE room_id=? AND ${column}=? LIMIT 33`).all(roomId,retiredMemberId);
      if(rows.length>32)refuse('Member merge exceeds bounded affected messages');
      charge(b,rows.length*256,rows.length);
      for(const row of rows)touched.add(row.message_id);
    }
    if(touched.size>32)refuse('Member merge exceeds bounded affected messages');
    if([...touched].some(id=>nativeEvidence.has(id)))refuse('Member merge would change saved native text evidence; reconnect the existing seat instead');
    const load=id=>{if(!messages.has(id)){const source=readCurrentMessage(db,roomId,id,b);if(!source)corrupt('merge message missing');messages.set(id,source);}return messages.get(id);};
    for(const id of touched) {
      let source=load(id),depth=0;
      while(source.value.replyToId) {
        if(++depth>32)refuse('Merge reply ancestry exceeds bounded context');
        const parent=load(source.value.replyToId);
        if(parent.row.seq>=source.row.seq)corrupt('merge reply ancestry differs');source=parent;
      }
    }
    state.messages=[...messages.values()].map(source=>source.value);
    // Bound complete side-row namespaces before the legacy atomic UPDATEs.
    // Multiple explicitly merged identities may alias one surviving member.
    for(const [table,key] of [['identity_links','identity_id'],['agent_member_keys','public_key']]) {
      const rows=db.prepare(`SELECT length(CAST(${key} AS BLOB))+length(CAST(member_id AS BLOB)) AS bytes FROM ${table} WHERE room_id=? ORDER BY ${key} LIMIT 101`).all(roomId);
      if(rows.length>100)refuse('Member merge exceeds bounded identity/key aliases');
      for(const row of rows){if(row.bytes>MAX_RECORD)refuse('Merge alias exceeds bounded input');charge(b,row.bytes+64);}
    }
    const legacy=db.prepare('SELECT claim_id,length(CAST(item_json AS BLOB)) AS bytes FROM work_claims WHERE room_id=? LIMIT 33').all(roomId);
    if(legacy.length>32)refuse('Member merge exceeds bounded historical claim rows');
    const legacyClaims=[];
    for(const row of legacy){if(row.bytes>MAX_RECORD)refuse('Historical claim exceeds merge input');charge(b,row.bytes+256);legacyClaims.push(db.prepare('SELECT claim_id,item_json FROM work_claims WHERE room_id=? AND claim_id=?').get(roomId,row.claim_id));}
    return {room:context.room,current:{...context.current,budget:b,before:fieldsOf({...state,workItems:Object.fromEntries(refs)}),workRefs:refs,messageRows:messages,
      merge:{keptMemberId,retiredMemberId,touched,legacyClaims}}};
  }));
}
export function prepareCurrentWrite(store,{roomId,previous,state,event,sequence,current}) {
  const db=store.db,refs={},workWrites=[];
  const affected = new Set(affectedMessageIds(event));
  for (const [id, source] of current.messageRows) if (source.headerOnly) {
    if (affected.has(id) || !isDeepStrictEqual(source.value, state.messages.find(message => message.id === id)))
      corrupt('header-only dependency cannot be mutated or persisted');
  }
  for(const [id,item] of Object.entries(state.workItems)) {
    const body=JSON.stringify(item),digest=hash(body),prior=current.workRefs.get(id);
    refs[id]={_workEntity:1,id,revision:item.revision,digest};
    if(!isDeepStrictEqual(refs[id],prior))workWrites.push({id,item,body,digest});
  }
  const after=fieldsOf({...state,workItems:refs}),changes=[];
  for(const {id,item} of workWrites) {
    assertCurrentWorkCapacity(store,roomId,current.head,previous.state.workItems[id],item,Date.parse(event.at),bytes=>charge(current.budget,bytes));
    changes.push({domain:'workSummary',key:id,value:currentWorkSummary(item,refs[id])},{domain:'workCapacity',key:id,value:currentWorkCapacity(item)});
  }
  for(const key of new Set([...current.before.keys(),...after.keys()]))if(!isDeepStrictEqual(current.before.get(key),after.get(key))) {
    const [domain,id]=JSON.parse(key);changes.push({domain,key:id,value:after.get(key)});
  }
  const privacyChanges=new Map(),linkChanges=new Map();
  const privacyFor=id=>{if(!privacyChanges.has(id)){const value=readCurrentRecord(db,roomId,'workPrivacy',id,current.budget);if(value===undefined&&current.workRefs.has(id))corrupt('missing work privacy qualification');privacyChanges.set(id,{before:value,value:value??emptyWorkPrivacy()});}return privacyChanges.get(id);};
  for(const {id} of workWrites)privacyFor(id);
  for(const change of changes.filter(change=>change.domain==='replyRequests')) {
    const before=readCurrentRecord(db,roomId,'replyRequests',change.key,current.budget);
    if(!isDeepStrictEqual(before,current.before.get(JSON.stringify(['replyRequests',change.key]))))corrupt('unloaded private request effect');
    for(const [request,delta] of [[before,-1],[change.value,1]])if(typeof request?.workItemId==='string'&&request.workItemId) {
      const id=request.workItemId,entry=privacyFor(id);entry.value=applyWorkPrivacyRequest(entry.value,request,delta);
      linkChanges.set(workRequestKey(id,change.key),delta===1?workRequestValue(id,change.key):undefined);
    }
  }
  for(const [id,entry] of privacyChanges)if(!isDeepStrictEqual(entry.before,entry.value))changes.push({domain:'workPrivacy',key:id,value:entry.value});
  for(const [key,value] of linkChanges)if(!isDeepStrictEqual(readCurrentRecord(db,roomId,'workRequest',key,current.budget),value))changes.push({domain:'workRequest',key,value});
  const counts={...current.head.counts};
  const joinedId=event.data?.memberId;
  if(typeof joinedId==='string' && (event.type==='member.added'||event.type==='member.joined_via_invitation'
    || event.type==='member.access_changed'&&event.data.active===true&&!previous.state.members[joinedId]?.active)) {
    const prior=readCurrentRecord(db,roomId,'historyFloors',joinedId,current.budget);
    changes.push({domain:'historyFloors',key:joinedId,value:historyActivationValue({sequence,at:event.at})});
    if(prior===undefined)counts.historyFloors++;
  }

  if(event.type==='message.posted') {
    const added=state.messages.filter(message=>!previous.state.messages.some(old=>old.id===message.id));
    for(const message of added) {
      const row=messageRowForWrite(message,{sequence,pinned:(state.pins??[]).some(pin=>pin.messageId===message.id),threadMessages:new Map(state.messages.map(m=>[m.id,m]))});
      admitCanonicalMessageWrite(row, current);
      changes.push({domain:'messageWitness',key:message.id,value:messageWitness(row)});
      let root=message;const seen=new Set();
      while(root.replyToId) {if(seen.has(root.id))corrupt('new reply cycle');seen.add(root.id);const parent=state.messages.find(m=>m.id===root.replyToId);if(!parent)corrupt('unloaded reply ancestor');root=parent;}
      const key=root.id+'\0'+message.authorId;
      const member=readCurrentRecord(db,roomId,'threadParticipants',key,current.budget);
      if(member===undefined&&!changes.some(change=>change.domain==='threadParticipants'&&change.key===key)) {
        changes.push({domain:'threadParticipants',key,value:{threadRootId:root.id,memberId:message.authorId}});counts.threadParticipants++;
      }
    }
  }
  if(['message.redacted','message.edited','message.pinned','message.unpinned','member.merged'].includes(event.type))for(const message of state.messages) {
    const source=current.messageRows.get(message.id);
    const pinChanged=source&&['message.pinned','message.unpinned'].includes(event.type)&&message.id===event.data.messageId
      &&(state.pins??[]).some(pin=>pin.messageId===message.id)!==(source.row.pinned===1);
    if(!source||(isDeepStrictEqual(message,source.value)&&!pinChanged))continue;
    const row=messageRowForWrite(message,{sequence:source.row.seq,pinned:event.type==='member.merged'?source.row.pinned===1:(state.pins??[]).some(pin=>pin.messageId===message.id),threadMessages:new Map(state.messages.map(m=>[m.id,m]))});
    admitCanonicalMessageWrite(row, current);
    changes.push({domain:'messageWitness',key:message.id,value:messageWitness(row)});
  }
  if(current.merge) {
    const roots=new Set([...current.merge.touched].map(id=>current.messageRows.get(id).row.thread_root_id??id));
    for(const root of roots) {
      const oldKey=root+'\0'+current.merge.retiredMemberId,newKey=root+'\0'+current.merge.keptMemberId;
      const old=readCurrentRecord(db,roomId,'threadParticipants',oldKey,current.budget);
      const kept=readCurrentRecord(db,roomId,'threadParticipants',newKey,current.budget);
      // Only authored messages contribute; recipient-only changes have no participant effect.
      if(old!==undefined){changes.push({domain:'threadParticipants',key:oldKey,value:undefined});counts.threadParticipants--;if(kept===undefined){changes.push({domain:'threadParticipants',key:newKey,value:{threadRootId:root,memberId:current.merge.keptMemberId}});counts.threadParticipants++;}}
    }
  }
  counts.messages+=state.messages.length-previous.state.messages.length;
  for(const domain of ['workItems','replyRequests','members'])for(const change of changes.filter(c=>c.domain===domain)) {
    const existed=current.before.has(JSON.stringify([domain,change.key]));
    counts[domain]+=(change.value===undefined?-1:existed?0:1);
  }
  counts.workCapacity=counts.workItems;
  for(const change of changes) {
    const proof=db.prepare('SELECT present FROM current_room_record_proofs WHERE room_id=? AND domain=? AND record_key=?').get(roomId,change.domain,change.key);
    counts.metadataRecords+=(change.value===undefined?0:1)-(proof?.present??0);
    if(!proof)counts.metadataProofs++;
  }
  for(const value of Object.values(counts))if(!Number.isSafeInteger(value)||value<0)corrupt('invalid qualified count effect');
  if(current.merge&&changes.length>128)refuse('Member merge exceeds bounded metadata transition');
  const nextHead={room_id:roomId,sequence,event_id:event.id,revision:current.head.revision+1,counts_json:JSON.stringify(counts)};
  const headHash=hash(JSON.stringify(headValue(nextHead)));
  const projection=serializeCurrentCarrier(nextHead.revision,headHash);
  if(!current.candidate)recordProjectionWrite(db,roomId,projection);
  const receiptBytesUpperBound=Buffer.byteLength(JSON.stringify({version:1,roomId,headHash,records:changes.map(({domain,key,value})=>[domain,key,Number.MAX_SAFE_INTEGER,value===undefined?0:1,'f'.repeat(64)])}));
  return {projection,receiptBytesUpperBound,retainedMessageIds:[],persistEntities(){
    if(current.candidate) {
      for(const row of workWrites)current.candidate.writeWork(row);
      current.candidate.writeMessages(previous.state,state,event,sequence);
      current.candidate.head=saveTransition(db,roomId,sequence,event.id,current.head,changes,counts,{publishHead:false});
      return;
    }
    for(const {id,item,body,digest} of workWrites)db.prepare(`INSERT INTO work_entities VALUES(?,?,?,?,?) ON CONFLICT(room_id,work_id)
      DO UPDATE SET revision=excluded.revision,digest=excluded.digest,body=excluded.body`).run(roomId,id,item.revision,digest,body);
    if(current.merge)for(const id of current.merge.touched) {
      const source=current.messageRows.get(id),message=state.messages.find(value=>value.id===id);
      const row=messageRowForWrite(message,{sequence:source.row.seq,pinned:source.row.pinned===1,threadMessages:new Map(state.messages.map(value=>[value.id,value]))});
      assertMessageWrite(db,roomId,id);
      db.prepare('UPDATE messages SET '+MESSAGE_PROOF_FIELDS.filter(key=>key!=='message_id').map(key=>key+'=?').join(',')+' WHERE room_id=? AND message_id=?')
        .run(...MESSAGE_PROOF_FIELDS.filter(key=>key!=='message_id').map(key=>row[key]),roomId,id);
      recordMessageWrite(db,roomId,id);
    }
    syncMessageRows(db,{roomId,sequence,event,state});
    const saved=saveTransition(db,roomId,sequence,event.id,current.head,changes,counts);
    if(saved!==projection)corrupt('prepared carrier differs from committed head');
    syncCurrentRoomPublication(store,{roomId,previous:previous.state,state,event,changes,current,charge:bytes=>charge(current.budget,bytes)});
  }};
}

export function currentThreadParticipants(db,roomId,rootId) {
  const b=contextBudgets.get(db)??budget(),prefix=rootId+'\0',upper=rootId+'\u0001';
  const rows=db.prepare("SELECT record_key FROM current_room_record_proofs WHERE room_id=? AND domain='threadParticipants' AND record_key>=? AND record_key<? AND present=1 ORDER BY record_key LIMIT 101")
    .all(roomId,prefix,upper);
  if(rows.length>100)refuse('Thread participant census exceeds bounded fanout');charge(b,rows.length*256,rows.length);
  return rows.map(({record_key:key})=>{const value=readCurrentRecord(db,roomId,'threadParticipants',key,b);
    if(!value||value.threadRootId!==rootId||key!==rootId+'\0'+value.memberId)corrupt('thread participant identity differs');return value.memberId;});
}

export function readCurrentWorkItem(db,roomId,id,b=contextBudgets.get(db)??budget()) {
  const head=readCurrentHead(db,roomId,b);if(!head)return null;
  return readCurrentWorkFromVerifiedHead(db,roomId,id,b);
}
function readCurrentWorkFromVerifiedHead(db,roomId,id,b) {
  const ref=readCurrentRecord(db,roomId,'workItems',id,b);if(ref===undefined)return null;
  const scalar=db.prepare('SELECT length(CAST(body AS BLOB)) AS bytes FROM work_entities WHERE room_id=? AND work_id=?').get(roomId,id);
  if(!scalar||scalar.bytes>MAX_RECORD)corrupt('missing or oversized work payload');charge(b,scalar.bytes+256);
  const row=db.prepare('SELECT revision,digest,body FROM work_entities WHERE room_id=? AND work_id=?').get(roomId,id);
  if(ref._workEntity!==1||ref.id!==id||ref.revision!==row.revision||ref.digest!==row.digest||hash(row.body)!==ref.digest)corrupt('work reference changed');
  const item=JSON.parse(row.body);if(item.id!==id||item.revision!==ref.revision)corrupt('work identity changed');return item;
}

// One synchronous, consistent head/schema snapshot for a complete work fold.
// Each addressed item keeps the original fresh input budget and independent
// reference/body proofs. Only four immutable receipts may be shared in this TX.
export function withCurrentWorkReadUnits(store,roomId,operation) {
  const db=store.db;
  if(!db.isTransaction)throw Error('Current work units require an existing transaction');
  const receipts=new Map(),initial={...budget(),auditReceipts:receipts};
  const head=readCurrentHead(db,roomId,initial);
  if(!head)refuse('Current work units require a normalized room');
  const expectedHead=head.head_sha256,verifiedHead=Object.freeze({...head,counts:Object.freeze({...head.counts})});
  let active=true;
  const assertActive=()=>{if(!active||!db.isTransaction)throw Error('Current work unit scope expired');};
  try {
    const result=operation({head:verifiedHead,work:id=>{
      assertActive();
      return readCurrentWorkFromVerifiedHead(db,roomId,id,{...budget(),schemaVerified:true,auditReceipts:receipts});
    }});
    if(result?.then)throw Error('Current work units must remain synchronous');
    assertActive();
    const final=readCurrentHead(db,roomId,{...budget(),auditReceipts:receipts});
    if(!final||final.head_sha256!==expectedHead)corrupt('work read head changed during fold');
    return result;
  } finally {active=false;receipts.clear();}
}

// Three separately indexed visibility streams avoid scanning private history
// while constructing a public window. Only admitted scalars cross before rows.
export function currentMessageMayBeVisible(db,roomId,messageId,viewerId,b=contextBudgets.get(db)??budget(),floor=null) {
  const candidate=db.prepare("SELECT CASE WHEN length(CAST(created_at AS BLOB))<=128 THEN created_at END AS at FROM messages WHERE room_id=? AND message_id=? AND (to_member_id IS NULL OR to_member_id='' OR author_id=? OR to_member_id=?)").get(roomId,messageId,viewerId,viewerId);
  charge(b,256);
  if(candidate){
    // This scalar can only deny. Long dates proceed to the
    // authoritative reader; never infer visibility from an unverified index.
    if(floor&&typeof candidate.at==='string'&&!messageInHistory({id:messageId,createdAt:candidate.at},floor))return false;
    return true;
  }
  const exists=db.prepare('SELECT 1 FROM messages WHERE room_id=? AND message_id=?').get(roomId,messageId);charge(b,256);
  if(!exists&&readCurrentRecord(db,roomId,'messageWitness',messageId,b)!==undefined)corrupt('witnessed canonical message missing');
  return false;
}
export function currentConversationRows(store,roomId,{viewerId,limit,before,beforeId,messageId,channelId,peerMemberId,floor,liveOnly=false}) {
  if(limit>100)refuse('Current conversation pages support at most 100 messages');
  const db=store.db,b=contextBudgets.get(db)??budget();
  if(messageId!==null) {
    // An unverified index may deny access, never grant it. Avoid loading a
    // different member's private body before the authoritative proof check.
    if(!currentMessageMayBeVisible(db,roomId,messageId,viewerId,b,floor)){
      return {rows:[],continuation:null,examined:0,complete:true};
    }
    // Addressed selection always uses the existing primary key, including a
    // missing/old/private identity. Never scan a seq stream to find it.
    const source=readCurrentMessage(db,roomId,messageId,b),m=source?.value;
    const visible=m&&(!liveOnly||!m.deletedAt)&&(!m.toMemberId||m.authorId===viewerId||m.toMemberId===viewerId)
      &&(channelId===null||!m.toMemberId&&(m.channelId||'general')===channelId)
      &&(peerMemberId===null||(m.authorId===viewerId&&m.toMemberId===peerMemberId)||(m.authorId===peerMemberId&&m.toMemberId===viewerId))
      &&messageInHistory(m,floor);
    return {rows:visible?[{position:source.row.seq,messageId,body:source.row.record_json}]:[],continuation:null,examined:source?1:0,complete:true};
  }
  const pageSize=8,streams=[];
  const base='room_id=? AND (seq,message_id)<(?,?)';
  if(peerMemberId===null)streams.push({
    index:channelId===null?'current_messages_public_seq':'current_messages_channel_public_seq',
    where:`(to_member_id IS NULL OR to_member_id='')`+(channelId===null?'':' AND channel_id=?'),args:channelId===null?[]:[channelId]});
  if(channelId===null) {
    streams.push(peerMemberId===null
      ?{index:'current_messages_incoming_seq',where:'to_member_id=?',args:[viewerId]}
      :{index:'current_messages_pair_seq',where:'author_id=? AND to_member_id=?',args:[peerMemberId,viewerId]});
    streams.push(peerMemberId===null
      ?{index:'current_messages_outgoing_seq',where:"author_id=? AND to_member_id IS NOT NULL AND to_member_id<>''",args:[viewerId]}
      :{index:'current_messages_pair_seq',where:'author_id=? AND to_member_id=?',args:[viewerId,peerMemberId]});
  }
  for(const stream of streams){if(liveOnly){stream.index+='_live';stream.where='('+stream.where+') AND deleted_at IS NULL';}stream.before=before;stream.beforeId=beforeId;stream.rows=[];stream.done=false;}
  const refill=stream=>{
    if(stream.rows.length||stream.done)return;
    // History/time predicates are residuals AFTER this bounded source window.
    const rows=db.prepare(`SELECT message_id,seq FROM messages INDEXED BY ${stream.index}
      WHERE ${base} AND ${stream.where} ORDER BY seq DESC,message_id DESC LIMIT ?`)
      .all(roomId,stream.before,stream.beforeId,...stream.args,pageSize);
    charge(b,rows.reduce((n,row)=>n+Buffer.byteLength(row.message_id)+32,0),rows.length);
    stream.rows=rows;stream.done=rows.length<pageSize;
    if(rows.length){stream.before=rows.at(-1).seq;stream.beforeId=rows.at(-1).message_id;}
  };
  const rows=[],seen=new Set();let examined=0,last=null,interrupted=false;
  // The examined window must cover at least the requested page: with the old
  // flat 64 cap a validated limit of 65..100 could never be filled even when
  // every candidate was visible. The 64 floor keeps the historical bound for
  // smaller pages, so existing small-limit callers are unchanged.
  while(rows.length<limit&&examined<Math.max(64,limit)) {
    try{for(const stream of streams)refill(stream);}
    catch(error){if(error.code==='current_room_context_unavailable'&&last){interrupted=true;break;}throw error;}
    const available=streams.filter(stream=>stream.rows.length);if(!available.length)break;
    available.sort((a,c)=>c.rows[0].seq-a.rows[0].seq||Buffer.compare(Buffer.from(c.rows[0].message_id),Buffer.from(a.rows[0].message_id)));
    const row=available[0].rows.shift();if(seen.has(row.message_id))continue;seen.add(row.message_id);
    if(floor) {
      // PRIV-2 accounting: a candidate whose scalar creation instant is
      // strictly before the reader's history floor is unreturnable by
      // construction (messageInHistory can only deny it), so it is charged
      // the scalar denial the addressed path already uses
      // (currentMessageMayBeVisible: charge 256), not a full proof read of
      // a body the reader may never see. The equal-instant tie-break and
      // every returnable row stay on the authoritative proof path below.
      // D4 guard (lane-11 rework): the scalar charge sits inside the same
      // budget-error catch discipline as the loop's other throws (pin
      // :1150/:1156/:1160) — if it exhausts the budget after at least one
      // candidate has been examined (last set), the read degrades to the
      // partial page with a continuation instead of hard-409ing.
      try{
        const at=db.prepare("SELECT CASE WHEN length(CAST(created_at AS BLOB))<=128 THEN created_at END AS at FROM messages WHERE room_id=? AND message_id=?").get(roomId,row.message_id)?.at;
        charge(b,256);
        const instant=typeof at==='string'?Date.parse(at):NaN,joined=Date.parse(floor.at);
        if(Number.isFinite(instant)&&Number.isFinite(joined)&&instant<joined){examined++;last={position:row.seq,messageId:row.message_id};continue;}
      }catch(error){if(error.code==='current_room_context_unavailable'&&last){interrupted=true;break;}throw error;}
    }
    let source;
    try{source=readCurrentMessage(db,roomId,row.message_id,b);}
    catch(error){if(error.code==='current_room_context_unavailable'&&last){interrupted=true;break;}throw error;}
    if(!source||source.row.seq!==row.seq)corrupt('window order or membership changed');
    let visible;
    try{visible=messageInHistory(source.value,floor);}
    catch(error){if(error.code==='current_room_context_unavailable'&&last){interrupted=true;break;}throw error;}
    examined++;last={position:row.seq,messageId:row.message_id};
    if(visible)rows.push({position:row.seq,messageId:row.message_id,body:source.row.record_json});
  }
  const complete=!interrupted&&streams.every(stream=>stream.done&&!stream.rows.length);
  return {rows,continuation:!complete?last:null,examined,complete};
}

const auditDerivedDomains=Object.freeze(['workPrivacy','workRequest','workSummary','workCapacity','messageWitness','archiveRetained','threadParticipants','historyFloors','historyExclusions']);
function currentAuditFieldKind(domain,key,value) {
 if(domain==='shape'){if(!maps.has(key)||value!=='object')corrupt('invalid recovered map shape');return 'shape';}
 if(domain==='metadata'){if(omitted.has(key)||maps.has(key)&&value!==null&&typeof value==='object'&&!Array.isArray(value))corrupt('competing recovered state');return 'metadata';}
 if(maps.has(domain))return 'map';
 if(auditDerivedDomains.includes(domain))return 'derived';
 corrupt('unknown recovered metadata domain');
}
function readCurrentAuditWorkBody(db,roomId,id,ref) {
 const scalar=db.prepare('SELECT length(CAST(body AS BLOB)) AS bytes FROM work_entities WHERE room_id=? AND work_id=?').get(roomId,id);
 if(!scalar||scalar.bytes>MAX_RECORD)corrupt('recovered work payload missing/oversized');
 const row=db.prepare('SELECT revision,digest,body FROM work_entities WHERE room_id=? AND work_id=?').get(roomId,id);
 if(ref._workEntity!==1||ref.id!==id||ref.revision!==row.revision||ref.digest!==row.digest||hash(row.body)!==ref.digest)corrupt('recovered work reference changed');
 const item=JSON.parse(row.body);if(item.id!==id||item.revision!==ref.revision)corrupt('recovered work identity changed');return item;
}

export function currentAuditMessageRoot(message,lookup){
 const root=message.replyToId?lookup(message.replyToId):message.id;
 if(!root)corrupt('recovered canonical reply ancestry incomplete');return root;
}

// Shared independent census leaf reads. One factory lives only inside the
// current synchronous transaction; no reconstructed source state is trusted.
export function withCurrentAuditUnits(store,roomId,operation) {
  const db=store.db;
  if(!db.isTransaction)throw Error('Current room census requires a consistent recovery transaction');
  const head=readCurrentHead(db,roomId),auditReceipts=new Map();
  if(head)assertLegacyWorkReconciled(db,roomId);
  let active=true;
  const assertActive=()=>{if(!active||!db.isTransaction)throw Error('Current audit unit scope expired');};
  const unitBudget=()=>{assertActive();return {...budget(),schemaVerified:true,auditReceipts};};
  try {const result=operation({head,record:(domain,key)=>{const value=readCurrentRecord(db,roomId,domain,key,unitBudget());if(value!==undefined)currentAuditFieldKind(domain,key,value);return value;},
    work:(id,ref)=>{assertActive();return readCurrentAuditWorkBody(db,roomId,id,ref);},message:id=>readCurrentMessage(db,roomId,id,unitBudget())});if(result?.then)throw Error('Current census must remain synchronous');return result;}
  finally {active=false;auditReceipts.clear();}
}

// Explicit independent recovery census. This full scan is deliberately absent
// from serving admission, command contexts and conversation pagination.
export function readCurrentRoomForAudit(store,roomId) {
  const db=store.db;
  if(!db.isTransaction)throw Error('Current room census requires a consistent recovery transaction');
  return withCurrentAuditUnits(store,roomId,units=>{
  const head=units.head;if(!head)return null;
  const state=emptyRoomState(),refs=new Map(),derived=new Map(auditDerivedDomains.map(domain=>[domain,new Map()])),canonicalMessages=[];let proofs=0,records=0;
  const {threadParticipants:participants,historyFloors:floors,historyExclusions:exclusions,messageWitness:messageWitnesses,workSummary:workSummaries,workCapacity:workCapacities,workPrivacy,workRequest:workRequests,archiveRetained}=Object.fromEntries(derived);
  for(const scalar of db.prepare(`SELECT rowid,length(CAST(domain AS BLOB)) AS domain_bytes,
    length(CAST(record_key AS BLOB)) AS key_bytes FROM current_room_record_proofs WHERE room_id=? ORDER BY domain,record_key`).iterate(roomId)) {
    if(scalar.domain_bytes<1||scalar.domain_bytes>64||scalar.key_bytes<1||scalar.key_bytes>200)corrupt('invalid recovery membership identity');
    const proof=db.prepare('SELECT domain,record_key,present FROM current_room_record_proofs WHERE rowid=?').get(scalar.rowid);
    const value=units.record(proof.domain,proof.record_key);proofs++;
    if(!proof.present)continue;records++;
    const key=proof.record_key;
    if(proof.domain==='shape') {
      if(!maps.has(key)||value!=='object')corrupt('invalid recovered map shape');state[key]??={};
    } else if(proof.domain==='metadata') {
      if(omitted.has(key)||maps.has(key)&&value!==null&&typeof value==='object'&&!Array.isArray(value))corrupt('competing recovered state');
      Object.defineProperty(state,key,{value,enumerable:true,writable:true,configurable:true});
    } else if(maps.has(proof.domain)) {
      if(proof.domain==='workItems')refs.set(key,value);
      else Object.defineProperty(state[proof.domain]??={},key,{value,enumerable:true,writable:true,configurable:true});
    } else if(derived.has(proof.domain))derived.get(proof.domain).set(key,value);
    else corrupt('unknown recovered metadata domain');
  }
  const actualRecords=db.prepare('SELECT count(*) AS count FROM current_room_records WHERE room_id=?').get(roomId).count;
  if(proofs!==head.counts.metadataProofs||records!==head.counts.metadataRecords||actualRecords!==records)corrupt('complete metadata census differs');
  for(const [id,ref] of refs) {
    const item=units.work(id,ref);
    Object.defineProperty(state.workItems,id,{value:item,enumerable:true,writable:true,configurable:true});
  }
  const expectedPrivacy=deriveWorkPrivacy(state);
  if(!isDeepStrictEqual(workPrivacy,expectedPrivacy.privacy)||!isDeepStrictEqual(workRequests,expectedPrivacy.links))corrupt('complete work privacy census differs');
  if(workSummaries.size!==refs.size||[...refs].some(([id,ref])=>!isDeepStrictEqual(workSummaries.get(id),currentWorkSummary(state.workItems[id],ref))))corrupt('complete work summary census differs');
  if(head.counts.workCapacity!==refs.size||workCapacities.size!==refs.size||[...refs.keys()].some(id=>!isDeepStrictEqual(workCapacities.get(id),currentWorkCapacity(state.workItems[id]))))corrupt('complete work capacity census differs');
  for(const scalar of db.prepare('SELECT rowid,length(CAST(message_id AS BLOB)) AS bytes FROM messages WHERE room_id=? ORDER BY seq,message_id').iterate(roomId)) {
    if(scalar.bytes<1||scalar.bytes>200)corrupt('invalid recovered message identity');
    const {message_id:id}=db.prepare('SELECT message_id FROM messages WHERE rowid=?').get(scalar.rowid);
    const source=units.message(id);canonicalMessages.push(source.value);
    if(archiveRetains(state.messagesArchive,source.row.seq,archiveRetained.get(id)))state.messages.push(source.value);
  }
  if(messageWitnesses.size!==head.counts.messages||canonicalMessages.length!==head.counts.messages||state.messages.length+(state.messagesArchive?.count??0)!==head.counts.messages||Object.keys(state.workItems).length!==head.counts.workItems
    ||Object.keys(state.members).length!==head.counts.members||Object.keys(state.replyRequests??{}).length!==head.counts.replyRequests)
    corrupt('complete domain census differs');
  if(state.messagesArchive)state.messagesArchive=recoverArchiveMarker(state.messagesArchive,archiveRetained);
  else if(archiveRetained.size)corrupt('orphan archive retained membership');
  const expected=new Map(),roots=new Map();
  for(const message of canonicalMessages){const root=currentAuditMessageRoot(message,id=>roots.get(id));roots.set(message.id,root);}
  for(const message of state.messages) {
    const root=roots.get(message.id);
    if(!root)corrupt('recovered reply ancestry incomplete');roots.set(message.id,root);
    expected.set(root+'\0'+message.authorId,{threadRootId:root,memberId:message.authorId});
  }
  if(expected.size!==head.counts.threadParticipants||!isDeepStrictEqual(expected,participants))corrupt('complete thread participant census differs');
  const expectedFloors=new Map(),expectedExclusions=new Map();
  for(const id of Object.keys(state.members)) {
    const existing=floors.get(id);
    if(existing?.version===2)expectedFloors.set(id,historyActivationTuple(db,roomId,id,head.sequence));
    else {
      const floor=deriveHistoryFloor(db,state,roomId,id,head.sequence);if(!floor)continue;
      expectedFloors.set(id,{sequence:floor.sequence,at:floor.at,sameInstantCount:floor.sameInstant.size});
      for(const excluded of floor.sameInstant)expectedExclusions.set(id+'\0'+excluded,true);
    }
  }
  if(floors.size!==head.counts.historyFloors||exclusions.size!==head.counts.historyExclusions
    ||!isDeepStrictEqual(floors,expectedFloors)||!isDeepStrictEqual(exclusions,expectedExclusions))corrupt('complete history floor/exclusion census differs');
  return {sequence:head.sequence,state};
  });
}

export function withCurrentReadContext(db,roomId,operation,{maxRecords=200}={}) {
  if(![200,512,1024].includes(maxRecords))throw Error('Unsupported internal current read reservation');
  if(!isCurrentRoom(db,roomId))return operation();
  const previous=contextBudgets.get(db);if(!previous)contextBudgets.set(db,budget(maxRecords));
  try{return operation(contextBudgets.get(db));}finally{if(!previous)contextBudgets.delete(db);}
}
export function readCurrentHistoryFloor(db,roomId,memberId) {
  const b=contextBudgets.get(db)??budget(),head=readCurrentHead(db,roomId,b);if(!head)return undefined;
  const room=readCurrentRecord(db,roomId,'metadata','room',b),member=readCurrentRecord(db,roomId,'members',memberId,b);
  if(!room||!member)corrupt('missing history policy authority');
  const limited=memberHistoryVisibility({room,members:{[memberId]:member}},memberId)==='since_join';
  const floor=readCurrentRecord(db,roomId,'historyFloors',memberId,b);
  if(floor?.version===2) {
    if(Object.keys(floor).sort().join(',')!=='at,sequence,tieBreak,version'||floor.tieBreak!=='source-sequence'
      ||!Number.isSafeInteger(floor.sequence)||floor.sequence<1||typeof floor.at!=='string'||!Number.isFinite(Date.parse(floor.at)))corrupt('invalid activation witness');
    if(!limited)return null;
    return {...floor,messageSequence(id){
      if(!db.isTransaction)throw Error('Addressed history membership requires its read transaction');
      const witness=readCurrentRecord(db,roomId,'messageWitness',id,b);
      if(!witness||!Number.isSafeInteger(witness.sequence))corrupt('missing message activation sequence');return witness.sequence;
    },eventSequence(id){
      if(!db.isTransaction)throw Error('Addressed history membership requires its read transaction');
      charge(b,256);const row=db.prepare('SELECT sequence FROM events WHERE id=? AND room_id=?').get(id,roomId);
      if(!Number.isSafeInteger(row?.sequence))corrupt('missing event activation sequence');return row.sequence;
    }};
  }
  if(!limited){if(floor!==undefined)corrupt('unexpected limited history witness');return null;}
  if(!floor||!Number.isSafeInteger(floor.sequence)||floor.sequence<1||typeof floor.at!=='string'
    ||!Number.isSafeInteger(floor.sameInstantCount)||floor.sameInstantCount<0)corrupt('missing qualified history floor');
  return {sequence:floor.sequence,at:floor.at,sameInstant:{size:floor.sameInstantCount,
    has(id){if(!db.isTransaction)throw Error('Addressed history membership requires its read transaction');
      return readCurrentRecord(db,roomId,'historyExclusions',memberId+'\0'+id,b)===true;},
    [Symbol.iterator](){refuse('Use addressed history exclusion membership; full exclusion hydration is unavailable');}}};
}

// The only bulk-load exception: code-owned exact guards, synchronously restored
// before each batch commits. The global schema writer fence remains installed.
export function withCurrentRestoreTableRows(db,table,operation) {
  if(!inRestoreContext(db))throw Error('Bulk current restore requires privileged target context');
  const guards=guardDefinitions.filter(([name])=>name.startsWith('current_room_guard_'+table+'_'));
  invalidateCurrentRoomSchema(db);
  try { return withExactRestoreGuards(db,guards,operation); }
  finally { invalidateCurrentRoomSchema(db); }
}

export function invalidateCurrentRoomSchema(db) { schemaCache.delete(db);auditSchemaLocations.delete(db); }

export function restoredCurrentFormatPresent(db) {
  return Boolean(db.prepare("SELECT 1 FROM current_room_head UNION ALL SELECT 1 FROM current_room_records UNION ALL SELECT 1 FROM current_room_record_proofs LIMIT 1").get()
    || db.prepare("SELECT 1 FROM rooms WHERE instr(projection,'\"normalizedCurrent\"')>0 LIMIT 1").get());
}

// These internal conversion operations use the actual endpoint metadata and
// proofs, but never install a head while legacy serving is still active.
export function stageCurrentCandidateRecords(store,{head=null,changes,counts,inputBudget=budget()}) {
  const db=store.db,roomId=head?.room_id??counts.roomId;
  if(!roomId||!db.isTransaction||db.prepare('SELECT 1 FROM current_room_head WHERE room_id=?').get(roomId))throw Error('Current candidate requires an unpublished existing room');
  admitCurrentSchema(db,inputBudget);
  return withCurrentRoomWriter(db,roomId,()=>{
    const next={...counts};delete next.roomId;delete next.sequence;delete next.eventId;
    for(const change of changes) {
      charge(inputBudget,Buffer.byteLength(JSON.stringify(change.value)??'')+1024);
      const proof=db.prepare('SELECT present FROM current_room_record_proofs WHERE room_id=? AND domain=? AND record_key=?').get(roomId,change.domain,change.key);
      next.metadataRecords+=(change.value===undefined?0:1)-(proof?.present??0);if(!proof)next.metadataProofs++;
    }
    return saveTransition(db,roomId,head?.sequence??counts.sequence,head?.event_id??counts.eventId,head,changes,next,{publishHead:false});
  });
}
export function currentCandidateCommandContext(store,roomId,command,{head,readMessage,readWork,actorId,inputBudget=budget()}) {
  if(!store.db.isTransaction||store.db.prepare('SELECT 1 FROM current_room_head WHERE room_id=?').get(roomId))throw Error('Candidate replay requires an unpublished room');
  const b=inputBudget;admitCurrentSchema(store.db,b);
  if(head.room_id!==roomId||hash(JSON.stringify(headValue(head)))!==head.head_sha256)corrupt('candidate control differs');
  const saved=receipt(store.db,head.receipt_id,b);if(saved.headHash!==head.head_sha256||saved.roomId!==roomId)corrupt('candidate control receipt differs');
  return commandContextFromHead(store,roomId,command,head,b,{readMessage,readWork,actorId});
}
export function applyCurrentCandidateEvent(store,context,incoming,callbacks) {
  const current=context.current;current.candidate=callbacks;
  const previous=context.room;
  const next=callbacks.apply(previous.state,incoming);
  const write=prepareCurrentWrite(store,{roomId:incoming.roomId,previous,state:next,event:incoming,sequence:callbacks.sequence,current});
  withCurrentRoomWriter(store.db,incoming.roomId,()=>write.persistEntities());
  return {head:callbacks.head,state:next};
}
export function publishCurrentCandidate(store,head,{generation,qualificationReceiptId}={}) {
  const db=store.db,roomId=head.room_id;
  if(!db.isTransaction||db.prepare('SELECT 1 FROM current_room_head WHERE room_id=?').get(roomId))throw Error('Existing-room publication requires unpublished target');
  if(typeof generation!=='string'||typeof qualificationReceiptId!=='string')throw Error('Publication requires completed protected engine qualification');
  const qualification=db.prepare("SELECT counts_json FROM operator_actions WHERE id=? AND action='replay_cutover_current' AND length(CAST(counts_json AS BLOB))<=4096").get(qualificationReceiptId);
  const control=db.prepare("SELECT payload FROM message_replay_units WHERE room_id=? AND generation=? AND domain='semantic' AND unit_key='state' AND payload_bytes BETWEEN 1 AND 4096 AND length(payload)=payload_bytes").get(roomId,generation);
  if(!qualification||!control)corrupt('missing publication qualification');
  const qualified=JSON.parse(qualification.counts_json),semantic=JSON.parse(Buffer.from(control.payload).toString('utf8'));
  if(semantic.receiptId!==qualificationReceiptId||hash(JSON.stringify(semantic.state))!==qualified.semanticStateHash||qualified.generation!==generation
    ||qualified.publicationReady!==true||semantic.state.currentPhase!=='ready'||semantic.state.hMessagesQualified!==true
    ||semantic.state.workDefaultsQualified!==true||!isDeepStrictEqual(semantic.state.candidateHead,head)||semantic.state.tailSequence!==head.sequence)
    corrupt('publication qualification differs');
  const latest=db.prepare('SELECT sequence FROM rooms WHERE id=?').get(roomId);
  if(latest?.sequence!==head.sequence)throw Error('Current candidate tail must catch up before publication');
  const b=budget();admitCurrentSchema(db,b);
  const saved=receipt(db,head.receipt_id,b);if(saved.headHash!==head.head_sha256||hash(JSON.stringify(headValue(head)))!==head.head_sha256)corrupt('publication candidate control differs');
  return withCurrentRoomWriter(db,roomId,()=>{
    db.prepare('INSERT INTO current_room_head VALUES(?,1,?,?,?,?,?,?)').run(roomId,head.sequence,head.event_id,head.revision,head.head_sha256,head.counts_json,head.receipt_id);
    const counts={...head.counts,metadataRecords:head.counts.metadataRecords-1};
    const projection=saveTransition(db,roomId,head.sequence,head.event_id,head,[{domain:'migrationFence',key:'active',value:undefined}],counts);
    recordProjectionWrite(db,roomId,projection);
    db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(projection,roomId);
    store.ensureIntegrityRoomState();db.prepare('UPDATE integrity_room_state SET sequence=?,projection_bytes=?,projection_hash=NULL,metadata_hash=? WHERE room_id=?')
      .run(head.sequence,Buffer.byteLength(projection),hash(projection),roomId);
    return {roomId,sequence:head.sequence,representation:'normalized-current-v1',historyProvenance:'unknown',certified:false};
  });
}

export function admitCurrentCandidateBudget(db,b) { admitCurrentSchema(db,b); return b; }

// Selected work context never opens the legacy room or unrelated work bodies.
// Wake policy needs only the room record, the actor and target member records
// and, for a work wake, that one item. Bounded like any selected read; no
// messages, roster census or unrelated work bodies.
export function readCurrentWakePolicyState(store,roomId,memberIds,workItemId=null) {
  const db=store.db,b=contextBudgets.get(db)??budget(),head=readCurrentHead(db,roomId,b);if(!head)return null;
  const room=readCurrentRecord(db,roomId,'metadata','room',b);if(!room)corrupt('missing wake policy room authority');
  const members=Object.create(null);
  for(const id of new Set(memberIds.filter(id=>typeof id==='string'))){const member=readCurrentRecord(db,roomId,'members',id,b);if(member!==undefined)members[id]=member;}
  const workItems=Object.create(null);
  if(typeof workItemId==='string'){const item=readCurrentWorkItem(db,roomId,workItemId,b);if(item)workItems[workItemId]=item;}
  return {room,members,workItems};
}
export function readCurrentSelectedWorkState(store,roomId,workId,viewerId,{includeOffers=false}={}) {
  const db=store.db,b=contextBudgets.get(db)??budget(),head=readCurrentHead(db,roomId,b);if(!head)return null;
  if(includeOffers)refuse('Cross-work offers require an indexed selected dependency context');
  const room=readCurrentRecord(db,roomId,'metadata','room',b),item=readCurrentWorkItem(db,roomId,workId,b);
  if(!room)corrupt('missing selected room authority');if(!item)return {sequence:head.sequence,state:{room,members:{},workItems:{}}};
  const ids=new Set([viewerId,room.ownerId,item.accountableMemberId,item.verifierMemberId,item.humanDecisionMakerId,item.proposedById,
    item.claim?.holderId,item.receipt?.producerId,item.receipt?.reportedById].filter(id=>typeof id==='string'));
  const members=Object.create(null);for(const id of ids){const member=readCurrentRecord(db,roomId,'members',id,b);if(member!==undefined)members[id]=member;}
  const replyRequests=Object.create(null);
  const privacy=readCurrentWorkPrivacy(db,roomId,workId,b);
  if(privacy.requests>8)refuse('Selected work replies require continuation for this work item');
  const prefix=workRequestPrefix(workId),requests=db.prepare("SELECT record_key FROM current_room_record_proofs WHERE room_id=? AND domain='workRequest' AND present=1 AND record_key>=? AND record_key<? ORDER BY record_key LIMIT 9").all(roomId,prefix,prefix+'\uffff');
  charge(b,requests.length*256,requests.length);if(requests.length!==privacy.requests)corrupt('selected request index count differs');
  for(const {record_key:key} of requests){const link=readCurrentRecord(db,roomId,'workRequest',key,b);if(!link||link.workItemId!==workId||workRequestKey(workId,link.requestId)!==key)corrupt('selected request index binding differs');const request=readCurrentRecord(db,roomId,'replyRequests',link.requestId,b);if(request?.workItemId!==workId)corrupt('selected private request missing');Object.defineProperty(replyRequests,link.requestId,{value:request,enumerable:true});}
  return {sequence:head.sequence,state:{room,members,workItems:{[workId]:privateWorkForViewer(db,roomId,workId,item,viewerId,b)},replyRequests}};
}

export {currentWorkSummary} from './current-work-summary.mjs';
// Examine a fixed source window before recipient/status/history predicates.
// Tombstones are excluded by the partial index rather than scanned on refill.
export function readCurrentReplyRequestWindow(store,roomId,{after='',limit=4}={}) {
  const db=store.db,b=contextBudgets.get(db)??budget(),head=readCurrentHead(db,roomId,b);if(!head)return null;
  if(typeof after!=='string'||Buffer.byteLength(after)>200||!Number.isInteger(limit)||limit<1||limit>8)refuse('Invalid request source window');
  const rows=db.prepare("SELECT record_key FROM current_room_record_proofs INDEXED BY current_reply_request_keys WHERE room_id=? AND domain='replyRequests' AND present=1 AND record_key>? ORDER BY record_key LIMIT ?").all(roomId,after,limit+1);
  charge(b,rows.reduce((n,row)=>n+Buffer.byteLength(row.record_key)+32,0),rows.length);
  const requests=[];let examinedAfter=after;
  for(const {record_key:id} of rows.slice(0,limit)) {
    const scalar=db.prepare("SELECT payload_bytes FROM current_room_records WHERE room_id=? AND domain='replyRequests' AND record_key=?").get(roomId,id);
    if(!scalar)corrupt('request source payload missing');
    if ( requests . length && b . bytes + scalar . payload_bytes + 16384 > MAX_INPUT ) break ;
    const request=readCurrentRecord(db,roomId,'replyRequests',id,b);if(request?.id!==id)corrupt('request source identity differs');
    requests.push(request);examinedAfter=id;
  }
  const hasMore=rows.length>requests.length;
  if(!after&&!hasMore&&requests.length!==head.counts.replyRequests)corrupt('complete request source membership differs');
  return {requests,examinedAfter,hasMore,total:head.counts.replyRequests};
}
// viewerAuthority: the Board work list needs only the owner's and viewer's
// member records, so it uses the existing addressed authority
// (currentMemberAuthorityFromHead) instead of the full member census, which
// exhausted the shared 200-record/256KiB read budget in rooms with more than a
// handful of members. Cost is O(page), not O(members).
export function readCurrentOverviewWindow(store,roomId,{workAfter='',limit=8,viewerId=null,viewerAuthority=false}={}) {
  const db=store.db,b=contextBudgets.get(db)??budget(),head=readCurrentHead(db,roomId,b);if(!head)return null;
  if(typeof workAfter!=='string'||Buffer.byteLength(workAfter)>200||!Number.isInteger(limit)||limit<1||limit>8)refuse('Invalid bounded work context window');
  const scoped=viewerAuthority&&typeof viewerId==='string';
  const authority=scoped?currentMemberAuthorityFromHead(db,roomId,head,b,viewerId):currentAuthorityFromHead(db,roomId,head,b),room=readCurrentRecord(db,roomId,'metadata','room',b);
  const state={room,members:authority.members,workItems:{},messages:[],pins:[]};
  if(!scoped){const pins=readCurrentRecord(db,roomId,'metadata','pins',b);if(pins!==undefined)state.pins=pins;}
  const rows=db.prepare("SELECT record_key FROM current_room_record_proofs INDEXED BY current_work_summary_keys WHERE room_id=? AND domain='workSummary' AND present=1 AND record_key>? ORDER BY record_key LIMIT ?").all(roomId,workAfter,limit+1);
  charge(b,rows.reduce((n,row)=>n+Buffer.byteLength(row.record_key)+32,0),rows.length);
  let after=workAfter,returned=0;
  for(const {record_key:id} of rows.slice(0,limit)) {
    const scalar=db.prepare("SELECT payload_bytes FROM current_room_records WHERE room_id=? AND domain='workSummary' AND record_key=?").get(roomId,id);
    if(!scalar)corrupt('work summary payload missing');
    if ( returned && b . bytes + scalar . payload_bytes + 32768 > MAX_INPUT ) break ;
    Object.defineProperty(state.workItems,id,{value:readCurrentWorkSummaryForViewer(db,roomId,id,viewerId,b),enumerable:true,writable:true,configurable:true});after=id;returned++;
  }
  const hasMore=rows.length>returned;
  if(!workAfter&&!hasMore&&returned!==head.counts.workItems)corrupt('complete work summary membership differs');
  return {sequence:head.sequence,state,workWindow:{order:'id',after:workAfter||null,shown:returned,total:head.counts.workItems,
    complete:!workAfter&&!hasMore,nextAfter:hasMore?after:null,
    nextRead:hasMore?{tool:'get_room_context',arguments:{roomId,work_after:after}}:null}};
}

const workSummaryReuseScopes=new WeakMap();
// The browser's composed read revisits at most eight already protected work
// summaries for event-label privacy, plus room/owner/viewer authority (max3).
// Reuse only inside this synchronous read TX; no writes may be committed.
export function withCurrentWorkSummaryReuse(store,roomId,viewerId,operation) {
  const db=store.db,b=contextBudgets.get(db);
  if(!db.isTransaction||!(store.readTransactionDepth>0)||!b||workSummaryReuseScopes.has(db))throw Error('Work summary reuse requires its own current read scope');
  const head=readCurrentHead(db,roomId,b),scope={roomId,viewerId,head:head.head_sha256,values:new Map(),authority:new Map(),ownerId:null};
  const closedPermit=()=>{
    const rows=db.prepare('SELECT singleton,enabled,room_id,receipt_id FROM current_room_writer_permit').all();charge(b,256,rows.length);
    if(rows.length!==1||rows[0].singleton!==1||rows[0].enabled!==0||rows[0].room_id!==null||rows[0].receipt_id!==null)corrupt('work summary reuse permit is not closed');
  };
  closedPermit();
  const schema=JSON.stringify(b.verifiedSchema),schemaCount=b.verifiedSchema.length;
  const changes=db.prepare('SELECT total_changes() AS n').get().n;charge(b,256);
  if(!Number.isSafeInteger(changes)||changes<0)corrupt('work summary reuse mutation counter unavailable');
  workSummaryReuseScopes.set(db,scope);
  try {
    const value=operation();
    if(value&&typeof value.then==='function')throw Error('Work summary reuse must be synchronous');
    if(readCurrentHead(db,roomId,b).head_sha256!==scope.head)corrupt('work summary reuse head changed');
    // Exact original, independently admitted catalog tuples; one JSON bind
    // keeps the native SQLite parameter ceiling. No schema cookie trust.
    const matched=db.prepare("SELECT count(*) AS n FROM sqlite_master m JOIN json_each(?) e ON m.rowid=json_extract(e.value,'$[0]') WHERE m.name=json_extract(e.value,'$[1]') AND m.sql=json_extract(e.value,'$[2]')").get(schema);
    charge(b,256);
    if(matched.n!==schemaCount)corrupt('work summary reuse schema changed');
    closedPermit();
    const finalChanges=db.prepare('SELECT total_changes() AS n').get().n;charge(b,256);
    if(!Number.isSafeInteger(finalChanges)||finalChanges!==changes)corrupt('work summary reuse data changed');
    return value;
  }finally{workSummaryReuseScopes.delete(db);}
}
export function readCurrentWorkSummaryForViewer(db,roomId,id,viewerId,b=contextBudgets.get(db)??budget()){
  const reuse=workSummaryReuseScopes.get(db);
  if(reuse?.roomId===roomId&&reuse.viewerId===viewerId&&reuse.values.has(id))return structuredClone(reuse.values.get(id));
  if(!b.schemaVerified&&!readCurrentHead(db,roomId,b))corrupt('work namespace is not initialized');
  const summary=readCurrentRecord(db,roomId,'workSummary',id,b),ref=readCurrentRecord(db,roomId,'workItems',id,b);
  if(!summary||!isDeepStrictEqual(summary.ref,ref)||summary.work?.id!==id)corrupt('work summary membership differs');
  const current=db.prepare('SELECT revision,digest FROM work_entities WHERE room_id=? AND work_id=?').get(roomId,id);charge(b,256);
  if(!current||current.revision!==ref.revision||current.digest!==ref.digest)corrupt('work summary payload revision differs');
  const result=privateWorkForViewer(db,roomId,id,summary.work,viewerId,b);
  if(reuse?.roomId===roomId&&reuse.viewerId===viewerId&&reuse.values.size<8)reuse.values.set(id,structuredClone(result));
  return result;
}

// Bound source examination before parsing event bodies. Long excluded tails
// refuse instead of scanning history or inventing a visible cursor.
export function currentVisibleHorizon(store,roomId,viewerId,head) {
  const db=store.db,b=contextBudgets.get(db)??budget();
  const rows=db.prepare('SELECT sequence,id,length(CAST(body AS BLOB)) AS bytes FROM events WHERE room_id=? AND sequence<=? ORDER BY sequence DESC LIMIT 16').all(roomId,head);
  charge(b,rows.length*64,rows.length);
  for(const row of rows) {
    if(row.bytes>MAX_RECORD)refuse('Latest visible cursor requires a bounded event envelope');
    charge(b,row.bytes);
    const event=JSON.parse(db.prepare('SELECT body FROM events WHERE room_id=? AND sequence=?').get(roomId,row.sequence).body);
    if(event.type==='message.posted') {
      if(event.data?.toMemberId&&event.actorId!==viewerId&&event.data.toMemberId!==viewerId)continue;
    } else if(['message.edited','message.deleted','message.redacted','poll.voted','message.pinned','message.unpinned'].includes(event.type)) {
      const target=db.prepare('SELECT author_id,to_member_id FROM messages WHERE room_id=? AND message_id=?').get(roomId,event.data?.messageId);
      charge(b,256);if(!target)refuse('Follow-up cursor requires an existing addressed message');
      if(target.to_member_id&&target.author_id!==viewerId&&target.to_member_id!==viewerId)continue;
    } else if(event.type==='dm.consent_changed') {
      const room=readCurrentRecord(db,roomId,'metadata','room',b);
      if(room.ownerId!==viewerId&&event.data?.requesterId!==viewerId&&event.data?.targetId!==viewerId)continue;
    }
    return row.sequence;
  }
  if(rows.length<16)return 0;
  refuse('Visible cursor needs a qualified bounded continuation beyond the excluded tail');
}

export function assertCurrentCandidateEmpty(store,roomId) {
  const db=store.db;
  if(isCurrentRoom(db,roomId))refuse('Room already has current serving authority');
  if(db.prepare('SELECT 1 FROM current_room_records WHERE room_id=? LIMIT 1').get(roomId)
    ||db.prepare('SELECT 1 FROM current_room_record_proofs WHERE room_id=? LIMIT 1').get(roomId))
    refuse('Unpublished target requires completed candidate cleanup before capture');
}
// Abandoned candidate rows have never served. Remove a bounded source window
// only while its independently proved migration fence names this generation.
// Published current records and their tombstones are never eligible here.
export function cleanupCurrentCandidateRecords(store,roomId,generation) {
  const db=store.db;if(!db.isTransaction)throw Error('Candidate cleanup requires transaction');
  if(isCurrentRoom(db,roomId))return {owned:false,done:true,rowsDeleted:0};
  const b=budget();admitCurrentSchema(db,b);
  const fence=readCurrentRecord(db,roomId,'migrationFence','active',b);
  if(!fence) {
    assertCurrentCandidateEmpty(store,roomId);
    return {owned:false,done:true,rowsDeleted:0};
  }
  if(fence.generation!==generation)return {owned:false,done:true,rowsDeleted:0};
  return withCurrentRoomWriter(db,roomId,()=>{
    const keys=db.prepare("SELECT domain,record_key FROM current_room_record_proofs WHERE room_id=? AND NOT(domain='migrationFence' AND record_key='active') ORDER BY domain,record_key LIMIT 80").all(roomId);
    let rowsDeleted=0;
    for(const {domain,record_key:key} of keys) {
      charge(b,Buffer.byteLength(domain)+Buffer.byteLength(key)+128);
      rowsDeleted+=db.prepare('DELETE FROM current_room_records WHERE room_id=? AND domain=? AND record_key=?').run(roomId,domain,key).changes;
      rowsDeleted+=db.prepare('DELETE FROM current_room_record_proofs WHERE room_id=? AND domain=? AND record_key=?').run(roomId,domain,key).changes;
    }
    // This separate window also removes any interrupted candidate-only payload
    // orphan; it cannot enlarge a nonempty proof window's physical write bound.
    if(!keys.length)for(const {domain,record_key:key} of db.prepare("SELECT domain,record_key FROM current_room_records WHERE room_id=? AND NOT(domain='migrationFence' AND record_key='active') ORDER BY domain,record_key LIMIT 80").all(roomId)) {
      charge(b,Buffer.byteLength(domain)+Buffer.byteLength(key)+128);
      rowsDeleted+=db.prepare('DELETE FROM current_room_records WHERE room_id=? AND domain=? AND record_key=?').run(roomId,domain,key).changes;
    }
    const remaining=db.prepare("SELECT 1 FROM current_room_record_proofs WHERE room_id=? AND NOT(domain='migrationFence' AND record_key='active') LIMIT 1").get(roomId)
      ||db.prepare("SELECT 1 FROM current_room_records WHERE room_id=? AND NOT(domain='migrationFence' AND record_key='active') LIMIT 1").get(roomId);
    if(!remaining) {
      rowsDeleted+=db.prepare("DELETE FROM current_room_records WHERE room_id=? AND domain='migrationFence' AND record_key='active'").run(roomId).changes;
      rowsDeleted+=db.prepare("DELETE FROM current_room_record_proofs WHERE room_id=? AND domain='migrationFence' AND record_key='active'").run(roomId).changes;
    }
    if(rowsDeleted>162)throw Error('Candidate cleanup row bound');
    return {owned:true,done:!remaining,rowsDeleted,inputBytes:b.bytes};
  });
}

// Privacy erasure is deliberately atomic, like the existing whole-generation
// purge. It is not an ordinary bounded serving operation. Never remove a
// published current representation or its independent membership witnesses.
export function purgeCurrentCandidateForPrivacy(db,roomId) {
  if(!db.isTransaction)throw Error('Candidate privacy purge requires deletion transaction');
  if(isCurrentRoom(db,roomId))return;
  const b=budget();admitCurrentSchema(db,b);
  const fence=readCurrentRecord(db,roomId,'migrationFence','active',b);
  if(!fence){assertCurrentCandidateEmpty({db},roomId);return;}
  withCurrentRoomWriter(db,roomId,()=>{
    db.prepare('DELETE FROM current_room_records WHERE room_id=?').run(roomId);
    db.prepare('DELETE FROM current_room_record_proofs WHERE room_id=?').run(roomId);
  });
}

export function readCurrentWorkPrivacy(db,roomId,workId,b=contextBudgets.get(db)??budget()) {
  return validateWorkPrivacy(readCurrentRecord(db,roomId,'workPrivacy',workId,b));
}
function privateWorkForViewer(db,roomId,workId,item,viewerId,b) {
  const privacy=readCurrentWorkPrivacy(db,roomId,workId,b);
  if(!privacy.requests||Object.hasOwn(privacy.parties,viewerId)||workRoleHolder(item,viewerId))return item;
  return {...item,title:null,definitionOfDone:null};
}
export function readCurrentPrivateWorkParties(store,roomId,workIds) {
  if(!Array.isArray(workIds)||workIds.length>8||workIds.some(id=>typeof id!=='string'))refuse('Use bounded addressed work IDs for current private-work context');
  const b=contextBudgets.get(store.db)??budget();if(!readCurrentHead(store.db,roomId,b))return null;
  const result=new Map();for(const id of workIds){const privacy=readCurrentWorkPrivacy(store.db,roomId,id,b);if(privacy.requests)result.set(id,new Set(Object.keys(privacy.parties)));}return result;
}
