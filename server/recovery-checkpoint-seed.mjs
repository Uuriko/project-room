import {HISTORICAL_REPLAY_MAX_INPUT_BYTES} from './historical-replay-contract.mjs';
import {recoveryReplayOrderKey} from './recovery-replay-order.mjs';
import {initialRecoveryProjectionScan,scanRecoveryProjectionChunk,decodeRecoveryProjectionSpan,recoveryProjectionFrame,REPLAY_CODEC_INPUT_BYTES} from './replay-projection-codec.mjs';
import {planRecoveryReplayValue,writeRecoveryReplayValue,readRecoveryReplayValue} from './recovery-replay-value.mjs';
import {ensureWorkControlDefaults} from '../src/work-item-session.js';
import {deriveReplyContextOwner} from '../src/reply-requests.js';
import {messageChannelId} from '../src/events.js';
import {ensureDefaultChannelState} from '../src/default-channel-state.js';
const maps=new Set(['members','channels','workItems','replyRequests','seenEvents','seenIdempotencyKeys','helpOffers','agentHalts','bonds']);
const counted=new Set(['members','channels','workItems','replyRequests']);
const fail=()=>{throw Error('Recovery checkpoint source requires reconciliation');};
const raw=value=>value instanceof Uint8Array?value:value instanceof ArrayBuffer?new Uint8Array(value):fail();
export function initialRecoveryCheckpointSeed(sequence,sourceBytes,{sourceKind='retained',sourceDigest=null}={}){
 if(!Number.isSafeInteger(sequence)||sequence<0||!Number.isSafeInteger(sourceBytes)||sourceBytes<2)fail();
 if(!['retained','historical'].includes(sourceKind)||(sourceKind==='historical'?!/^[a-f0-9]{64}$/.test(sourceDigest??''):sourceDigest!==null))fail();
 return{version:1,stage:'scan',sequence,sourceBytes,sourceKind,sourceDigest,scan:initialRecoveryProjectionScan(sourceBytes),counts:{members:0,channels:0,workItems:0,replyRequests:0,messages:0,replyRequestsPresent:false},index:0,target:null,node:null,pathLength:0,fixup:0,channel:null,reason:null};
}
function source(db,roomId,cursor,offset,length,historicalBytes){
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||offset+length>cursor.sourceBytes)fail();
 if(cursor.sourceKind==='historical'){if(!(historicalBytes instanceof Uint8Array)||historicalBytes.length!==cursor.sourceBytes)fail();return historicalBytes.subarray(offset,offset+length);}
 const bytes=raw(db.prepare('SELECT substr(CAST(projection AS BLOB),?,?) bytes FROM projection_checkpoints WHERE room_id=? AND sequence=?').get(offset+1,length,roomId,cursor.sequence)?.bytes);
 if(bytes.length!==length)fail();return bytes;
}
// Called only under the existing sealed-target restore transaction/scratch
// scope. It advances original checkpoint byte framing, not source authority.
// Message context indexes and final independent replay/drift are later phases.
export function validateRecoveryCheckpointSeed(cursor){
 if(!cursor||Object.keys(cursor).sort().join(',')!=='channel,counts,fixup,index,node,pathLength,reason,scan,sequence,sourceBytes,sourceDigest,sourceKind,stage,target,version'||cursor.version!==1||!['retained','historical'].includes(cursor.sourceKind)||(cursor.sourceKind==='historical'?!/^[a-f0-9]{64}$/.test(cursor.sourceDigest??''):cursor.sourceDigest!==null)||!['scan','defaults','owners','roots','root_fixup','complete','deferred'].includes(cursor.stage)||!Number.isSafeInteger(cursor.sequence)||cursor.sequence<0||!Number.isSafeInteger(cursor.sourceBytes)||cursor.sourceBytes<2||cursor.scan?.sourceBytes!==cursor.sourceBytes||!Number.isSafeInteger(cursor.index)||cursor.index<0||cursor.index>cursor.counts?.messages||!cursor.counts||Object.keys(cursor.counts).sort().join(',')!=='channels,members,messages,replyRequests,replyRequestsPresent,workItems'||!['members','channels','messages','workItems','replyRequests'].every(key=>Number.isSafeInteger(cursor.counts[key])&&cursor.counts[key]>=0)||typeof cursor.counts.replyRequestsPresent!=='boolean'||[cursor.target,cursor.node].some(value=>value!==null&&(typeof value!=='string'||new TextEncoder().encode(value).length>200))||(cursor.target===null)!==(cursor.node===null)||((cursor.stage==='deferred')!==(typeof cursor.reason==='string'))||cursor.reason!==null&&(typeof cursor.reason!=='string'||cursor.reason.length>128))fail();
 if(!Number.isSafeInteger(cursor.pathLength)||cursor.pathLength<0||cursor.pathLength>cursor.counts.messages||!Number.isSafeInteger(cursor.fixup)||cursor.fixup<0||cursor.fixup>cursor.pathLength||cursor.channel!==null&&(typeof cursor.channel!=='string'||new TextEncoder().encode(cursor.channel).length>200)||(cursor.stage==='root_fixup'&&(cursor.target===null||cursor.channel===null||cursor.pathLength<1)))fail();
 scanRecoveryProjectionChunk(cursor.scan,new Uint8Array());
}
export function advanceRecoveryCheckpointSeed(db,scratch,roomId,previous,maximumValueBytes,historicalBytes=null){
 validateRecoveryCheckpointSeed(previous);const cursor=structuredClone(previous);if(cursor.version!==1||!['retained','historical'].includes(cursor.sourceKind)||(cursor.sourceKind==='historical'?!/^[a-f0-9]{64}$/.test(cursor.sourceDigest??''):cursor.sourceDigest!==null)||!['scan','defaults','owners','roots','root_fixup','complete','deferred'].includes(cursor.stage)||!Number.isSafeInteger(maximumValueBytes)||maximumValueBytes<1)fail();
 if(cursor.sourceKind==='retained'){const held=db.prepare('SELECT sequence,length(CAST(projection AS BLOB)) bytes FROM projection_checkpoints WHERE room_id=?').get(roomId);if(held?.sequence!==cursor.sequence||held.bytes!==cursor.sourceBytes)fail();}else if(!(historicalBytes instanceof Uint8Array)||historicalBytes.length!==cursor.sourceBytes)fail();
 const payloadQuantum=4*1024*1024-(cursor.sourceKind==='historical'?HISTORICAL_REPLAY_MAX_INPUT_BYTES:0);let units=0,bytes=0;
 const defer=reason=>{cursor.stage='deferred';cursor.reason=reason;return{cursor,units,bytes};};
 if(cursor.stage==='scan'){
  let start=cursor.scan.offset,input=source(db,roomId,cursor,start,Math.min(REPLAY_CODEC_INPUT_BYTES,cursor.sourceBytes-start),historicalBytes),position=0;bytes+=input.length;
  while(units<128){
   if(position===input.length){if(cursor.scan.offset === cursor.sourceBytes || bytes + REPLAY_CODEC_INPUT_BYTES > payloadQuantum)break;start=cursor.scan.offset;input=source(db,roomId,cursor,start,Math.min(REPLAY_CODEC_INPUT_BYTES,cursor.sourceBytes-start),historicalBytes);position=0;bytes+=input.length;}
   let step;try{step=scanRecoveryProjectionChunk(cursor.scan,input.subarray(position),{maximumRecords:1});}catch(error){if(error.message==='unsupported or corrupt replay projection codec')return defer('checkpoint_shape_requires_original_oracle');throw error;}
   const record=step.records[0];
   if(!record){cursor.scan=step.state;position+=step.consumed;continue;}
   if(['metadata-map','metadata-array'].includes(record.kind)){recoveryProjectionFrame(record,cursor.sourceBytes);cursor.scan=step.state;position+=step.consumed;units++;continue;}
   if(bytes+record.length>payloadQuantum){if(units)break;return defer('checkpoint_atom_requires_staging');}
   let value;try{value=decodeRecoveryProjectionSpan(source(db,roomId,cursor,record.offset,record.length,historicalBytes),record,cursor.sourceBytes);}catch(error){if(error instanceof SyntaxError||error.message==='unsupported or corrupt replay projection codec')return defer('checkpoint_shape_requires_original_oracle');throw error;}
   const values=[];let domain,key,newCount=null;
   if(record.kind==='array-entry'){/* Original eventLog is discarded by compact; syntax was checked above. */}
   else if(record.kind==='message'){
    domain='messages';key=value.id;if(scratch.get('replay',roomId,domain,key,0)!==undefined)return defer('checkpoint_duplicate_message_requires_original_oracle');
    values.push({domain:'replayOrder',key:JSON.stringify(['messages',cursor.counts.messages]),value:key});newCount='messages';
   }else if(record.kind==='metadata-entry'&&maps.has(record.key)){
    domain=record.key;key=record.entryKey;
    if(domain==='workItems'){const state={workItems:{[key]:value}};ensureWorkControlDefaults(state);value=state.workItems[key];}
    if(counted.has(domain)&&scratch.get('replay',roomId,domain,key,0)===undefined){values.push({domain:'replayOrder',key:JSON.stringify([domain,cursor.counts[domain]]),value:key});if(domain==='workItems')values.push({domain:'workOrder',key:recoveryReplayOrderKey(key,cursor.counts[domain]),value:key});newCount=domain;}
   }else if(record.kind==='metadata-entry'&&record.key==='messagesArchive'){domain='checkpointArchive';key=record.entryKey;}
   else if(record.kind==='metadata-index'){domain='checkpointArchiveRetained';key=String(record.index);}
   else if(record.kind==='metadata'){domain='metadata';key=record.key;}
   else return defer('checkpoint_shape_requires_original_oracle');
   if(domain)values.push({domain,key,value});
   const plans=values.map(entry=>({...entry,plan:planRecoveryReplayValue(entry.value,maximumValueBytes)})),rows=plans.reduce((sum,entry)=>sum+entry.plan.rows,0),cost=record.length+plans.reduce((sum,entry)=>sum+entry.plan.bytes,0);
   if(rows>scratch.remaining||bytes+cost>payloadQuantum){if(units)break;return defer('checkpoint_atom_requires_staging');}
   for(const entry of plans)if(!writeRecoveryReplayValue(scratch,roomId,entry.domain,entry.key,entry.plan))fail();
   if(newCount)cursor.counts[newCount]++;cursor.scan=step.state;position+=step.consumed;units++;bytes+=cost;
  }
  if(cursor.scan.phase==='done'&&cursor.scan.offset===cursor.sourceBytes)cursor.stage='defaults';
  return{cursor,units,bytes};
 }
 if(cursor.stage==='defaults'){
  const quantum=Symbol('checkpoint_default_input_quantum'),get=(domain,key)=>readRecoveryReplayValue(scratch,roomId,domain,key,maximumValueBytes,{admit(size){if(bytes+size>payloadQuantum)throw quantum;bytes+=size;}});
  let room,general;try{room=get('metadata','room');general=get('channels','general');}catch(error){if(error!==quantum)throw error;return defer('checkpoint_atom_requires_staging');}
  if(room?.id!==roomId)fail();const state={room,channels:general===undefined?{}:{general}};
  const values=[{domain:'metadata',key:'checkpointPresence',value:cursor.scan.keys}];
  if(ensureDefaultChannelState(state)){values.push({domain:'channels',key:'general',value:state.channels.general});if(general===undefined)values.push({domain:'replayOrder',key:JSON.stringify(['channels',cursor.counts.channels]),value:'general'});}
  const plans=values.map(entry=>({...entry,plan:planRecoveryReplayValue(entry.value,maximumValueBytes)}));if(plans.reduce((sum,entry)=>sum+entry.plan.rows,0)>scratch.remaining||bytes+plans.reduce((sum,entry)=>sum+entry.plan.bytes,0)>payloadQuantum)return defer('checkpoint_atom_requires_staging');
  for(const entry of plans)if(!writeRecoveryReplayValue(scratch,roomId,entry.domain,entry.key,entry.plan))fail();
  if(general===undefined)cursor.counts.channels++;cursor.counts.replyRequestsPresent=cursor.scan.keys.includes('replyRequests');cursor.stage='owners';units=values.length;bytes+=plans.reduce((sum,entry)=>sum+entry.plan.bytes,0);
 }
 if(['owners','roots','root_fixup'].includes(cursor.stage)){
  const quantum=Symbol('checkpoint_context_input_quantum');
  const get=(domain,key)=>readRecoveryReplayValue(scratch,roomId,domain,key,maximumValueBytes,{admit(size){if(bytes+size>payloadQuantum)throw quantum;bytes+=size;}});
  while(units<128&&scratch.remaining>2){
   if(bytes+4096>payloadQuantum)break;
   if(cursor.stage==='root_fixup'){
    const id=get('checkpointPath',JSON.stringify([cursor.index,cursor.fixup]));if(typeof id!=='string')fail();
    if(!writeRecoveryReplayValue(scratch,roomId,'messageRootChannel',id,planRecoveryReplayValue(cursor.channel,maximumValueBytes)))break;cursor.fixup++;units++;
    if(cursor.fixup===cursor.pathLength){cursor.index++;cursor.target=null;cursor.node=null;cursor.pathLength=0;cursor.fixup=0;cursor.channel=null;cursor.stage='roots';}continue;
   }
   if(cursor.index===cursor.counts.messages){if(cursor.stage==='owners'){cursor.stage='roots';cursor.index=0;continue;}cursor.stage='complete';break;}
   const id=get('replayOrder',JSON.stringify(['messages',cursor.index]));if(typeof id!=='string')fail();
   if(cursor.stage==='owners'){
    let message,parentOwner,request,ownRequest;try{message=get('messages',id);parentOwner=message?.replyToId?get('messageOwner',message.replyToId):undefined;ownRequest=get('replyRequests',id);request=parentOwner?get('replyRequests',parentOwner):undefined;}catch(error){if(error!==quantum)throw error;if(units)break;return defer('checkpoint_atom_requires_staging');}
    if(!message||message.id!==id)fail();const requests=Object.create(null);if(ownRequest!==undefined)requests[id]=ownRequest;if(parentOwner&&request!==undefined)requests[parentOwner]=request;
    const owner=deriveReplyContextOwner(message,requests,parentOwner);writeRecoveryReplayValue(scratch,roomId,'messageOwner',id,planRecoveryReplayValue(owner,maximumValueBytes));cursor.index++;units++;continue;
   }
   if(cursor.target===null){if(get('messageRootChannel',id)!==undefined){cursor.index++;units++;continue;}cursor.target=id;cursor.node=id;}
   if(cursor.target!==id||typeof cursor.node!=='string')fail();
   const visited=JSON.stringify([cursor.index,cursor.node]);if(scratch.get('replay',roomId,'checkpointWalk',visited)!==undefined)return defer('checkpoint_ancestry_requires_original_oracle');
   let message,parent,known;try{message=get('messages',cursor.node);parent=message?.replyToId&&scratch.get('replay',roomId,'messages',message.replyToId,0)!==undefined?message.replyToId:null;known=parent?get('messageRootChannel',parent):undefined;}catch(error){if(error!==quantum)throw error;if(units)break;return defer('checkpoint_atom_requires_staging');}
   if(!message||message.id!==cursor.node)fail();
   if(!writeRecoveryReplayValue(scratch,roomId,'checkpointPath',JSON.stringify([cursor.index,cursor.pathLength]),planRecoveryReplayValue(cursor.node,maximumValueBytes)))break;cursor.pathLength++;
   if(!parent||known!==undefined){const channel=known??messageChannelId(message);if(typeof channel!=='string'||!channel)fail();if(new TextEncoder().encode(channel).length>200)return defer('checkpoint_channel_requires_original_oracle');cursor.channel=channel;cursor.stage='root_fixup';}
   else{scratch.put('replay',roomId,'checkpointWalk',visited,true);cursor.node=parent;}
   units++;
  }
 }
 return{cursor,units,bytes};
}
