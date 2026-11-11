// Exact-prefix evidence for a successfully committed explicit historical repair.
// Shared producer rules and bounded saved-prefix consumption; no proof baseline.
import { createHash } from 'node:crypto';
import { ServiceError } from './service-error.mjs';
import {CURRENT_WRITER_FORMAT} from './current-room-format.mjs';
import { replayPre749Sessions } from './legacy-session-replay.mjs';
export const HISTORICAL_REPLAY_CONTRACT_VERSION = 1;
export const HISTORICAL_REPLAY_KIND = 'pre749-sessions';
export const PRE749_ADAPTER_VERSION = 1;
function sourceBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  throw new TypeError('Invalid historical source bytes');
}
function sourceText(value) {
  const bytes = sourceBytes(value);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new TypeError('Invalid historical source bytes'); }
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) throw new TypeError('Invalid historical source bytes');
  return text;
}
export function decodeHistoricalEventRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new TypeError('Invalid historical prefix');
  return rows.map((row, index) => {
    if (!Number.isSafeInteger(row?.sequence) || row.sequence !== index + 1) throw new TypeError('Invalid historical prefix');
    const id = sourceText(row.id), body = sourceText(row.body);
    if (!id) throw new TypeError('Invalid historical prefix');
    return { ...row, id, body };
  });
}
// Only raw CAST(... AS BLOB) results are accepted. Driver-decoded TEXT loses
// provenance: invalid UTF-8 and a valid U+FFFD can otherwise alias.
export function pre749PrefixDigest(roomId, rows) {
  if (typeof roomId !== 'string' || !roomId) throw new TypeError('Invalid historical prefix');
  decodeHistoricalEventRows(rows);
  const hash = createHash('sha256');
  const frame = bytes => { hash.update(String(bytes.byteLength)).update(':').update(bytes); };
  frame(Buffer.from('project-room.historical-replay-prefix.v1')); frame(Buffer.from(roomId));
  for (const row of rows) {
    frame(Buffer.from(String(row.sequence))); frame(sourceBytes(row.id)); frame(sourceBytes(row.body));
  }
  return hash.digest('hex');
}

