// One notification to an operator-selected existing cloud session. No Room I/O,
// model relay, session creation, execution ownership or approval is implied.
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {openJoinJournal} from './private-state.mjs';
import {childEnvFor} from './agents.mjs';
export const CLOUD_NOTIFY_LIMITS=Object.freeze({signals:50,outputBytes:8192,timeoutMs:15000});
const digest=value=>createHash('sha256').update(value).digest('hex');
const closed=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const id=(value,max)=>typeof value==='string'&&value.length<=max&&/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)&&!['constructor','prototype','__proto__'].includes(value);
const invoke=(file,args,options)=>new Promise(resolve=>{
 const child=execFile(file,args,options,(error,stdout)=>resolve({error,stdout}));
 // The prompt is argv-only. Never allow ambient input or leave the CLI awaiting EOF.
 child.stdin?.end();
});
const result=(receipt,duplicate)=>Object.freeze({state:receipt.phase,operationId:receipt.operationId,duplicate,execution:'not_verified',roomState:'unchanged',...(receipt.reason?{reason:receipt.reason}:{})});
function pointerOf(pointer){
 if(closed(pointer,['roomId','items'])&&id(pointer.roomId,64)&&Array.isArray(pointer.items)&&pointer.items.length>=1&&pointer.items.length<=16){
  const items=pointer.items.map(item=>{
   if(!closed(item,['messageId','sequence'])||!id(item.messageId,128)||!Number.isSafeInteger(item.sequence)||item.sequence<1)throw Error('Invalid notification pointer');
   return {messageId:item.messageId,sequence:item.sequence};
  }).sort((a,b)=>a.sequence-b.sequence||(a.messageId<b.messageId?-1:a.messageId>b.messageId?1:0));
  if(new Set(items.map(item=>item.messageId)).size!==items.length)throw Error('Invalid notification pointer');
  return {roomId:pointer.roomId,items};
 }
 if(!closed(pointer,['roomId','messageId','signalIds'])||!id(pointer.roomId,64)||!id(pointer.messageId,128)
  ||!Array.isArray(pointer.signalIds)||pointer.signalIds.length<1||pointer.signalIds.length>CLOUD_NOTIFY_LIMITS.signals
  ||pointer.signalIds.some(value=>!id(value,128))||new Set(pointer.signalIds).size!==pointer.signalIds.length)throw Error('Invalid notification pointer');
 return {roomId:pointer.roomId,messageId:pointer.messageId,signalIds:[...pointer.signalIds].sort()};
}
function checkedReceipt(receipt,inputDigest,targetDigest,input){
 const keys=[...(input.items?['input']:[]),'version','inputDigest','targetDigest','phase','operationId','createdAt','updatedAt',...(receipt?.reason?['reason']:[]),...(receipt?.responseDigest?['responseDigest']:[])];
 if(!closed(receipt,keys)||receipt.version!==(input.items?2:1)||input.items&&JSON.stringify(receipt.input)!==JSON.stringify(input)||receipt.inputDigest!==inputDigest||receipt.targetDigest!==targetDigest
  ||!['intent','accepted','unknown'].includes(receipt.phase)||!id(receipt.operationId,64)
  ||!Number.isSafeInteger(receipt.createdAt)||receipt.createdAt<0||!Number.isSafeInteger(receipt.updatedAt)||receipt.updatedAt<receipt.createdAt
  ||receipt.reason&&!['recovered_intent','command_unconfirmed','timeout','output_limit','invalid_response'].includes(receipt.reason)
  ||receipt.responseDigest&&!/^[a-f0-9]{64}$/.test(receipt.responseDigest)
  ||receipt.phase==='intent'&&('reason'in receipt||'responseDigest'in receipt)
  ||receipt.phase==='accepted'&&('reason'in receipt||!receipt.responseDigest)
  ||receipt.phase==='unknown'&&!receipt.reason)throw Error('Notification receipt requires reconciliation');
 return receipt;
}
export function createCloudNotifier({executable,sessionId,roomId,stateRoot,timeoutMs=CLOUD_NOTIFY_LIMITS.timeoutMs,env=process.env,runCli=invoke,openReceipt=openJoinJournal,now=Date.now}){
 if(!id(roomId,64)||typeof executable!=='string'||!isAbsolute(executable)||executable.includes('\0')||typeof stateRoot!=='string'||!isAbsolute(stateRoot)
  ||typeof sessionId!=='string'||!/^session_[A-Za-z0-9]{16,128}$/.test(sessionId)
  ||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('Invalid trusted notification configuration');
 const targetDigest=digest(JSON.stringify([executable,sessionId,roomId]));
 return async pointer=>{
  const selected=pointerOf(pointer);
  if(selected.roomId!==roomId)throw Error('Invalid notification pointer');
  const input=JSON.stringify(selected),inputDigest=digest(input);
  // Existing private atomic JSON + exclusive SQLite ownership; not the older
  // TurnReceipts/SessionMap writers, which do not fsync their checkpoints.
  const journal=openReceipt(stateRoot,'cloud-notify-'+digest(targetDigest+inputDigest));
  try{
   let saved=journal.read();
   if(saved){
    saved=checkedReceipt(saved,inputDigest,targetDigest,selected);
    if(saved.phase==='intent'){saved={...saved,phase:'unknown',reason:'recovered_intent',updatedAt:Math.max(now(),saved.createdAt)};journal.save(saved);}
    return result(saved,true); // Accepted and unknown are never sent again.
   }
   saved={version:selected.items?2:1,...(selected.items?{input:selected}:{}),inputDigest,targetDigest,phase:'intent',operationId:randomUUID(),createdAt:now(),updatedAt:now()};
   checkedReceipt(saved,inputDigest,targetDigest,selected);journal.save(saved); // durable before spawning
   const prompt='Root-generated notification (not John).\n'+input;
   let reason='command_unconfirmed',responseDigest;
   try{
    const reply=await runCli(executable,['-p',prompt,'--cloud',sessionId,'--output-format','json'],{shell:false,windowsHide:true,encoding:'utf8',timeout:timeoutMs,maxBuffer:CLOUD_NOTIFY_LIMITS.outputBytes,env:childEnvFor(env)});
    if(reply?.error){reason=reply.error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?'output_limit':reply.error.killed?'timeout':'command_unconfirmed';}
    else if(typeof reply?.stdout!=='string'||Buffer.byteLength(reply.stdout)>CLOUD_NOTIFY_LIMITS.outputBytes)reason='output_limit';
    else{
     responseDigest=digest(reply.stdout);reason='invalid_response';
     const value=JSON.parse(reply.stdout);
     // Exactly three JSON member tokens also rejects duplicate/shadowed keys.
     if((reply.stdout.match(/"(?:\\.|[^"\\])*"\s*:/g)||[]).length===3&&closed(value,['ok','session_id','url'])&&value.ok===true&&value.session_id===sessionId&&typeof value.url==='string'
      &&[`https://claude.ai/code/${sessionId}`,`https://claude.ai/code/${sessionId}?from=cli&m=0`].includes(value.url))reason=null;
    }
   }catch{/* A thrown transport/parse error is not proof that no send occurred. */}
   saved={...saved,phase:reason?'unknown':'accepted',updatedAt:Math.max(now(),saved.createdAt),...(reason?{reason}:{}),...(responseDigest?{responseDigest}:{})};
   try{journal.save(saved);}catch{throw Error('Notification outcome is unknown; retain its original receipt and reconcile');}
   return result(saved,false);
  }finally{journal.close();}
 };
}
