// Room credential, CSRF, API-key scope and fresh authority gates precede all record-only rails.
import {railActor} from '../trial-task-store.mjs';
function access(ctx,writing){
 const roomId=ctx.params.roomId,selected=ctx.roomCredentials(ctx.req,ctx.url);
 const fence=selected.mode==='account'?ctx.accountBinding(ctx.req,null):ctx.expectedBinding(ctx.req);
 const auth=ctx.roomAuth(selected,roomId,fence);
 if(selected.bearer&&auth.credentialScope!=='room')ctx.reject(403,'access_denied','Bearer account sessions are not accepted');
 if(!selected.bearer&&auth.kind!=='session')ctx.reject(401,'unauthenticated','Browser session required');
 if(auth.kind==='api-key'){const needed=writing?'rooms:write':'rooms:read';if(!(auth.apiKeyScopes??[]).some(s=>s===needed||(s.endsWith(':*')&&needed.startsWith(s.slice(0,-1)))))ctx.reject(403,'insufficient_scope','API key lacks required scope');}
 if(writing){ctx.protectWrite(ctx.req,auth,selected.bearer);ctx.rate(`write:${auth.credentialHash}`,60);}else ctx.rate(`read:${auth.credentialHash}`,600);
 railActor(ctx.store,roomId,auth.member.id,{writing});return {roomId,actorId:auth.member.id};
}
function privateRecord(ctx,roomId,actorId,record){const owner=ctx.store.room(roomId).state.room.ownerId;let candidate=record.parties?.workerId;if(record.trialTaskId)candidate=ctx.store.trialTasks.raw(roomId,record.trialTaskId).candidateId;if(actorId!==owner&&actorId!==(record.buyerId??record.parties?.buyerId)&&actorId!==candidate)ctx.reject(403,'access_denied','Record is private to its parties');return record;}
const handler=(service,action)=>async ctx=>{
 try {
  let {roomId,actorId}=access(ctx,ctx.req.method==='POST');
  const owner=ctx.store.room(roomId).state.room.ownerId,domain=ctx.store[service],id=ctx.params.recordId;
  if(ctx.req.method==='POST'){
   const input=await ctx.body(ctx.req);({roomId,actorId}=access(ctx,true));
   const result=service==='trialTasks'?domain.apply(roomId,actorId,input):action==='create'?domain.create(roomId,actorId,input):domain[action](roomId,actorId,id,input);
   return ctx.json(ctx.res,action==='create'?201:200,result);
  }
  if(service==='trialTasks'&&action==='receipt'){const task=domain.read(roomId,actorId,id);const row=ctx.store.db.prepare('SELECT value FROM room_vetting_receipts WHERE room_id=? AND task_id=?').get(roomId,task.id);if(!row)ctx.reject(404,'receipt_not_found','No verified receipt');const saved=JSON.parse(row.value);return ctx.json(ctx.res,200,{roomId,receipt:saved.receipt,issuer:{pubkey:saved.trust.pubkey,configuredBy:saved.trust.configuredBy},verifiedAt:saved.verifiedAt,recordOnly:true});}
  if(service==='trialTasks')return ctx.json(ctx.res,200,action==='list'?domain.list(roomId,actorId):domain.read(roomId,actorId,id));
  if(action==='list'){if(actorId!==owner)ctx.reject(403,'owner_only','Only owner may enumerate private records');return ctx.json(ctx.res,200,domain.list(roomId,{limit:ctx.url.searchParams.get('limit')??20,after:ctx.url.searchParams.get('after')}));}
  const record=privateRecord(ctx,roomId,actorId,domain.get(roomId,id));
  if(action==='document'){const doc=domain.document(roomId,id);ctx.res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Length':Buffer.byteLength(doc),'Cache-Control':'private, no-store'});return ctx.res.end(ctx.req.method==='HEAD'?undefined:doc);}
  return ctx.json(ctx.res,200,action==='status'?domain.status(roomId,id):record);
 } catch(error){if(error.status)ctx.reject(error.status,error.code,error.message);if(error.name==='TrialTaskError')ctx.reject(error.code==='illegal_transition'?409:422,error.code,error.message);throw error;}
};
const params={type:'object',required:['roomId'],properties:{roomId:{type:'string'},recordId:{type:'string'}}};
const response={type:'object'};
const route=(id,method,path,service,action)=>Object.freeze({id,method,path,auth:'room',capability:null,scope:'room',handler:handler(service,action),schema:{params,...(method==='POST'?{body:{type:'object'}}:{}),response},events:[]});
const rows=[];
for(const [service,base,actions] of [['demigodOffers','demigod-offers',['present','accept','decline','expire','withdraw']],['demigodContracts','demigod-contracts',['acknowledge','complete','terminate']],['buyerSignoff','signoff-loops',['submit','review','cancel']]]){
 const path=`/api/rooms/{roomId}/${base}`;
 rows.push(route(`${base}-list`,'GET',path,service,'list'),route(`${base}-create`,'POST',path,service,'create'),route(`${base}-get`,'GET',path+'/{recordId}',service,'get'));
 for(const action of actions)rows.push(route(`${base}-${action}`,'POST',path+'/{recordId}/'+action,service,action));
 if(service==='demigodOffers')rows.push(route(`${base}-document`,'GET',path+'/{recordId}/document',service,'document'));
 if(service==='buyerSignoff')rows.push(route(`${base}-status`,'GET',path+'/{recordId}/status',service,'status'));
}
rows.push(route('trial-tasks-list','GET','/api/rooms/{roomId}/trial-tasks','trialTasks','list'),route('trial-tasks-apply','POST','/api/rooms/{roomId}/trial-tasks','trialTasks','apply'),route('trial-tasks-read','GET','/api/rooms/{roomId}/trial-tasks/{recordId}','trialTasks','read'));
rows.push(route('trial-tasks-receipt','GET','/api/rooms/{roomId}/trial-tasks/{recordId}/receipt','trialTasks','receipt'));
export const RECORD_RAIL_ROUTES=Object.freeze(rows);