// Producer and ordinary consumers share these rules; discovery is not authority.
export const HISTORICAL_REPAIR_KIND = 'pre749-session-backfill';
export const HISTORICAL_REPAIR_ACTION = 'legacy_session_backfill_reconciled';
export const HISTORICAL_PROOF_MODE = 'adopt-absent-inline-v1';
const KIND = HISTORICAL_REPAIR_KIND, PROOF_MODE = HISTORICAL_PROOF_MODE;
const LIMIT = 64, BYTES = 256 * 1024;
const LOOKUP_ACTION = 'legacy_session_replay_lookup';
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const inputFailure = (code, status = 409) => { throw new ServiceError(status, code, 'Historical session repair refused; inspect fresh plan and independent serving proofs'); };
export class SavedHistoricalReplayError extends ServiceError {
  constructor() { super(500, 'projection_corrupt', 'Saved historical replay evidence requires operator reconciliation'); }
}
const unavailable = () => { throw new SavedHistoricalReplayError(); };
export function validateHistoricalRepairInput(input, execute) {
  if (!input || Object.keys(input).some(k => !['repairKind', 'rooms', 'reason', 'planHash', 'requestId', 'messageProofMode'].includes(k))
  || (input.messageProofMode !== undefined && input.messageProofMode !== PROOF_MODE)
  || input.repairKind !== KIND || !Array.isArray(input.rooms) || input.rooms.length !== 1
  || !input.rooms[0] || Object.keys(input.rooms[0]).some(k => !['roomId', 'expectedHead'].includes(k))
  || typeof input.rooms[0].roomId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.rooms[0].roomId)
  || !Number.isSafeInteger(input.rooms[0].expectedHead) || input.rooms[0].expectedHead < 1
  || input.rooms[0].expectedHead > LIMIT || typeof input.reason !== 'string'
  || !input.reason.trim() || Buffer.byteLength(input.reason) > 280 || Buffer.byteLength(JSON.stringify(input)) > 1024) inputFailure('invalid_legacy_repair', 422);
  if (execute && (typeof input.planHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.planHash)
  || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId))) inputFailure('repair_plan_required', 422);
  if (!execute && (input.planHash !== undefined || input.requestId !== undefined)) inputFailure('invalid_legacy_repair', 422);
  return input.rooms[0];
}
export function historicalRepairFingerprint(input, target) {
  return hash({ repairKind: KIND,
    ...(input.messageProofMode === PROOF_MODE ? { messageProofMode: PROOF_MODE } : {}),
    target, reason: input.reason, planHash: input.planHash ?? null, requestId: input.requestId ?? null });
}
export const historicalRepairReceiptId = (roomId, requestId) => 'oa_lsr_' + hash(roomId + '\0' + requestId);
const lookupId = (roomId, head) => 'oa_lsr_lookup_v1_' + hash(roomId) + '_' + String(head).padStart(2, '0');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function validContract(c, roomId, head) {
  const keys = ['version','kind','adapterVersion','roomId','throughSequence','headEventId','prefixSha256','snapshotHash'];
  return c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === keys.length && keys.every(key => Object.hasOwn(c,key))
    && c.version === HISTORICAL_REPLAY_CONTRACT_VERSION && c.kind === HISTORICAL_REPLAY_KIND && c.adapterVersion === PRE749_ADAPTER_VERSION
    && c.roomId === roomId && c.throughSequence === head && Number.isSafeInteger(head) && head >= 1 && head <= LIMIT
    && typeof c.headEventId === 'string' && c.headEventId.length > 0 && Buffer.byteLength(c.headEventId) <= 256 && sha(c.prefixSha256) && sha(c.snapshotHash);
}
const contractHash = c => hash([c.version,c.kind,c.adapterVersion,c.roomId,c.throughSequence,c.headEventId,c.prefixSha256,c.snapshotHash]);
function objectJson(db, text) {
  let value;
  try { value = JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) unavailable(); throw error; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable();
  if (db.prepare('SELECT 1 FROM json_tree(?) WHERE key IS NOT NULL GROUP BY parent,key HAVING count(*)>1 LIMIT 1').get(text)) unavailable();
  return value;
}
// Every transferred text is first type/octet admitted, then decoded from raw
// bytes. Invalid UTF-8 must not alias a legitimate replacement character.
function admittedRows(db, ids, columns, caps, spent) {
  const where = `id IN (${ids.map(() => '?').join(',')})`;
  const invalid = columns.map((key,i) => `(typeof(${key})!='text' OR length(CAST(${key} AS BLOB))>${caps[i]})`).join(' OR ')
    + (columns.length === 6 ? " OR reason!='Discover verified historical replay contract' OR typeof(reason)!='text' OR plan_hash IS NOT NULL OR request_id IS NOT NULL" : '');
  const sizes = columns.map(key => `length(CAST(${key} AS BLOB))+32`).join('+');
  const size = db.prepare(`SELECT count(*) AS n,coalesce(sum(nbytes),0) AS bytes,coalesce(max(invalid),0) AS invalid FROM (SELECT ${sizes} AS nbytes,CASE WHEN ${invalid} THEN 1 ELSE 0 END AS invalid FROM operator_actions WHERE ${where})`).get(...ids);
  if (size.invalid || size.n > ids.length || !Number.isSafeInteger(size.bytes) || spent.bytes + size.bytes > BYTES) unavailable();
  spent.bytes += size.bytes;
  const rows = db.prepare(`SELECT ${columns.map(key => `CAST(${key} AS BLOB) AS ${key}`).join(',')} FROM operator_actions WHERE ${where}`).all(...ids);
  try { return rows.map(row => Object.fromEntries(columns.map(key => [key,sourceText(row[key])]))); }
  catch (error) { if (error instanceof TypeError) unavailable(); throw error; }
}
function originalReceipt(db, id, roomId, head, spent) {
  if (!/^oa_lsr_[a-f0-9]{64}$/.test(id)) unavailable();
  const columns = ['id','action','target_kind','target_id','reason','plan_hash','counts_json','result','request_id'];
  const row = admittedRows(db,[id],columns,[71,64,16,64,280,64,4096,16,64],spent)[0];
  if (!row || row.action !== HISTORICAL_REPAIR_ACTION || row.target_kind !== 'room' || row.target_id !== roomId || row.result !== 'verified') unavailable();
  const saved = objectJson(db,row.counts_json), contract = saved.replayContract;
  if (!validContract(contract,roomId,head) || saved.repairKind !== KIND || saved.verified !== 1 || saved.duplicate !== false
    || typeof saved.derivedOnly !== 'boolean' || saved.snapshotHash !== contract.snapshotHash || saved.planHash !== row.plan_hash
    || !sha(saved.requestFingerprint) || !sha(saved.priorCursorHash) || !Array.isArray(saved.rooms) || saved.rooms.length !== 1
    || saved.rooms[0]?.roomId !== roomId || saved.rooms[0]?.head !== head || saved.rooms[0]?.events !== head) unavailable();
  const keys = ['repairKind','derivedOnly','rooms','planHash','snapshotHash','priorCursorHash','admission','requestFingerprint','verified','duplicate','replayContract'];
  if (!saved.derivedOnly) keys.push('messageProofMode','messageProofsToAdopt','servingContentChanged','messageProofsAdopted');
  if (Object.keys(saved).length !== keys.length || !keys.every(key => Object.hasOwn(saved,key))
    || Object.keys(saved.rooms[0]).length !== 3
    || (!saved.derivedOnly && (!Number.isSafeInteger(saved.messageProofsAdopted) || saved.messageProofsAdopted < 0
      || saved.messageProofsAdopted > LIMIT || saved.messageProofsToAdopt !== saved.messageProofsAdopted))) unavailable();
  const mode = saved.messageProofMode;
  if (saved.derivedOnly ? mode !== undefined : mode !== PROOF_MODE || saved.servingContentChanged !== false) unavailable();
  const request = { repairKind: KIND, ...(mode === PROOF_MODE ? {messageProofMode:mode} : {}), rooms:[{roomId,expectedHead:head}],
    reason:row.reason, planHash:row.plan_hash, requestId:row.request_id };
  try { validateHistoricalRepairInput(request,true); } catch (error) { if (error instanceof ServiceError) unavailable(); throw error; }
  if (historicalRepairReceiptId(roomId,row.request_id) !== id) unavailable();
  // The original producer preserves these two valid input object-key orders.
  // Do not canonicalize an old fingerprint or change its saved retry response.
  if (![request.rooms[0],{expectedHead:head,roomId}].some(target => historicalRepairFingerprint(request,target) === saved.requestFingerprint)) unavailable();
  const a = saved.admission;
  if (!a || Object.keys(a).length !== 4 || !['inputBytes','outputBytes','receiptReserveBytes','limitBytes'].every(key => Number.isSafeInteger(a[key]) && a[key] >= 0)
    || a.receiptReserveBytes !== 4096 || a.limitBytes !== BYTES || a.inputBytes + a.outputBytes + a.receiptReserveBytes > BYTES) unavailable();
  return { row, saved, contract };
}
export function appendHistoricalReplayLookup(db, roomId, head, receiptId, contract, at) {
  if (!db.isTransaction || !validContract(contract,roomId,head)) unavailable();
  const id = lookupId(roomId,head), digest = contractHash(contract), spent = {bytes:1024};
  const prior = admittedRows(db,[id],['id','action','target_kind','target_id','counts_json','result'],[128,64,16,64,512,16],spent)[0];
  if (prior) {
    const value = lookupValue(db,prior,roomId,head);
    const old = originalReceipt(db,value.receiptId,roomId,head,spent);
    if (value.contractSha256 !== digest || contractHash(old.contract) !== digest) unavailable();
    return;
  }
  const original = originalReceipt(db,receiptId,roomId,head,spent);
  if (contractHash(original.contract) !== digest) unavailable();
  const value = {version:1,roomId,throughSequence:head,receiptId,contractSha256:digest};
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 512 || spent.bytes + Buffer.byteLength(json) > 4096) unavailable();
  db.prepare('INSERT INTO operator_actions(id,at,action,target_kind,target_id,reason,plan_hash,counts_json,result,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id,at,LOOKUP_ACTION,'room',roomId,'Discover verified historical replay contract',null,json,'verified',null);
}
function lookupValue(db, row, roomId, head) {
  const value = objectJson(db,row.counts_json), keys = ['version','roomId','throughSequence','receiptId','contractSha256'];
  if (row.id !== lookupId(roomId,head) || row.action !== LOOKUP_ACTION || row.target_kind !== 'room' || row.target_id !== roomId || row.result !== 'verified'
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value,key)) || value.version !== 1
    || value.roomId !== roomId || value.throughSequence !== head || typeof value.receiptId !== 'string'
    || !/^oa_lsr_[a-f0-9]{64}$/.test(value.receiptId) || !sha(value.contractSha256)) unavailable();
  return value;
}
// Caller holds its read/writer transaction. This reconstructs only a previously
// proved exact prefix; it never reads serving payloads or establishes a proof.
function historicalCheckpoint(db, roomId, through, eventBudget = LIMIT) {
  if (!db.isTransaction) throw Error('Historical checkpoint requires a transaction');
  if (!Number.isSafeInteger(through) || through < 1 || typeof roomId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(roomId)) return null;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='operator_actions'").get()) return null;
  const heads = Array.from({length:Math.min(LIMIT,through)},(_,i)=>i+1), ids = heads.map(head=>lookupId(roomId,head));
  const spent = {bytes:1024 + ids.reduce((n,id)=>n+Buffer.byteLength(id)+32,0)};
  const rows = admittedRows(db,ids,['id','action','target_kind','target_id','counts_json','result'],[128,64,16,64,512,16],spent);
  if (!rows.length) return null; // No legacy namespace scan or implicit adoption.
  let selected;
  for (const row of rows) {
    const head = heads[ids.indexOf(row.id)];
    const value = lookupValue(db,row,roomId,head);
    if (!selected || head > selected.head) selected = {head,value};
  }
  const {head,value} = selected, original = originalReceipt(db,value.receiptId,roomId,head,spent), c = original.contract;
  if (value.contractSha256 !== contractHash(c)) unavailable();
  if (head > eventBudget) return {budgetExceeded:true,sequence:head};
  const size = db.prepare(`SELECT count(*) AS n,coalesce(sum(nbytes),0) AS bytes,coalesce(max(invalid),0) AS invalid FROM (
    SELECT length(CAST(id AS BLOB))+length(CAST(body AS BLOB))+96 AS nbytes,
      CASE WHEN typeof(sequence)!='integer' OR sequence<1 OR typeof(id)!='text' OR length(CAST(id AS BLOB))>256 OR typeof(body)!='text' THEN 1 ELSE 0 END AS invalid
    FROM events WHERE room_id=? AND sequence<=? ORDER BY sequence LIMIT 65)`).get(roomId,head);
  if (size.invalid || size.n !== head || !Number.isSafeInteger(size.bytes) || spent.bytes + size.bytes + original.saved.admission.outputBytes > BYTES) unavailable();
  const raw = db.prepare('SELECT sequence,CAST(id AS BLOB) AS id,CAST(body AS BLOB) AS body FROM events WHERE room_id=? AND sequence<=? ORDER BY sequence LIMIT 65').all(roomId,head);
  let events;
  try {
    const decoded = decodeHistoricalEventRows(raw);
    if (decoded.at(-1).id !== c.headEventId) unavailable();
    events = decoded.map(row => { const incoming = objectJson(db,row.body); if (incoming.id !== row.id || incoming.roomId !== roomId) unavailable(); return incoming; });
  } catch (error) { if (error instanceof TypeError) unavailable(); throw error; }
  const privacy = readHistoricalPrivacy ( db , { roomId , head , original , value , contract : c , raw , events , through } ) ;
  if ( ! privacy && pre749PrefixDigest ( roomId , raw ) !== c . prefixSha256 ) unavailable ( ) ;
  let state;
  try { state = replayPre749Sessions(events); }
  catch (error) { if (error.constructor === Error && !error.code) unavailable(); throw error; }
  const json = JSON.stringify(state);
  if ( ( ! privacy && hash ( json ) !== c . snapshotHash ) || Buffer . byteLength ( json ) > original . saved . admission . outputBytes + ( privacy ? 64 * 64 : 0 ) || spent . bytes + size . bytes + Buffer . byteLength ( json ) > BYTES ) unavailable ( ) ;
  return { state , json , sequence : head , eventId : c . headEventId , events : head , _basis : { roomId , head , original , value , contract : c , raw , entries : events , privacy } } ;
}

