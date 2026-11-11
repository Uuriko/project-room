import {createHash} from 'node:crypto';
import {validId} from '../src/events.js';
import {readQualifiedReplayWorkForRetirement} from './replay-cutover.mjs';
import {boardClaimId,boardStateForWorkItem} from './work-item-board.mjs';
import {decodeWorkClaimRow,WORK_CLAIM_FIELDS} from './work-claim-sqlite.mjs';
import {closeWork,workOf,MAX_CLAIM_HISTORY} from './work-claims.mjs';
import {ServiceError} from './service-error.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,message)=>{throw new ServiceError(409,code,message);};
function authorize(store,token,roomId){
 const auth=store.authenticate(token,roomId),authority=store.roomAuthority(roomId);
 if(auth.member.id!==authority.ownerId&&!auth.member.permissions.includes('manage_claims'))throw new ServiceError(403,'access_denied','Existing claim-management permission is required');
 return auth.member.id;
}
function selection(input,applying=false){
 const keys=applying?['roomId','generation','workItemId','requestId','planHash','reason']:['roomId','generation','workItemId'];
 if(!input||Object.keys(input).some(key=>!keys.includes(key))||!validId(input.roomId)||!validId(input.workItemId)||!/^[a-f0-9]{64}$/.test(input.generation)
  ||applying&&(!validId(input.requestId)||!/^[a-f0-9]{64}$/.test(input.planHash)||typeof input.reason!=='string'||!input.reason.trim()||Buffer.byteLength(input.reason)>280))
  throw new ServiceError(422,'invalid_mirror_retirement','Select one qualified task and, when applying, its reviewed plan hash and original request ID');
}
function prepare(store,input,actorId){
 const {roomId,generation,workItemId}=input,db=store.db;
 if(db.prepare('SELECT 1 FROM current_room_head WHERE room_id=?').get(roomId))fail('mirror_retirement_unavailable','Mirror retirement prepares an existing legacy room before activation');
 const source=readQualifiedReplayWorkForRetirement(store,input),claimId=boardClaimId(workItemId),head=db.prepare('SELECT sequence FROM rooms WHERE id=?').get(roomId)?.sequence;
 const scalar=db.prepare('SELECT revision,digest,length(CAST(body AS BLOB)) bytes FROM work_entities WHERE room_id=? AND work_id=?').get(roomId,workItemId);
 if(!scalar||scalar.digest!==source.reference.digest||scalar.revision!==source.reference.revision)fail('stale_mirror_retirement','The canonical task changed since H; requalify current work before retiring its mirror');
 let bytes=source.inputBytes+scalar.bytes+4096;
 if(!Number.isSafeInteger(scalar.bytes)||scalar.bytes>131072||bytes>262144)fail('mirror_retirement_too_large','Current task proof exceeds the bounded retirement input');
 const current=db.prepare('SELECT body FROM work_entities WHERE room_id=? AND work_id=?').get(roomId,workItemId).body;
 if(hash(current)!==scalar.digest||current!==source.body)fail('stale_mirror_retirement','Current canonical task bytes differ from the independent H proof');
 const size=db.prepare('SELECT length(CAST(item_json AS BLOB)) bytes FROM work_claims WHERE room_id=? AND claim_id=?').get(roomId,claimId);
 bytes+=size?.bytes??0;if(!size||size.bytes>131072||bytes>262144)fail('mirror_retirement_too_large','Select one existing mirror within the bounded retirement input');
 const raw=db.prepare('SELECT item_json FROM work_claims WHERE room_id=? AND claim_id=?').get(roomId,claimId).item_json,envelope=JSON.parse(raw),data=envelope.v===undefined?envelope:envelope.data;
 if (!data || Object.keys(data).some(key => ! WORK_CLAIM_FIELDS . includes ( key ))
  || envelope.v !== undefined && Object.keys(envelope).some(key => !['v', 'kind', 'data'].includes(key)))
  fail('independent_legacy_work','Unknown legacy fields require explicit reconciliation; retirement will not drop them');
 const legacy=workOf(decodeWorkClaimRow(raw)),item=JSON.parse(current);
 if(legacy.workItemId!==workItemId||legacy.id!==claimId||legacy.kind!=='work'||legacy.supersededBy
  ||legacy.state!==boardStateForWorkItem(item,store.now())||legacy.owner!==null&&![item.accountableMemberId,item.claim?.holderId].includes(legacy.owner))
  fail('independent_legacy_work','This row is not an unambiguous current mirror. Reconcile its independent holder/state through the existing board inspection route');
 if((legacy.files?.length??0)||(legacy.attestations?.length??0)||(legacy.reviews?.length??0)||Object.keys(legacy.fileBlocks??{}).length)fail('independent_legacy_work','Existing files, review obligations, or file locks require explicit reconciliation before closing this mirror');
 if(['done','closed'].includes(legacy.state))fail('mirror_already_retired','The mirror is terminal; preserve its history and proceed with independent qualification');
 if (legacy.history.length > MAX_CLAIM_HISTORY)fail('mirror_retirement_too_large','Apply existing legacy history retention before this bounded retirement');
 const binding={version:1,roomId,generation,actorId,head,hHead:source.hHead,headerHash:source.headerHash,workItemId,workRevision:scalar.revision,workDigest:scalar.digest,claimId,mirrorDigest:hash(raw)};
 return {binding,planHash:hash(JSON.stringify(binding)),legacy,item,current,inputBytes:bytes};
}
export function planLegacyMirrorRetirement(store,token,input){
 selection(input);return store.readTransaction(()=>{
  const actorId=authorize(store,token,input.roomId),plan=prepare(store,input,actorId);
  return {...plan.binding,planHash:plan.planHash,inputBytes:plan.inputBytes,change:'Close only this legacy mirror; the canonical task continues unchanged',
   canonical:{id:plan.item.id,state:plan.item.state,revision:plan.item.revision},mirror:{id:plan.legacy.id,state:plan.legacy.state,owner:plan.legacy.owner,storedHistory:plan.legacy.history.length,historyOmitted:plan.legacy.historyOmitted??0,fieldsPresent:Object.keys(plan.legacy).sort()},
   inspect:{canonical:`/api/rooms/${encodeURIComponent(input.roomId)}/work-context?workItemId=${encodeURIComponent(input.workItemId)}`,legacy:`/api/rooms/${encodeURIComponent(input.roomId)}/work-claims/${encodeURIComponent(plan.legacy.id)}`},
   omitted:['task prose','mirror prose','private messages','credentials'],historyProvenance:'unknown',certified:false};
 });
}
export function retireLegacyMirror(store,token,input){
 selection(input,true);return store.transaction(()=>{
  const actorId=authorize(store,token,input.roomId),id='oa_mirror_retire_'+hash(input.roomId+'\0'+input.requestId),fingerprint=hash(JSON.stringify({roomId:input.roomId,generation:input.generation,workItemId:input.workItemId,requestId:input.requestId,planHash:input.planHash,reason:input.reason,actorId}));
  const prior=store.db.prepare("SELECT counts_json FROM operator_actions WHERE id=? AND action='current_legacy_mirror_retirement'").get(id);
  if(prior){const saved=JSON.parse(prior.counts_json);if(saved.fingerprint!==fingerprint)fail('mirror_retirement_idempotency_conflict','Preserve the original retirement request and all reviewed inputs');return {...saved,duplicate:true};}
  const plan=prepare(store,input,actorId);if(plan.planHash!==input.planHash)fail('stale_mirror_retirement','The task, mirror, head, or authority changed; review a new plan before another operation');
  const note=`Retired legacy mirror only; canonical task ${input.workItemId} revision ${plan.item.revision} continues at /api/rooms/${encodeURIComponent(input.roomId)}/work-context?workItemId=${encodeURIComponent(input.workItemId)}. ${input.reason}`;
  const closed=closeWork(plan.legacy,actorId,{authority:true,reason:note,now:new Date(store.now())});
  store.workClaims.set(input.roomId,closed);
  const actual=store.db.prepare('SELECT revision,digest,body FROM work_entities WHERE room_id=? AND work_id=?').get(input.roomId,input.workItemId);
  if(actual.revision!==plan.item.revision||actual.digest!==plan.binding.workDigest||actual.body!==plan.current)throw Error('Mirror retirement changed canonical work');
  const value={...plan.binding,planHash:plan.planHash,fingerprint,inputBytes:plan.inputBytes,mirrorAfterDigest:hash(store.db.prepare('SELECT item_json FROM work_claims WHERE room_id=? AND claim_id=?').get(input.roomId,plan.binding.claimId).item_json),canonicalUnchanged:true,mirrorState:'closed',duplicate:false,historyProvenance:'unknown',certified:false};
  if(Buffer.byteLength(JSON.stringify(value))>4096)throw Error('Mirror retirement receipt exceeds control bound');
  store.db.prepare('INSERT INTO operator_actions(id,at,action,target_kind,target_id,reason,plan_hash,counts_json,result,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
   .run(id,store.now(),'current_legacy_mirror_retirement','room',input.roomId,input.reason,input.planHash,JSON.stringify(value),'committed',input.requestId);
  return value;
 });
}
