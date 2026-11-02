// Explicit one-time materialization, not replay certification or a new migration
// engine. Existing events/accounts/credentials/connections are never replaced.
import {createHash} from 'node:crypto';
import {ServiceError} from './service-error.mjs';
import {CURRENT_WRITER_FORMAT,initializeCurrentRoom,isCurrentRoom,verifyCurrentRoomSchema} from './current-room-repository.mjs';
import {assertProjectionWrite} from './write-integrity.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,message,status=409)=>{throw new ServiceError(status,code,message);};
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value);
function input(value,execute){
 const keys=execute?['roomId','planHash','requestId','reason','discardLegacyAssignments']:['roomId','discardLegacyAssignments'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||!validId(value.roomId)||typeof value.discardLegacyAssignments!=='boolean'
  ||execute&&(!validId(value.requestId)||!/^[a-f0-9]{64}$/.test(value.planHash??'')||typeof value.reason!=='string'||!value.reason.trim()||Buffer.byteLength(value.reason)>280))fail('invalid_normalization_request','Select room, explicit legacy assignment disposition, and reviewed exact execute inputs',422);
 return value;
}
function inspect(store,selection){
 verifyCurrentRoomSchema(store.db);
 if(isCurrentRoom(store.db,selection.roomId))fail('already_normalized','Room already uses normalized serving');
 const row=store.db.prepare(`SELECT r.sequence,octet_length(r.projection) bytes,p.metadata_hash,e.id eventId FROM rooms r LEFT JOIN integrity_room_state p ON p.room_id=r.id LEFT JOIN events e ON e.room_id=r.id AND e.sequence=r.sequence WHERE r.id=?`).get(selection.roomId);
 if(!row||!Number.isSafeInteger(row.sequence)||row.sequence<1||typeof row.eventId!=='string'||!/^[a-f0-9]{64}$/.test(row.metadata_hash??''))fail('normalization_requires_reconciliation','Current room head and independent metadata proof are required');
 if(store.db.prepare('SELECT 1 FROM current_room_records WHERE room_id=? UNION ALL SELECT 1 FROM current_room_record_proofs WHERE room_id=? LIMIT 1').get(selection.roomId,selection.roomId))fail('normalization_candidate_exists','Resolve existing unpublished normalized candidate before one-time adoption');
 const legacy={};for(const table of ['work_claims','work_claim_history','collab_assignments'])legacy[table]=store.db.prepare(`SELECT count(*) n FROM ${table} WHERE room_id=?`).get(selection.roomId).n;
 const binding={version:1,roomId:selection.roomId,sequence:row.sequence,eventId:row.eventId,projectionBytes:row.bytes,metadataHash:row.metadata_hash,writerFormat:CURRENT_WRITER_FORMAT,discardLegacyAssignments:selection.discardLegacyAssignments,legacy};
 return {...binding,planHash:hash(JSON.stringify(binding)),operation:'One-time current-state materialization; no historical replay certification',
  retained:['room identity','accounts','members and exact permissions/revisions','credentials and revocations','OAuth and agent connections','original event/command and security journals','canonical messages and work'],
  discarded:selection.discardLegacyAssignments?['legacy board assignments/history','legacy collaboration assignments']:[],historyProvenance:'unknown',certified:false};
}
export function operatorNormalization(store,selection,execute=false){
 const request=input(selection,execute);if(store.readOnly)fail('read_only','This store is read-only');
 if(!execute)return store.readTransaction(()=>inspect(store,request));
 let stage='receipt_lookup';
 try{return store.transaction(()=>{
  const id='oa_normalize_'+hash(request.roomId+'\0'+request.requestId),fingerprint=hash(JSON.stringify(request));
  const prior=store.db.prepare("SELECT counts_json FROM operator_actions WHERE id=? AND action='operator_normalization_adopt'").get(id);
  if(prior){const saved=JSON.parse(prior.counts_json);if(saved.fingerprint!==fingerprint)fail('idempotency_conflict','Keep the exact original adoption request');return {...saved.result,duplicate:true};}
  stage='plan_validation';const plan=inspect(store,request);if(plan.planHash!==request.planHash)fail('plan_changed','Room head/proof or assignment census changed; review a fresh plan');
  assertProjectionWrite(store.db,request.roomId);
  stage='current_state_read';const current=store.room(request.roomId); // Deliberate ONE-TIME whole-state load.
  if(current.sequence!==plan.sequence)fail('plan_changed','Room changed during adoption');
  stage='legacy_assignment_cleanup';if(request.discardLegacyAssignments)for(const table of ['work_claim_history','work_claims','collab_assignments'])store.db.prepare(`DELETE FROM ${table} WHERE room_id=?`).run(request.roomId);
  stage='entity_materialization';initializeCurrentRoom(store,current.state,[],{adoptExisting:{sequence:plan.sequence,eventId:plan.eventId}});
  const bytes=store.db.prepare('SELECT octet_length(projection) bytes FROM rooms WHERE id=?').get(request.roomId).bytes;
  const result={roomId:request.roomId,sequence:plan.sequence,representation:'normalized-current-v1',writerFormat:CURRENT_WRITER_FORMAT,
   previousProjectionBytes:plan.projectionBytes,projectionBytes:bytes,legacyDiscarded:request.discardLegacyAssignments?plan.legacy:{},accountsAndConnectionsPreserved:true,historyProvenance:'unknown',certified:false,duplicate:false};
  stage='receipt_save';store.db.prepare('INSERT INTO operator_actions(id,at,action,target_kind,target_id,reason,plan_hash,counts_json,result,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
   .run(id,store.now(),'operator_normalization_adopt','room',request.roomId,request.reason,request.planHash,JSON.stringify({fingerprint,result}),'committed',request.requestId);
  return result;
 });}catch(error){
  if(error instanceof ServiceError)throw error;
  // This function is reached only through the authenticated operator route.
  // Report bounded conversion diagnostics after transaction rollback; ordinary
  // Room callers retain the central opaque error envelope.
  const message=String(error?.message??'Unknown conversion failure').slice(0,280);
  throw new ServiceError(500,'normalization_failed',`Normalization failed during ${stage}: ${message}`);
 }
}