export function savedHistoricalReplayCheckpoint ( db , roomId , through , eventBudget = LIMIT ) {
 const result = historicalCheckpoint ( db , roomId , through , eventBudget ) ; if ( ! result || result . budgetExceeded ) return result ;
 const { _basis , ... publicValue } = result ; return publicValue ;
}

// Derived privacy write proofs. These never replace the original historical
// repair receipt or adopt changed history as a fresh original basis.
const PRIVACY_BASIS = 'historical_replay_privacy_basis' , PRIVACY_ERASURE = 'historical_replay_erased' ;
const PRIVACY_DESCRIPTOR_BYTES = 64 * 1024 , PRIVACY_INPUT_BYTES = 128 * 1024 ;
export const HISTORICAL_REPLAY_MAX_INPUT_BYTES = BYTES + PRIVACY_INPUT_BYTES ;
const privacyBasisId = b => 'oa_lsr_privacy_basis_' + hash ( [ b . roomId , b . head , b . original . row . id , contractHash ( b . contract ) ] ) ;
const privacyErasureId = ( b , slot ) => 'oa_lsr_privacy_' + hash ( [ b . roomId , b . head ] ) + '_' + slot ;
const exactKeys = ( value , keys ) => value && typeof value === 'object' && ! Array . isArray ( value ) && Object . keys ( value ) . sort ( ) . join ( ',' ) === [ ... keys ] . sort ( ) . join ( ',' ) ;
const commandCanonical = value => Array . isArray ( value ) ? '[' + value . map ( commandCanonical ) . join ( ',' ) + ']' : value && typeof value === 'object' ? '{' + Object . keys ( value ) . sort ( ) . map ( key => JSON . stringify ( key ) + ':' + commandCanonical ( value [ key ] ) ) . join ( ',' ) + '}' : JSON . stringify ( value ) ;
function privacyAction ( db , id , action , roomId , maximum , spent ) {
 const size = db . prepare ( "SELECT length(CAST(counts_json AS BLOB)) bytes,typeof(counts_json) kind FROM operator_actions WHERE id=?" ) . get ( id ) ;
 if ( ! size ) return null ;
 if ( size . kind !== 'text' || ! Number . isSafeInteger ( size . bytes ) || size . bytes < 2 || size . bytes > maximum || spent . bytes + size . bytes + 256 > PRIVACY_INPUT_BYTES ) unavailable ( ) ;
 spent . bytes += size . bytes + 256 ;
 const row = db . prepare ( 'SELECT action,target_kind,target_id,result,CAST(counts_json AS BLOB) bytes FROM operator_actions WHERE id=?' ) . get ( id ) ;
 if ( row . action !== action || row . target_kind !== 'room' || row . target_id !== roomId || row . result !== ( action === 'current_room_writer_admission' ? 'opened' : action === 'current_room_writer_closed' ? 'closed' : 'committed' ) ) unavailable ( ) ;
 return objectJson ( db , sourceText ( row . bytes ) ) ;
}
function privacyTarget ( entry ) {
 if ( entry . type === 'message.posted' ) return typeof entry . data ?. messageId === 'string' && entry . data . messageId ? entry . data . messageId : entry . id ;
 return entry . type === 'message.edited' ? entry . data ?. messageId : null ;
}
function erasedEvent ( entry ) {
 const out = structuredClone ( entry ) ;
 if ( Object . hasOwn ( out . data , 'body' ) ) out . data . body = null ;
 if ( Object . hasOwn ( out . data , 'attachments' ) ) out . data . attachments = null ;
 out . data . redacted = true ; return JSON . stringify ( out ) ;
}
function basisCommitment ( value ) {
 return hash ( [ 'project-room.historical-privacy-basis.v1' , value . roomId , value . head , value . originalReceiptId , value . contractSha256 , value . prefixSha256 , value . snapshotHash , value . rows ] ) ;
}
function newPrivacyBasis ( b ) {
 const value = { version : 1 , roomId : b . roomId , head : b . head , originalReceiptId : b . original . row . id , contractSha256 : contractHash ( b . contract ) , prefixSha256 : b . contract . prefixSha256 , snapshotHash : b . contract . snapshotHash , rows : b . raw . map ( ( row , i ) => {
  const entry = b . entries [ i ] , target = privacyTarget ( entry ) ;
  return [ row . sequence , sourceText ( row . id ) , hash ( sourceText ( row . body ) ) , target ? hash ( erasedEvent ( entry ) ) : null , target ?? null , entry . type === 'message.posted' && typeof entry . data ?. body === 'string' ? Buffer . byteLength ( entry . data . body ) : null ] ;
 } ) } ;
 if ( Buffer . byteLength ( JSON . stringify ( value ) ) > PRIVACY_DESCRIPTOR_BYTES ) unavailable ( ) ; return value ;
}
function validatePrivacyBasis ( value , b ) {
 if ( ! exactKeys ( value , [ 'version' , 'roomId' , 'head' , 'originalReceiptId' , 'contractSha256' , 'prefixSha256' , 'snapshotHash' , 'rows' ] ) || value . version !== 1 || value . roomId !== b . roomId || value . head !== b . head || value . originalReceiptId !== b . original . row . id || value . contractSha256 !== contractHash ( b . contract ) || value . prefixSha256 !== b . contract . prefixSha256 || value . snapshotHash !== b . contract . snapshotHash || ! Array . isArray ( value . rows ) || value . rows . length !== b . head ) unavailable ( ) ;
 for ( let i = 0 ; i < value . rows . length ; i ++ ) {
  const row = value . rows [ i ] ;
  if ( ! Array . isArray ( row ) || row . length !== 6 || row [ 0 ] !== i + 1 || typeof row [ 1 ] !== 'string' || Buffer . byteLength ( row [ 1 ] ) > 256 || ! sha ( row [ 2 ] ) || ( row [ 3 ] !== null && ! sha ( row [ 3 ] ) ) || ( row [ 4 ] !== null && ( typeof row [ 4 ] !== 'string' || ! /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/ . test ( row [ 4 ] ) ) ) || ( ( row [ 3 ] === null ) !== ( row [ 4 ] === null ) ) || ( row [ 5 ] !== null && ( ! Number . isSafeInteger ( row [ 5 ] ) || row [ 5 ] < 0 ) ) ) unavailable ( ) ;
 }
}
function privacyEvent ( db , roomId , sequence , id , spent ) {
 if ( ! Number . isSafeInteger ( sequence ) || sequence < 1 || typeof id !== 'string' ) unavailable ( ) ;
 const size = db . prepare ( 'SELECT length(CAST(body AS BLOB)) bytes,typeof(body) kind,id FROM events WHERE room_id=? AND sequence=?' ) . get ( roomId , sequence ) ;
 if ( ! size || size . kind !== 'text' || ! Number . isSafeInteger ( size . bytes ) || size . bytes < 2 || size . id !== id || size . bytes > 32 * 1024 || spent . bytes + size . bytes > PRIVACY_INPUT_BYTES ) unavailable ( ) ; spent . bytes += size . bytes ;
 const entry = objectJson ( db , sourceText ( db . prepare ( 'SELECT CAST(body AS BLOB) bytes FROM events WHERE room_id=? AND sequence=?' ) . get ( roomId , sequence ) . bytes ) ) ;
 if ( entry . id !== id || entry . roomId !== roomId ) unavailable ( ) ; return entry ;
}
function validatePrivacyErasure ( db , b , descriptor , value , slot , spent , { closingPermitId = null } = { } ) {
 if ( ! exactKeys ( value , [ 'version' , 'basisSha256' , 'slot' , 'messageId' , 'actorId' , 'command' , 'deletion' , 'redaction' , 'admission' , 'transition' ] ) || value . version !== 1 || value . basisSha256 !== basisCommitment ( descriptor ) || value . slot !== slot || typeof value . messageId !== 'string' || typeof value . actorId !== 'string' || ! Array . isArray ( value . command ) || value . command . length !== 3 || ! Array . isArray ( value . deletion ) || value . deletion . length !== 2 || ! Array . isArray ( value . redaction ) || value . redaction . length !== 2 || ! Array . isArray ( value . admission ) || value . admission . length !== 5 || ! Array . isArray ( value . transition ) || value . transition . length !== 5 ) unavailable ( ) ;
 const original = descriptor . rows [ slot - 1 ] ;
 if ( ! original || original [ 4 ] !== value . messageId || ( b . events ?? b . entries ) [ slot - 1 ] ?. type !== 'message.posted' ) unavailable ( ) ;
 const deleted = privacyEvent ( db , b . roomId , ... value . deletion , spent ) , redacted = privacyEvent ( db , b . roomId , ... value . redaction , spent ) ;
 if ( value . deletion [ 0 ] <= b . head || value . redaction [ 0 ] <= value . deletion [ 0 ] || value . redaction [ 0 ] > b . through || deleted . type !== 'message.deleted' || redacted . type !== 'message.redacted' || deleted . actorId !== value . actorId || redacted . actorId !== value . actorId || deleted . at !== redacted . at || deleted . data ?. messageId !== value . messageId || redacted . data ?. messageId !== value . messageId || ! Number . isSafeInteger ( deleted . data ?. expectedMessageRevision ) || deleted . data . expectedMessageRevision < 0 || deleted . idempotencyKey !== hash ( value . actorId + ':' + value . command [ 0 ] ) ) unavailable ( ) ;
 if ( ( original [ 5 ] > 0 ? redacted . data . byteLength !== original [ 5 ] : Object . hasOwn ( redacted . data , 'byteLength' ) ) ) unavailable ( ) ;
 const command = { id : value . command [ 0 ] , type : 'message.deleted' , data : deleted . data } ;
 if ( value . command [ 2 ] === 'null' ) command . causationId = null ;
 else if ( value . command [ 2 ] === 'undefined' ) command . causationId = undefined ;
 else if ( value . command [ 2 ] === 'value' ) command . causationId = deleted . causationId ;
 else if ( value . command [ 2 ] !== 'absent' ) unavailable ( ) ;
 const receipt = db . prepare ( 'SELECT fingerprint,sequence FROM commands WHERE room_id=? AND actor_id=? AND id=?' ) . get ( b . roomId , value . actorId , value . command [ 0 ] ) ;
 if ( ! receipt || receipt . sequence !== value . deletion [ 0 ] || receipt . fingerprint !== value . command [ 1 ] || receipt . fingerprint !== hash ( commandCanonical ( command ) ) ) unavailable ( ) ;
 const opened = privacyAction ( db , value . admission [ 0 ] , 'current_room_writer_admission' , b . roomId , 4096 , spent ) ;
 if ( ! exactKeys ( opened , [ 'roomId' , 'permitId' , 'headHash' , 'format' ] ) || opened . roomId !== b . roomId || opened . permitId !== value . admission [ 0 ] || opened . headHash !== value . admission [ 1 ] || ! [
   'normalized-current-v1-native-work-5',
   'normalized-current-v1-native-work-6'
  ] . includes ( opened . format ) ) unavailable ( ) ;
 if ( value . admission [ 0 ] !== closingPermitId ) { const closed = privacyAction ( db , value . admission [ 0 ] + '_closed' , 'current_room_writer_closed' , b . roomId , 4096 , spent ) ; if ( ! exactKeys ( closed , [ 'permitId' ] ) || closed . permitId !== value . admission [ 0 ] ) unavailable ( ) ; }
 const transition = privacyAction ( db , value . transition [ 0 ] , 'current_room_transition' , b . roomId , 128 * 1024 , spent ) ;
 const tuple = value . transition [ 4 ] ;
 if ( ! exactKeys ( transition , [ 'version' , 'roomId' , 'headHash' , 'records' ] ) || transition . version !== 1 || transition . roomId !== b . roomId || transition . headHash !== value . transition [ 1 ] || value . transition [ 2 ] !== value . redaction [ 0 ] || ! Number . isSafeInteger ( value . admission [ 3 ] ) || ! Number . isSafeInteger ( value . admission [ 4 ] ) || value . deletion [ 0 ] !== value . admission [ 4 ] + 1 || value . transition [ 3 ] !== value . admission [ 3 ] + 1 || value . transition [ 0 ] !== 'oa_current_' + hash ( [ b . roomId , value . transition [ 2 ] , value . transition [ 3 ] , value . transition [ 1 ] , value . admission [ 2 ] , transition . records ] ) || ! Array . isArray ( transition . records ) || transition . records . length > 128 || ! Array . isArray ( tuple ) || tuple . length !== 5 || tuple [ 0 ] !== 'messageWitness' || tuple [ 1 ] !== value . messageId || ! Number . isSafeInteger ( tuple [ 2 ] ) || tuple [ 2 ] < 0 || tuple [ 3 ] !== 1 || ! sha ( tuple [ 4 ] ) || ! transition . records ?. some ( row => JSON . stringify ( row ) === JSON . stringify ( tuple ) ) ) unavailable ( ) ;
 return value ;
}
function readHistoricalPrivacy ( db , b , { closingPermitId = null } = { } ) {
 const spent = { bytes : 0 } , descriptor = privacyAction ( db , privacyBasisId ( b ) , PRIVACY_BASIS , b . roomId , PRIVACY_DESCRIPTOR_BYTES , spent ) ;
 if ( ! descriptor ) { const ids = Array . from ( { length : b . head } , ( _ , i ) => privacyErasureId ( b , i + 1 ) ) ; if ( db . prepare ( 'SELECT 1 FROM operator_actions WHERE id IN (' + ids . map ( ( ) => '?' ) . join ( ',' ) + ') LIMIT 1' ) . get ( ... ids ) ) unavailable ( ) ; return null ; }
 validatePrivacyBasis ( descriptor , b ) ; const erased = new Map ( ) , receipts = [ ] ;
 for ( let slot = 1 ; slot <= b . head ; slot ++ ) {
  const value = privacyAction ( db , privacyErasureId ( b , slot ) , PRIVACY_ERASURE , b . roomId , 4096 , spent ) ;
  if ( value ) { validatePrivacyErasure ( db , b , descriptor , value , slot , spent , { closingPermitId } ) ; if ( erased . has ( value . messageId ) ) unavailable ( ) ; erased . set ( value . messageId , value ) ; receipts . push ( value ) ; }
 }
 if ( ! receipts . length ) unavailable ( ) ;
 for ( let i = 0 ; i < b . raw . length ; i ++ ) {
  const row = descriptor . rows [ i ] , entry = b . events ?. [ i ] ?? b . entries ?. [ i ] , raw = b . raw [ i ] , changed = erased . has ( row [ 4 ] ) ;
  if ( row [ 0 ] !== raw . sequence || row [ 1 ] !== sourceText ( raw . id ) || hash ( sourceText ( raw . body ) ) !== ( changed ? row [ 3 ] : row [ 2 ] ) || ( changed && ( privacyTarget ( entry ) !== row [ 4 ] || entry . data ?. body != null || entry . data ?. redacted !== true || ( Object . hasOwn ( entry . data , 'attachments' ) && entry . data . attachments !== null ) ) ) ) unavailable ( ) ;
 }
 return { descriptor , receipts , bytes : spent . bytes } ;
}

