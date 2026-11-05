import {Buffer} from 'node:buffer';
import {nativeTextEvidence} from '../src/work-packet.js';
import {WORK_REVISION_TYPES} from '../src/events.js';
import {auditTextReceipt,storedTextFromEvidence} from './text-results.mjs';
import {withCurrentAuditUnits} from './current-room-repository.mjs';
import {inRestoreContext,restoreProgress,RESTORE_AUDIT_UNIT_BYTES} from './restore-admission.mjs';
import {MESSAGE_PROOF_SELECT} from './write-integrity.mjs';
// Existing target-owned scratch only. Its owner commits this cursor and rows in
// the SAME frozen-source restore transaction; the full oracle remains required.
const LIMIT=4*1024*1024,fail=()=>{throw Error('Recovery native text results require reconciliation');};
export const initialRecoveryTextResults=()=>({version:1,stage:'receipts',workAfter:'',workId:null,receiptIndex:0,sequence:0,projected:0,audited:0});
export function validateRecoveryTextResults(p){
 if(!p||Object.keys(p).sort().join(',')!==Object.keys(initialRecoveryTextResults()).sort().join(',')||p.version!==1||!['receipts','events','complete'].includes(p.stage)||typeof p.workAfter!=='string'||Buffer.byteLength(p.workAfter)>200||p.workId!==null&&(typeof p.workId!=='string'||Buffer.byteLength(p.workId)>200)||!['receiptIndex','sequence','projected','audited'].every(k=>Number.isSafeInteger(p[k])&&p[k]>=0))fail();
}
function scratchBytes(db,restoreId,roomId,domain,key){
 const row=db.prepare("SELECT payload_bytes,length(CAST(payload AS BLOB)) bytes FROM current_restore_audit_scratch WHERE restore_id=? AND lane='actual' AND room_id=? AND domain=? AND unit_key=? AND part=0").get(restoreId,roomId,domain,key);
 if(!row||row.bytes !== row.payload_bytes || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > RESTORE_AUDIT_UNIT_BYTES)fail();return row.bytes;
}
export function advanceRecoveryTextResults(store,scratch,restoreId,roomId,previous,seal){
 validateRecoveryTextResults(previous);const p={...previous},db=store.db;let bytes=0,units=0,cachedWorkId=null,cachedWork=null;
 // One bounded work body, scoped to this synchronous frozen-source step only.
 const workBytes=id=>id===cachedWorkId?0:scratchBytes(db,restoreId,roomId,'workBody',id);
 const loadWork=id=>{if(id!==cachedWorkId){cachedWork=scratch.get('actual',roomId,'workBody',id);cachedWorkId=id;}return cachedWork;};
 if(!db.isTransaction||!inRestoreContext(db))fail();
 const admission=restoreProgress(db);if(admission.state!=='pending'||admission.restore_id!==restoreId||admission.phase!=='audit_pending'||seal?.id!==admission.seal?.id)fail();
 const maximum=admission.seal.tables.find(t=>t.name==='events')?.maxRowBytes;
 if(!Number.isSafeInteger(maximum)||maximum<0)fail();
 // Preserve legal sealed atoms larger than the nominal quantum. Only one such
 // atom runs alone; its actual bytes remain reported, not claimed strictly4MiB.
 const admit=n=>{if(!Number.isSafeInteger(n)||n<0||!Number.isSafeInteger(bytes+n))fail();if(bytes+n>LIMIT&&units)return false;bytes+=n;return true;};
 return withCurrentAuditUnits(store,roomId,reader=>{
  if(!reader.head)fail();
  while(units < 32 && bytes < LIMIT && scratch.remaining >= 4 && p.stage !== 'complete'){
   if(p.stage==='receipts'){
    if(p.workId===null){const key=scratch.nextKey('actual',roomId,'workBody',p.workAfter);if(key===undefined){p.stage='events';continue;}p.workId=key;p.receiptIndex=0;}
    const n=workBytes(p.workId);if(!admit(n+4096))break;
    const work=loadWork(p.workId);if(work?.id!==p.workId||!Array.isArray(work.receiptHistory))fail();
    const receipt=p.receiptIndex<work.receiptHistory.length?work.receiptHistory[p.receiptIndex]:work.receipt;
    if(receipt?.nativeText){
     if(typeof receipt.eventId!=='string'||typeof receipt.nativeText.messageId!=='string'||scratch.get('history',roomId,'textProjected',receipt.eventId)!==undefined)fail();
     scratch.put('history',roomId,'textProjected',receipt.eventId,{workId:work.id,index:p.receiptIndex});
     const cited=scratch.get('history',roomId,'textCited',receipt.nativeText.messageId);
     if(cited!==undefined&&cited!==receipt.evidenceVersion)fail();
     if(cited===undefined)scratch.put('history',roomId,'textCited',receipt.nativeText.messageId,receipt.evidenceVersion);
     p.projected++;
    }
    p.receiptIndex++;if(p.receiptIndex>work.receiptHistory.length){p.workAfter=p.workId;p.workId=null;p.receiptIndex=0;}units++;continue;
   }
   const scalar=db.prepare('SELECT rowid,sequence,length(CAST(body AS BLOB)) bytes,length(CAST(id AS BLOB)) id_bytes FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT 1').get(roomId,p.sequence);
   if(!scalar){if(p.sequence!==reader.head.sequence||p.audited!==p.projected)fail();p.stage='complete';break;}
   if(!Number.isSafeInteger(scalar.bytes)||scalar.bytes<1||scalar.bytes>maximum||scalar.id_bytes<1||scalar.id_bytes>200||scalar.sequence!==p.sequence+1)fail();
   // Reserve only this source event first; no payload is transferred unadmitted.
   if(!admit(scalar.bytes+4096))break;
   const row=db.prepare('SELECT id,sequence,body FROM events WHERE rowid=?').get(scalar.rowid),event=JSON.parse(row.body),data=event.data;
   if(event.type==='message.posted'&&['packetId','basisRevision','allowOlderBasis'].some(k=>Object.hasOwn(data,k))){
    const prior=scratch.get('history',roomId,'textRevision',data.workItemId);if(prior!==undefined)scratch.put('history',roomId,'textPostRevision',event.id,prior);
   }
   if(event.type==='work.completed'){
    const parent=scratch.get('history',roomId,'textPrevious',data.workItemId)??null;
    if(data.evidenceKind==='room_text'){
     const link=scratch.get('history',roomId,'textProjected',event.id);if(!link||link.workId!==data.workItemId)fail();
     const n=workBytes(link.workId);
     const postScalar=db.prepare('SELECT rowid,sequence,length(CAST(body AS BLOB)) bytes,length(CAST(id AS BLOB)) id_bytes FROM events WHERE room_id=? AND id=?').get(roomId,data.evidenceMessageEventId);
     if(!postScalar||!Number.isSafeInteger(postScalar.bytes)||postScalar.bytes<1||postScalar.bytes>maximum||postScalar.id_bytes<1||postScalar.id_bytes>200)fail();
     const columns=MESSAGE_PROOF_SELECT.split(',').map(k=>`coalesce(length(CAST(${k} AS BLOB)),0)`).join('+');
     const messageSize=db.prepare(`SELECT ${columns} bytes FROM messages WHERE room_id=? AND message_id=?`).get(roomId,data.evidenceMessageId);
     const witness=db.prepare("SELECT r.payload_bytes,(SELECT length(CAST(a.counts_json AS BLOB)) FROM operator_actions a WHERE a.id=p.receipt_id AND a.action='current_room_transition') receipt_bytes FROM current_room_record_proofs p LEFT JOIN current_room_records r ON r.room_id=p.room_id AND r.domain=p.domain AND r.record_key=p.record_key WHERE p.room_id=? AND p.domain='messageWitness' AND p.record_key=?").get(roomId,data.evidenceMessageId);
     if(!Number.isSafeInteger(messageSize?.bytes)||messageSize.bytes<1||!Number.isSafeInteger(witness?.payload_bytes)||!Number.isSafeInteger(witness?.receipt_bytes))fail();
     const estimate=n+postScalar.bytes+messageSize.bytes+witness.payload_bytes+witness.receipt_bytes+4096;
     if(!admit(estimate)){if(!units)fail();break;}
     const work=loadWork(link.workId),receipt=link.index<work.receiptHistory.length?work.receiptHistory[link.index]:work.receipt;
     if(receipt?.eventId!==event.id||!receipt.nativeText)fail();
     const source=reader.message(data.evidenceMessageId);if(!source)fail();const message=source.value;
     const posted=db.prepare('SELECT id,sequence,body FROM events WHERE rowid=?').get(postScalar.rowid);
     const text=storedTextFromEvidence({roomId,workItemId:work.id,messageId:data.evidenceMessageId,row:posted,message,previous:scratch.get('history',roomId,'textPostRevision',posted.id)??null,citedVersion:scratch.get('history',roomId,'textCited',data.evidenceMessageId)??null});
     const nativeText=nativeTextEvidence({messages:[message]},{id:work.id,receipt:parent?{eventId:parent}:null},data,{allowWithdrawn:true});
     if(text.evidenceVersion!==data.evidenceVersion)fail();auditTextReceipt({event,row,receipt,nativeText,text});p.audited++;
    }
    scratch.set('history',roomId,'textPrevious',data.workItemId,event.id);
   }
   if(typeof data.workItemId==='string'&&(event.type==='work.proposed'||WORK_REVISION_TYPES.includes(event.type)&&Number.isInteger(data.expectedRevision)))scratch.set('history',roomId,'textRevision',data.workItemId,{type:event.type,data:{expectedRevision:data.expectedRevision??null}});
   p.sequence=row.sequence;units++;
  }
  return{cursor:p,units,bytes,done:p.stage==='complete'};
 });
}
