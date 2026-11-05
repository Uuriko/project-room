import {verifyRecoveryReportScratch,deleteRecoveryReportScratch} from './recovery-report-cleanup.mjs';
import {createHash} from 'node:crypto';
import {CURRENT_WRITER_FORMAT} from './current-room-format.mjs';
import {restoreFreezeDefinitions} from './writer-fence.mjs';
import {RESTORE_AUDIT_VERSION,restoreProgress,withRestoreTransaction,checkpointRestoreCleanup} from './restore-admission.mjs';
import {invalidateCurrentRoomSchema} from './current-room-repository.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inventory=db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all().map(row=>row.name);
const fail=()=>{throw Error('Restore cleanup requires exact code-owned guard reconciliation');};
const validInput=input=>input&&Object.keys(input).sort().join(',')==='cleanup,expectedRevision,requestId,restoreId,sourceSeal'&&input.cleanup===true&&/^[-_a-zA-Z0-9]{1,128}$/.test(input.requestId??'')&&typeof input.restoreId==='string'&&input.restoreId.length>0&&input.restoreId.length<=128&&/^[0-9a-f]{64}$/.test(input.sourceSeal??'')&&Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0;
function cleanupResult(c){return{ok:true,verified:true,pending:false,restoreId:c.restoreId,sourceSeal:c.sourceSeal,cleanupComplete:c.complete,cleanup:{revision:c.revision,nextIndex:c.nextIndex,total:c.total,removed:c.version===2?c.guardRemoved:c.nextIndex-(c.revision-1)*15,remaining:c.total-c.nextIndex,verifiedGuardCount:c.total-c.nextIndex,...(c.version===2?{scratchTotal:c.scratchTotal,scratchRemaining:c.scratchRemaining,scratchRemoved:c.scratchRemoved}:{})},nextCleanup:restoreCleanupNext(c)};}