// Preparation verifies original source before the first rewrite. Its closure
// stays inside the synchronous deletion transaction; nothing grants a reader
// permission to replace the original historical proof.
export function prepareHistoricalReplayErasure ( db , { roomId , through , messageId , actorId , command , deletion , redaction } ) {
 if ( ! db . isTransaction || ! redaction ) unavailable ( ) ;
 const result = historicalCheckpoint ( db , roomId , through ) ; if ( ! result ) return null ;
 const b = { ... result . _basis , through , events : result . _basis . entries } , descriptor = b . privacy ?. descriptor ?? newPrivacyBasis ( b ) ;
 const slot = descriptor . rows . find ( row => row [ 4 ] === messageId && b . entries [ row [ 0 ] - 1 ] . type === 'message.posted' ) ?. [ 0 ] ;
 if ( ! slot ) return null ;
 if ( b . privacy ?. receipts . some ( row => row . messageId === messageId ) ) unavailable ( ) ;
 const permit = db . prepare ( 'SELECT enabled,room_id,receipt_id FROM current_room_writer_permit WHERE singleton=1' ) . get ( ) , prior = db . prepare ( 'SELECT * FROM current_room_head WHERE room_id=?' ) . get ( roomId ) ;
 if ( permit ?. enabled !== 1 || permit . room_id !== roomId || ! prior ) unavailable ( ) ;
 const admission = privacyAction ( db , permit . receipt_id , 'current_room_writer_admission' , roomId , 4096 , { bytes : 0 } ) ;
 if ( admission ?. headHash !== prior . head_sha256 || admission . format !== CURRENT_WRITER_FORMAT ) unavailable ( ) ;
 const cause = Object . hasOwn ( command , 'causationId' ) ? ( command . causationId === undefined ? 'undefined' : command . causationId === null ? 'null' : 'value' ) : 'absent' ;
 const value = { version : 1 , basisSha256 : basisCommitment ( descriptor ) , slot , messageId , actorId , command : [ command . id , hash ( commandCanonical ( command ) ) , cause ] , deletion : null , redaction : null , admission : [ permit . receipt_id , prior . head_sha256 , prior . receipt_id , prior . revision , prior . sequence ] , transition : null } ;
 let admitted = false ;
 return { admit ( receiptBytesUpperBound ) {
  if ( ! Number . isSafeInteger ( receiptBytesUpperBound ) || receiptBytesUpperBound < 1 || receiptBytesUpperBound > 128 * 1024 ) unavailable ( ) ;
  const existing = b . privacy ?. bytes ?? Buffer . byteLength ( JSON . stringify ( descriptor ) ) + 256 ;
  const additional = 4096 + receiptBytesUpperBound + Buffer . byteLength ( JSON . stringify ( deletion ) ) + Buffer . byteLength ( JSON . stringify ( redaction ) ) + 1024 ;
  if ( existing + additional > PRIVACY_INPUT_BYTES ) unavailable ( ) ; admitted = true ;
 } , finalize ( sequence ) {
  if ( ! admitted ) unavailable ( ) ;
  const head = db . prepare ( 'SELECT * FROM current_room_head WHERE room_id=?' ) . get ( roomId ) , transition = privacyAction ( db , head ?. receipt_id , 'current_room_transition' , roomId , 128 * 1024 , { bytes : 0 } ) , tuple = transition ?. records ?. find ( row => row [ 0 ] === 'messageWitness' && row [ 1 ] === messageId ) ;
  if ( ! head || head . event_id !== redaction . id || head . sequence <= sequence || ! tuple ) unavailable ( ) ;
  value . deletion = [ sequence , deletion . id ] ; value . redaction = [ head . sequence , redaction . id ] ; value . transition = [ head . receipt_id , head . head_sha256 , head . sequence , head . revision , tuple ] ;
  const insert = ( id , action , body ) => db . prepare ( 'INSERT INTO operator_actions(id,at,action,target_kind,target_id,counts_json,result) VALUES(?,?,?,?,?,?,?)' ) . run ( id , Date . now ( ) , action , 'room' , roomId , JSON . stringify ( body ) , 'committed' ) ;
  if ( ! b . privacy ) insert ( privacyBasisId ( b ) , PRIVACY_BASIS , descriptor ) ;
  insert ( privacyErasureId ( b , slot ) , PRIVACY_ERASURE , value ) ;
  // Same exact post-write validation as cold readers, except this transaction's
  // outer writer has not appended its closing receipt yet.
  const rows = db . prepare ( 'SELECT sequence,CAST(id AS BLOB) id,CAST(body AS BLOB) body FROM events WHERE room_id=? AND sequence<=? ORDER BY sequence LIMIT 65' ) . all ( roomId , b . head ) ;
  const entries = decodeHistoricalEventRows ( rows ) . map ( row => objectJson ( db , row . body ) ) ;
  readHistoricalPrivacy ( db , { ... b , raw : rows , events : entries , through : head . sequence } , { closingPermitId : value . admission [ 0 ] } ) ;
 } } ;
}
