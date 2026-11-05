// Alternate receive path. No ACP host, body reads, execution lease or Room writes.
import {createHash, randomUUID} from 'node:crypto';
import {isAbsolute, join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as pause} from 'node:timers/promises';
import {RoomClient, RoomError} from './room.mjs';
import {configDir} from './credentials.mjs';
import {normalizeBase} from './link.mjs';
import {readPrivateJson} from './private-files.mjs';
import {openJoinJournal} from './private-state.mjs';
import {createCloudNotifier} from './cloud-notify.mjs';
const closed=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const id=(v,max)=>typeof v==='string'&&v.length<=max&&/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(v)&&!['constructor','prototype','__proto__'].includes(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const invalid=()=>new RoomError(409,'notification_context_unavailable','Notification context is invalid; inspect the private checkpoint before restarting');
const sleep=(ms,signal)=>pause(ms,undefined,{signal});
function configuration(path){
 try{
  if(typeof path!=='string'||!isAbsolute(path))throw Error();
  const c=readPrivateJson(path,8192);
  if(!closed(c,['executable','sessionId',...(Object.hasOwn(c,'bootstrapAfter')?['bootstrapAfter']:[])])
   ||typeof c.executable!=='string'||!isAbsolute(c.executable)||c.executable.includes('\0')
   ||typeof c.sessionId!=='string'||!/^session_[A-Za-z0-9]{16,128}$/.test(c.sessionId)
   ||c.bootstrapAfter!==undefined&&!integer(c.bootstrapAfter))throw Error();
  return c;
 }catch{throw Error('Choose a valid private notification config with an absolute executable, existing sessionId and explicit bootstrapAfter for first use');}
}
function batchValid(batch,roomId,after){
 return closed(batch,['roomId','items'])&&batch.roomId===roomId&&Array.isArray(batch.items)&&batch.items.length>=1&&batch.items.length<=16
  &&batch.items.every(p=>closed(p,['messageId','sequence'])&&id(p.messageId,128)&&integer(p.sequence)&&p.sequence>0&&p.sequence<=after)
  &&new Set(batch.items.map(p=>p.messageId)).size===batch.items.length;
}
function stateValid(state,scope,roomId){
 if(!closed(state,['version','scope','after','inFlight'])||state.version!==1||state.scope!==scope||!integer(state.after))return false;
 const p=state.inFlight;
 return p===null||closed(p,['after','batch'])&&integer(p.after)&&p.after>state.after&&batchValid(p.batch,roomId,p.after)
  &&p.batch.items.every(item=>item.sequence>state.after);
}
export function attentionResult(envelope,{requestId,roomId,memberId,after,timeoutSec}){
 if(envelope?.jsonrpc!=='2.0'||envelope.id!==requestId||envelope.error||!envelope.result)throw invalid();
 const value=envelope.result.structuredContent;
 if(envelope.result.isError===true){
  if(!integer(value?.status)||value.status<400||value.status>599||typeof value.code!=='string')throw invalid();
  throw new RoomError(value.status,value.code,'Attention wait refused; no notification was sent');
 }
 if(!closed(value,['roomId','memberId','status','items','after','sourceComplete','globalAttentionComplete','acknowledges','timeoutSec','waitedMs','nextRead'])
  ||value.roomId!==roomId||value.memberId!==memberId||!['ready','timeout','catch_up_required'].includes(value.status)
  ||!integer(value.after)||value.after<after||typeof value.sourceComplete!=='boolean'||value.globalAttentionComplete!==false||value.acknowledges!==false
  ||value.timeoutSec!==timeoutSec||!integer(value.waitedMs)||!Array.isArray(value.items)||value.items.length>4)throw invalid();
 const seen=new Set();
 const items=value.items.map(p=>{
  // A task that now waits on this member rides the same pointer shape as work:<id>.
  const work=p?.kind==='work';
  if(work?!closed(p,['kind','workItemId','workRevision','sequence','nextRead'])||!id(p.workItemId,123)||!integer(p.workRevision)
   :!closed(p,['kind','messageId','sequence','nextRead'])||!['direct_message','reply','mention','reply_request'].includes(p.kind)||!id(p.messageId,128))throw invalid();
  const messageId=work?'work:'+p.workItemId:p.messageId;
  if(!integer(p.sequence)||p.sequence<=after||p.sequence>value.after||seen.has(messageId))throw invalid();
  seen.add(messageId);return{messageId,sequence:p.sequence};
 });
 if(value.status==='ready'?!items.length:items.length>0)throw invalid();
 if(value.status==='catch_up_required'&&value.after===after||value.status==='timeout'&&!value.sourceComplete)throw invalid();
 return{status:value.status,after:value.after,sourceComplete:value.sourceComplete,items}; // Discard every server nextRead.
}
export async function receiveCloudNotifications({connection,configFile,env=process.env,fetchImpl=fetch,print=()=>{},signal,
 openReceipt=openJoinJournal,notifierFactory=createCloudNotifier,now=()=>performance.now(),delay=sleep}){
 const config=configuration(configFile);
 let apiBase;try{const u=new URL(connection.apiBase);if(u.username||u.password||u.search||u.hash)throw Error();apiBase=normalizeBase(connection.apiBase);}catch{throw invalid();}
 if(!id(connection.roomId,64)||!id(connection.memberId,128)||typeof connection.credential!=='string'||!connection.credential)throw invalid();
 const scope=hash([apiBase,connection.roomId,connection.memberId,config.executable,config.sessionId]);
 const root=join(configDir(env),'notify-state');
 const journal=openReceipt(root,'receiver-'+scope); // Held for entire receiver lifetime.
 try{
  let state=journal.read();
  if(state&&!stateValid(state,scope,connection.roomId))throw invalid();
  if(!state){if(config.bootstrapAfter===undefined)throw Error('First notification start requires explicit bootstrapAfter; no history was selected');state={version:1,scope,after:config.bootstrapAfter,inFlight:null};journal.save(state);}
  const room=new RoomClient({apiBase,roomId:connection.roomId,memberId:connection.memberId,credential:connection.credential,fetchImpl,signal});
  const notify=notifierFactory({executable:config.executable,sessionId:config.sessionId,roomId:connection.roomId,stateRoot:join(root,'source-'+scope),env});
  let lastStart=-Infinity,failures=0;
  const wait=async(after,timeoutSec)=>{
   const remaining=lastStart+2500-now();if(remaining>0)await delay(remaining,signal);signal?.throwIfAborted();lastStart=now();
   const requestId=randomUUID();
   const envelope=await room.request('/mcp',{body:{jsonrpc:'2.0',id:requestId,method:'tools/call',params:{name:'room_wait_for_attention',arguments:{roomId:connection.roomId,after,timeoutSec,includeWork:true}}},timeoutMs:(timeoutSec+15)*1000,signal});
   return attentionResult(envelope,{requestId,roomId:connection.roomId,memberId:connection.memberId,after,timeoutSec});
  };
  print('Notification-only receiver: pointers to configured session; no execution, acknowledgement or closure. Bootstrap does not clear older obligations.');
  while(!signal?.aborted){
   try{
    if(state.inFlight){
     await room.checkConnection(); // Revalidate the exact saved seat on cold in-flight recovery too.
     const outcome=await notify(state.inFlight.batch);
     if(!['accepted','unknown'].includes(outcome?.state))throw invalid();
     // Actuator v2 retains the exact source batch with its accepted/unknown receipt.
     const next={...state,after:state.inFlight.after,inFlight:null};journal.save(next);state=next;
     print(`Notification ${outcome.state}: ${state.after} examined source sequence; execution not verified.`);
     failures=0;continue;
    }
    const first=await wait(state.after,120);let after=first.after;
    const combined=new Map(first.items.map(item=>[item.messageId,item]));
    if(first.status==='ready'&&!first.sourceComplete){
     for(let frames=1;frames<4;frames++){
      const page=await wait(after,0);after=page.after;
      // A later valid source frame may re-mention an edited message.
      // Retain its newest sequence without manufacturing a second notification.
      for(const item of page.items)combined.set(item.messageId,item);
      if(page.status!=='ready'||page.sourceComplete)break;
     }
    }
    const items=[...combined.values()];
    const next={...state,...(items.length?{inFlight:{after,batch:{roomId:connection.roomId,items}}}:{after})};
    if(!stateValid(next,scope,connection.roomId))throw invalid();
    journal.save(next);state=next;failures=0;
   }catch(error){
    if(signal?.aborted)return 0;
    if(!(error instanceof RoomError))throw error; // Storage/provider ambiguity never retries blindly.
    if(![0,429,500,502,503,504].includes(error.status)||['attention_wait_superseded','attention_wait_binding_changed'].includes(error.code)){
     print('Notification receiver stopped: attention access, binding or receiver-role conflict; checkpoint retained.');return error.status===401||error.status===403?3:4;
    }
    failures++;
    try{await delay(error.retryAfterMs??Math.min(60000,2500*2**Math.min(failures,5)),signal);}
    catch(cancelled){if(signal?.aborted)return 0;throw cancelled;}
   }
  }
  return 0;
 }finally{journal.close();}
}
