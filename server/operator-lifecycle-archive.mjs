// Explicit operator-on-owner-behalf retirement of the disposable legacy room.
// No identity, credential, invitation or grant rows are changed. The existing
// archive event retains the real owner's replay semantics; the immutable audit
// names operator authority explicitly and binds the resulting event and head.
import {createHash} from 'node:crypto';
import {ServiceError} from './service-error.mjs';
import {appendOperatorAction} from './operator-actions.mjs';
const ROOM='muse-room';
const fail=(status,code,message)=>{throw new ServiceError(status,code,message);};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function operatorLifecycleArchive(store,input,execute=false){
 const fields=execute?['roomId','confirmRoomId','reason','requestId','planHash']:['roomId','confirmRoomId','reason'];
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k)))fail(422,'invalid_retirement','Supply the exact room, confirmation and retirement reason');
 if(input.roomId!==ROOM)fail(403,'operator_retirement_scope','Only the approved legacy room may be archived');
 if(input.confirmRoomId!==ROOM||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>280)fail(422,'invalid_retirement','Confirm the exact room and give a reason of 1 to 280 characters');
 if(execute&&(typeof input.requestId!=='string'||typeof input.planHash!=='string'||!/^[A-Za-z0-9_-]{1,57}$/.test(input.requestId)||!/^[a-f0-9]{64}$/.test(input.planHash)))fail(422,'plan_required','Execute requires the reviewed plan hash and a stable request ID');
 return store.transaction(()=>{
  if(execute){
   const prior=store.db.prepare("SELECT reason,plan_hash,counts_json FROM operator_actions WHERE action='room_lifecycle_archived' AND target_id=? AND request_id=?").get(ROOM,input.requestId);
   if(prior){if(prior.reason!==input.reason||prior.plan_hash!==input.planHash)fail(409,'idempotency_conflict','Request ID already used for a different archive');return {...JSON.parse(prior.counts_json),duplicate:true};}
  }
  const row=store.db.prepare('SELECT sequence,projection,archived_at FROM rooms WHERE id=?').get(ROOM);
  if(!row)fail(404,'room_not_found','Room not found');
  if(row.archived_at!=null)fail(409,'room_archived','The room is already archived; use the original operation receipt');
  const authority=store.roomAuthority(ROOM,{memberId:'operator-archive-context'}),owner=authority.members[authority.ownerId];
  if(!owner||owner.active===false)fail(409,'invalid_retirement','Current owner authority requires reconciliation');
  const basis={roomId:ROOM,head:row.sequence,ownerId:owner.id,projectionSha256:createHash('sha256').update(row.projection).digest('hex'),reason:input.reason};
  const planHash=digest(basis);
  if(!execute)return {roomId:ROOM,ownerId:owner.id,head:row.sequence,planHash,authority:'operator_on_owner_behalf',credentialsChanged:false};
  if(input.planHash!==planHash)fail(409,'plan_changed','Room changed after the reviewed archive plan; plan again');
  const receipt=store.archiveLifecycleRoomAsOperator(ROOM,`operator-archive-${input.requestId}`,input.reason);
  const result={roomId:ROOM,ownerId:owner.id,authority:'operator_on_owner_behalf',archived:true,sequence:receipt.sequence,eventId:receipt.event.id,credentialsChanged:false,duplicate:false};
  appendOperatorAction(store,{action:'room_lifecycle_archived',targetKind:'room',targetId:ROOM,reason:input.reason,requestId:input.requestId,planHash,counts:{...result,originalHead:row.sequence},result:'ok'});
  return {...result,originalHead:row.sequence};
 });
}
