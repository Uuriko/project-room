import {initialRecoveryProjectionScan,scanRecoveryProjectionChunk,decodeRecoveryProjectionSpan,recoveryProjectionFrame,REPLAY_CODEC_INPUT_BYTES} from './replay-projection-codec.mjs';
import {planRecoveryReplayValue,writeRecoveryReplayValue,readRecoveryReplayValue} from './recovery-replay-value.mjs';
import {Buffer} from 'node:buffer';
import {isDeepStrictEqual} from 'node:util';
import {advanceReplyRequestAudit,exactReplyAuditMessage} from './recovery-reply-rules.mjs';
import {bindCurrentRecordContext} from '../src/current-record-context.js';
import {deriveReplyContextOwner} from '../src/reply-requests.js';
import {inRestoreContext,restoreProgress,RESTORE_AUDIT_UNIT_BYTES} from './restore-admission.mjs';
import {withCurrentAuditUnits} from './current-room-repository.mjs';
import {MESSAGE_PROOF_SELECT} from './write-integrity.mjs';
import {archiveRetains} from './current-room-archive.mjs';
const LIMIT=4*1024*1024,quantum=Symbol('reply audit quantum');
const fail=()=>{throw Error('Independent reply request history requires reconciliation');};
const order=sequence=>String(sequence).padStart(16,'0');
export const initialRecoveryReplies=()=>({version:1,stage:'checkpoint_scan',sequence:0,room:null,hasRequests:false,requests:0,messages:0,after:'',actualSequence:0,actualId:'',compared:0,checkpoint:null,reason:null});
export function validateRecoveryReplies(p){
 if(!p||Object.keys(p).sort().join(',')!==Object.keys(initialRecoveryReplies()).sort().join(',')||p.version!==1||!['checkpoint_scan','events','checkpoint_requests','checkpoint_messages','final_requests','final_messages','complete','deferred'].includes(p.stage)||typeof p.hasRequests!=='boolean'||!['sequence','requests','messages','compared','actualSequence'].every(k=>Number.isSafeInteger(p[k])&&p[k]>=0)||typeof p.after!=='string'||Buffer.byteLength(p.after)>200||typeof p.actualId!=='string'||Buffer.byteLength(p.actualId)>200||p.room!==null&&(!p.room||Object.keys(p.room).sort().join(',')!=='id,ownerId')||p.reason!==null&&(typeof p.reason!=='string'||p.reason.length>128)||(p.stage==='deferred')!==(p.reason!==null))fail();
 if(p.checkpoint!==null){const cp=p.checkpoint;if(!cp||Object.keys(cp).sort().join(',')!=='bytes,compared,messages,present,requests,scan,sequence'||!['sequence','requests','messages'].every(k=>Number.isSafeInteger(cp[k])&&cp[k]>=0)||!Number.isSafeInteger(cp.bytes)||cp.bytes<2||typeof cp.present!=='boolean'||typeof cp.compared!=='boolean'||cp.scan?.sourceBytes!==cp.bytes)fail();scanRecoveryProjectionChunk(cp.scan,new Uint8Array());}
 if(['checkpoint_requests','checkpoint_messages'].includes(p.stage)&&(!p.checkpoint||p.checkpoint.compared))fail();
 if(['final_requests','final_messages','complete'].includes(p.stage)&&p.checkpoint&&!p.checkpoint.compared)fail();
 if(Buffer.byteLength(JSON.stringify(p))>RESTORE_AUDIT_UNIT_BYTES)fail();
}
export function advanceRecoveryReplies(store,scratch,restoreId,roomId,previous,seal,{maxUnits=32}={}){
 validateRecoveryReplies(previous);if(!Number.isSafeInteger(maxUnits)||maxUnits<1||maxUnits>32)fail();const p=structuredClone(previous),db=store.db;let bytes=0,units=0;
 if(!db.isTransaction||!inRestoreContext(db))fail();const admission=restoreProgress(db);
 if(admission.state!=='pending'||admission.restore_id!==restoreId||admission.phase!=='audit_pending'||seal?.id!==admission.seal?.id)fail();
 const checkpointBound=admission.seal.tables.find(t=>t.name==='projection_checkpoints')?.maxRowBytes??0;
 const maximumValueBytes=Math.max(1,checkpointBound+4096);
 const maximum=admission.seal.tables.find(t=>t.name==='events')?.maxRowBytes;if(!Number.isSafeInteger(maximum)||maximum<0)fail();
 const admit=n=>{if(!Number.isSafeInteger(n)||n<0||!Number.isSafeInteger(bytes+n))fail();if(bytes+n>LIMIT&&units)throw quantum;bytes+=n;};
 // A fresh addressed-read cache per unit; never a room-sized historical map.
 let cache=new Map();
 const cpGet=(domain,key)=>readRecoveryReplayValue(scratch,roomId,domain,key,maximumValueBytes,{admit});
 let sourceCache=null,sourceStart=0;
 const source=(offset,length)=>{if(sourceCache&&offset>=sourceStart&&offset+length<=sourceStart+sourceCache.length)return sourceCache.subarray(offset-sourceStart,offset-sourceStart+length);const row=db.prepare('SELECT substr(CAST(projection AS BLOB),?,?) bytes FROM projection_checkpoints WHERE room_id=? AND sequence=?').get(offset+1,length,roomId,p.checkpoint.sequence);const cell=row?.bytes,value=cell instanceof ArrayBuffer?new Uint8Array(cell):cell;if(!(value instanceof Uint8Array)||value.length!==length)fail();if(length<=REPLAY_CODEC_INPUT_BYTES){sourceCache=value;sourceStart=offset;}return value;};
 const get=(domain,key,lane='history')=>{
  if(typeof key!=='string')return undefined;const tag=JSON.stringify([lane,domain,key]);if(cache.has(tag))return cache.get(tag);
  const size=db.prepare('SELECT payload_bytes,length(CAST(payload AS BLOB)) bytes FROM current_restore_audit_scratch WHERE restore_id=? AND lane=? AND room_id=? AND domain=? AND unit_key=? AND part=0').get(restoreId,lane,roomId,domain,key);
  if(size){if(size.bytes!==size.payload_bytes||!Number.isSafeInteger(size.bytes)||size.bytes<1||size.bytes>RESTORE_AUDIT_UNIT_BYTES)fail();admit(size.bytes);}
  const value=scratch.get(lane,roomId,domain,key);cache.set(tag,value===undefined?undefined:structuredClone(value));return cache.get(tag);
 };
 return withCurrentAuditUnits(store,roomId,reader=>{
  if(!reader.head)fail();
  try{while(units < maxUnits && bytes < LIMIT && scratch.remaining >= 16 && !['complete','deferred'].includes(p.stage)){
   cache=new Map();
   if(p.stage==='checkpoint_scan'){
    if(p.checkpoint===null){const held=db.prepare('SELECT sequence,length(CAST(projection AS BLOB)) bytes FROM projection_checkpoints WHERE room_id=?').get(roomId);if(!held){p.stage='events';continue;}
     if(!Number.isSafeInteger(held.sequence)||held.sequence<0||held.sequence>reader.head.sequence||!Number.isSafeInteger(held.bytes)||held.bytes<2||held.bytes>checkpointBound)fail();
     p.checkpoint={sequence:held.sequence,bytes:held.bytes,scan:initialRecoveryProjectionScan(held.bytes),requests:0,messages:0,present:false,compared:false};
    }
    const cp=p.checkpoint;if(cp.scan.phase==='done'){p.stage='events';continue;}
    const length=sourceCache&&cp.scan.offset>=sourceStart&&cp.scan.offset<sourceStart+sourceCache.length?sourceStart+sourceCache.length-cp.scan.offset:Math.min(REPLAY_CODEC_INPUT_BYTES,cp.bytes-cp.scan.offset);if(length<1)fail();admit(length);
    const input=source(cp.scan.offset,length);let step;
    try{step=scanRecoveryProjectionChunk(cp.scan,input,{maximumRecords:1});}catch(error){if(error.message!=='unsupported or corrupt replay projection codec')throw error;p.stage='deferred';p.reason='checkpoint_shape_requires_original_oracle';break;}
    const record=step.records[0];if(!record){cp.scan=step.state;continue;}
    if(['metadata-map','metadata-array'].includes(record.kind)){recoveryProjectionFrame(record,cp.bytes);if(record.kind==='metadata-map'&&record.key==='replyRequests')cp.present=true;cp.scan=step.state;units++;continue;}
    admit(record.length);let value;
    try{value=decodeRecoveryProjectionSpan(source(record.offset,record.length),record,cp.bytes);}catch(error){if(!(error instanceof SyntaxError)&&error.message!=='unsupported or corrupt replay projection codec')throw error;p.stage='deferred';p.reason='checkpoint_shape_requires_original_oracle';break;}
    let domain,key;
    if(record.kind==='message'){domain='rrCheckpointMessage';key=String(cp.messages);value=exactReplyAuditMessage(value);}
    if(record.kind==='metadata-entry'&&record.key==='replyRequests'){domain='rrCheckpointRequest';key=record.entryKey;cp.present=true;}
    if(domain){const plan=planRecoveryReplayValue(value,maximumValueBytes);admit(plan.bytes);if(plan.rows>scratch.remaining){if(units)break;p.stage='deferred';p.reason='checkpoint_atom_requires_original_oracle';break;}
     const exists=get(domain,key,'replay')!==undefined;if(!writeRecoveryReplayValue(scratch,roomId,domain,key,plan))fail();if(domain==='rrCheckpointMessage')cp.messages++;else if(!exists)cp.requests++;
    }
    cp.scan=step.state;units++;continue;
   }
   if(p.stage==='checkpoint_requests'){
    const cp=p.checkpoint;if(cp.present!==p.hasRequests||cp.requests!==p.requests)fail();
    const key=scratch.nextKey('history',roomId,'rrRequest',p.after);if(key===undefined){if(p.compared!==p.requests)fail();p.stage='checkpoint_messages';p.after='';p.compared=0;continue;}
    if(!isDeepStrictEqual(cpGet('rrCheckpointRequest',key),get('rrRequest',key)))fail();p.after=key;p.compared++;units++;continue;
   }
   if(p.stage==='checkpoint_messages'){
    const cp=p.checkpoint;if(!p.hasRequests){cp.compared=true;p.stage='events';p.after='';p.compared=0;continue;}
    const key=scratch.nextKey('history',roomId,'rrMessageOrder',p.after);if(key===undefined){if(p.compared!==p.messages||cp.messages!==p.messages)fail();cp.compared=true;p.stage='events';p.after='';p.compared=0;continue;}
    const id=get('rrMessageOrder',key),expected=get('rrMessage',id),actual=cpGet('rrCheckpointMessage',String(p.compared));if(!actual||!isDeepStrictEqual(exactReplyAuditMessage(actual),expected))fail();p.after=key;p.compared++;units++;continue;
   }
   if(p.stage==='events'){
    if(p.checkpoint&&!p.checkpoint.compared&&p.sequence>p.checkpoint.sequence)fail();
    if(p.checkpoint&&!p.checkpoint.compared&&p.sequence===p.checkpoint.sequence){p.stage='checkpoint_requests';p.after='';p.compared=0;continue;}
    const scalar=db.prepare('SELECT rowid,sequence,length(CAST(body AS BLOB)) bytes FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT 1').get(roomId,p.sequence);
    if(!scalar){if(p.sequence!==reader.head.sequence)fail();p.stage='final_requests';p.after='';p.compared=0;continue;}
    if(!Number.isSafeInteger(scalar.bytes)||scalar.bytes<1||scalar.bytes>maximum||scalar.sequence!==p.sequence+1)fail();admit(scalar.bytes+4096);
    const row=db.prepare('SELECT sequence,body FROM events WHERE rowid=?').get(scalar.rowid),e=JSON.parse(row.body),d=e.data;
    const state={room:p.room?{...p.room}:null,members:{},workItems:{},messages:[]};
    const memberKeys=new Set([e.actorId,d.memberId,d.toMemberId,p.room?.ownerId]);
    for(const id of memberKeys)if(typeof id==='string'){const value=get('rrMember',id);if(value!==undefined)Object.defineProperty(state.members,id,{value,writable:true,enumerable:true,configurable:true});}
    if(typeof d.workItemId==='string'&&get('rrWork',d.workItemId)!==undefined)Object.defineProperty(state.workItems,d.workItemId,{value:{},writable:true,enumerable:true,configurable:true});
    const messageId=e.type==='message.posted'?(d.messageId||e.id):d.messageId,messageKeys=new Set([messageId,d.replyToId]);
    for(const id of messageKeys)if(typeof id==='string'){const value=get('rrMessage',id);if(value!==undefined)state.messages.push(value);}
    const parentOwner=get('rrOwner',d.replyToId),requestKeys=new Set([d.responseToRequestId,d.requestMessageId,messageId,parentOwner]);
    if(p.hasRequests)state.replyRequests={};
    for(const id of requestKeys)if(typeof id==='string'){const value=get('rrRequest',id);if(value!==undefined)Object.defineProperty(state.replyRequests??={},id,{value,writable:true,enumerable:true,configurable:true});}
    const currentOwner=deriveReplyContextOwner({id:messageId,workItemId:d.workItemId||null},state.replyRequests??{},parentOwner);
    bindCurrentRecordContext(state,{replyRequestCount:p.requests,replyOwner:id=>id===messageId?currentOwner:get('rrOwner',id)});
    const beforeMembers=new Map(Object.entries(state.members).map(([key,value])=>[key,JSON.stringify(value)]));
    const beforeMessages=new Map(state.messages.map(value=>[value.id,JSON.stringify(value)]));
    const beforeRequests=new Map(Object.entries(state.replyRequests??{}).map(([key,value])=>[key,JSON.stringify(value)]));
    const pendingPosts=new Map();
    advanceReplyRequestAudit(state,row,{posts:{get:key=>pendingPosts.has(String(key))?pendingPosts.get(String(key)):get('rrPost',String(key)),set:(key,value)=>pendingPosts.set(String(key),value)},ids:{has:key=>get('rrMessage',key)!==undefined,add(){}}});
    // All reads and original semantic checks completed before any scratch write.
    for(const[key,value]of Object.entries(state.members))if(beforeMembers.get(key)!==JSON.stringify(value))scratch.set('history',roomId,'rrMember',key,value);
    if(e.type==='work.proposed')scratch.set('history',roomId,'rrWork',d.workItemId,true);
    for(const[key,value]of Object.entries(state.replyRequests??{}))if(beforeRequests.get(key)!==JSON.stringify(value)){if(!beforeRequests.has(key))p.requests++;scratch.set('history',roomId,'rrRequest',key,value);}
    for(const value of state.messages){const exact=exactReplyAuditMessage(value);if(beforeMessages.get(value.id)!==JSON.stringify(exact))scratch.set('history',roomId,'rrMessage',value.id,exact);}
    for(const[key,value]of pendingPosts)scratch.set('history',roomId,'rrPost',key,value);
    if(e.type==='message.posted'){
     const message=state.messages.find(value=>value.id===messageId),owner=deriveReplyContextOwner(message,state.replyRequests??{},parentOwner);
     scratch.set('history',roomId,'rrOwner',messageId,owner??null);scratch.put('history',roomId,'rrMessageOrder',order(row.sequence),messageId);p.messages++;
    }
    p.room=state.room;p.hasRequests=Object.hasOwn(state,'replyRequests');p.sequence=row.sequence;units++;continue;
   }
   if(p.stage==='final_requests'){
    const actualPresent=get('shape','replyRequests','actual')!==undefined||get('metadata','replyRequests','actual')!==undefined;
    if(actualPresent!==p.hasRequests||reader.head.counts.replyRequests!==p.requests)fail();
    const key=scratch.nextKey('history',roomId,'rrRequest',p.after);
    if(key===undefined){if(p.compared!==p.requests)fail();p.stage='final_messages';p.after='';p.compared=0;continue;}
    const expected=get('rrRequest',key),actual=get('replyRequests',key,'actual');if(!isDeepStrictEqual(actual,expected))fail();p.after=key;p.compared++;units++;continue;
   }
   if(p.stage==='final_messages'){
    if(!p.hasRequests){p.stage='complete';break;}
    const key=scratch.nextKey('history',roomId,'rrMessageOrder',p.after),marker=get('metadata','messagesArchive','actual');
    const id=key===undefined?undefined:get('rrMessageOrder',key),retained=id===undefined?undefined:get('archiveRetained',id,'actual');
    if(key!==undefined&&!archiveRetains(marker,Number(key),retained)){p.after=key;units++;continue;}
    const next=db.prepare('SELECT rowid,seq,length(CAST(message_id AS BLOB)) bytes FROM messages WHERE room_id=? AND (seq>? OR (seq=? AND message_id>?)) ORDER BY seq,message_id LIMIT 1').get(roomId,p.actualSequence,p.actualSequence,p.actualId);
    if(!next){if(key!==undefined||p.compared!==reader.head.counts.messages-(marker?.count??0))fail();p.stage='complete';break;}
    if(!Number.isSafeInteger(next.seq)||next.seq<1||next.bytes<1||next.bytes>200)fail();admit(next.bytes+256);
    const actualId=db.prepare('SELECT message_id FROM messages WHERE rowid=?').get(next.rowid).message_id;
    if(!archiveRetains(marker,next.seq,get('archiveRetained',actualId,'actual'))){p.actualSequence=next.seq;p.actualId=actualId;units++;continue;}
    if(id!==actualId)fail();
    const expected=get('rrMessage',id),columns=MESSAGE_PROOF_SELECT.split(',').map(k=>`coalesce(length(CAST(${k} AS BLOB)),0)`).join('+');
    const size=db.prepare(`SELECT ${columns} bytes FROM messages WHERE rowid=?`).get(next.rowid);
    const witness=db.prepare("SELECT r.payload_bytes,(SELECT length(CAST(a.counts_json AS BLOB)) FROM operator_actions a WHERE a.id=p.receipt_id AND a.action='current_room_transition') receipt_bytes FROM current_room_record_proofs p LEFT JOIN current_room_records r ON r.room_id=p.room_id AND r.domain=p.domain AND r.record_key=p.record_key WHERE p.room_id=? AND p.domain='messageWitness' AND p.record_key=?").get(roomId,id);
    if(!Number.isSafeInteger(size?.bytes)||size.bytes<1||!Number.isSafeInteger(witness?.payload_bytes)||!Number.isSafeInteger(witness?.receipt_bytes))fail();admit(size.bytes+witness.payload_bytes+witness.receipt_bytes+4096);
    const actual=reader.message(id)?.value;if(!actual||!isDeepStrictEqual(exactReplyAuditMessage(actual),expected))fail();
    p.actualSequence=next.seq;p.actualId=actualId;p.compared++;p.after=key;units++;continue;
   }
   fail();
  }}catch(error){if(error!==quantum)throw error;}
  return{cursor:p,units,bytes,done:['complete','deferred'].includes(p.stage)};
 });
}