export function initialRestoreCleanup(db,restoreId,sourceSeal,tables,{reportScratchRows=0}={}){
 const names=[...tables].filter(name=>!name.startsWith('_cf_')).sort(),definitions=restoreFreezeDefinitions(names);if(JSON.stringify(names)!==JSON.stringify(inventory(db))||!Number.isSafeInteger(reportScratchRows)||reportScratchRows<0)fail();
 const c={version:reportScratchRows?2:1,restoreId,sourceSeal,inventoryHash:hash(names),definitionsHash:hash(definitions),writerFormat:CURRENT_WRITER_FORMAT,auditVersion:RESTORE_AUDIT_VERSION,nextIndex:0,total:definitions.length,revision:0,last:null,complete:definitions.length===0&&reportScratchRows===0};
 if(reportScratchRows){Object.assign(c,{scratchTotal:reportScratchRows,scratchRemaining:reportScratchRows,scratchRemoved:0,guardRemoved:0});verifyRecoveryReportScratch(db,restoreId,reportScratchRows);}return c;
}
export function restoreCleanupNext(cleanup){return cleanup.complete?null:{method:'POST',path:'/api/operator/restore',body:{cleanup:true,requestId:'cleanup_'+hash([cleanup.restoreId,cleanup.sourceSeal,cleanup.revision]).slice(0,32),expectedRevision:cleanup.revision,restoreId:cleanup.restoreId,sourceSeal:cleanup.sourceSeal}};}
function validate(db,latest){
 const c=latest?.cleanup,base='auditVersion,complete,definitionsHash,inventoryHash,last,nextIndex,restoreId,revision,sourceSeal,total,version,writerFormat',extra=['scratchTotal','scratchRemaining','scratchRemoved','guardRemoved'];
  if ( ! c || ! [ 1 , 2 ] . includes ( c . version ) || Object . keys ( c ) . sort ( ) . join ( ',' ) !== ( c . version === 2 ? [ ... base . split ( ',' ) , ... extra ] . sort ( ) . join ( ',' ) : base ) || c . restoreId !== latest . restoreId || c . sourceSeal !== latest . sourceSeal || c . writerFormat !== CURRENT_WRITER_FORMAT || c . auditVersion !== RESTORE_AUDIT_VERSION || ! [ 'nextIndex' , 'total' , 'revision' ] . every ( k => Number . isSafeInteger ( c [ k ] ) && c [ k ] >= 0 ) || c . nextIndex > c . total ) fail ( ) ;
 if(c.version===1){if(c.complete!==(c.nextIndex===c.total)||c.nextIndex!==Math.min(c.total,c.revision*15)||c.revision>Math.ceil(c.total/15))fail();}
 else{
  if(!extra.every(k=>Number.isSafeInteger(c[k])&&c[k]>=0)||c.scratchTotal<1||c.scratchRemaining>c.scratchTotal||c.scratchRemoved>128||c.guardRemoved>15||c.complete!==(c.nextIndex===c.total&&c.scratchRemaining===0)||c.revision>c.total+c.scratchTotal||c.revision===0&&(c.scratchRemoved!==0||c.guardRemoved!==0||c.scratchRemaining!==c.scratchTotal)||c.revision>0&&c.scratchRemoved+c.guardRemoved<1)fail();
  verifyRecoveryReportScratch(db,c.restoreId,c.scratchRemaining);
 }
 if(!latest.result?.verified||latest.result.pending!==false||(c.revision===0?c.last!==null:!c.last||Object.keys(c.last).sort().join(',')!=='exactInput,result'||!validInput(c.last.exactInput)||c.last.exactInput.restoreId!==c.restoreId||c.last.exactInput.sourceSeal!==c.sourceSeal||c.last.exactInput.expectedRevision!==c.revision-1||JSON.stringify(c.last.result)!==JSON.stringify(cleanupResult(c))))fail();
 const names=inventory(db),definitions=restoreFreezeDefinitions(names);if(hash(names)!==c.inventoryHash||hash(definitions)!==c.definitionsHash||definitions.length!==c.total)fail();
 // Includes removed-prefix absence: extra, reintroduced, missing or changed
 // guards cannot hide behind the cursor, including after the final batch.
 const rows=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'restore_frozen_*' ORDER BY name").all(),remaining=definitions.slice(c.nextIndex);if(rows.length!==remaining.length||remaining.some(def=>rows.find(row=>row.name===def.name)?.sql!==def.sql))fail();
 return{cleanup:c,definitions};
}
export function continueRestoreCleanup(store,input){
 if(!validInput(input))throw Error('Invalid restore cleanup continuation');
 return withRestoreTransaction(store,()=>{
  const db=store.db,state=restoreProgress(db),latest=state.latest;if(state.state!=='clear'||!latest||latest.restoreId!==input.restoreId||latest.sourceSeal!==input.sourceSeal)throw Error('Restore cleanup is stale or source differs');
  const {cleanup:c,definitions}=validate(db,latest);
  if(c.last?.exactInput?.requestId===input.requestId){if(JSON.stringify(c.last.exactInput)!==JSON.stringify(input))throw Error('Restore cleanup request ID binding differs');return c.last.result;}
  if(latest.requestId===input.requestId)throw Error('Restore cleanup request ID binding differs');
  if(c.complete||c.revision!==input.expectedRevision)throw Error('Restore cleanup is stale');
  const scratch=c.version===2?deleteRecoveryReportScratch(db,c.restoreId,c.scratchRemaining):null;
  const nextIndex=Math.min(c.total,c.nextIndex+(scratch?.removed?14:15));for(const def of definitions.slice(c.nextIndex,nextIndex))db.exec('DROP TRIGGER '+def.name);
  const next={...c,nextIndex,revision:c.revision+1,complete:nextIndex===c.total&&(!scratch||scratch.remaining===0),...(scratch?{scratchRemoved:scratch.removed,scratchRemaining:scratch.remaining,guardRemoved:nextIndex-c.nextIndex}:{})},result=cleanupResult(next);next.last={exactInput:input,result};
  validate(db,{...latest,cleanup:next});checkpointRestoreCleanup(db,latest,next);invalidateCurrentRoomSchema(db);return result;
 });
}
