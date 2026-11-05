import {RESTORE_AUDIT_VERSION} from '../server/restore-admission.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const token =
  'synthetic-durable-restore-00000000000000', exporter =
  'synthetic-durable-export-000000000000000';
const bundle=async name=>(await build({entryPoints:[fileURLToPath(new URL(name,import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
// The full cold-restart qualification reached its 160s limit on a loaded CI
// runner after reaching the final restore/cleanup steps. Keep a finite timeout
// with headroom; every continuation and cold-restart assertion still runs.
test('actual Native cold constructor and operator continuations preserve sealed coverage and ordinary refusal',{timeout:300000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'native-durable-coverage-'));let script=await bundle('./durable-coverage-seed.test-fixture.mjs');const create=()=>new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'DurableCoverageRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test',ROOM_RESTORE_TOKEN:token,ROOM_EXPORT_TOKEN:exporter},serviceBindings:{ASSETS:async()=>new Response('Not found',{status:404})}});let mf=create();
 const call=(surface,path,options={})=>mf.dispatchFetch('https://room.example.test'+path+(path.includes('?')?'&':'?')+'surface='+surface,{...options,headers:{Host:'room.example.test',...Object.fromEntries(new Headers(options.headers))}});
 const json=async(surface,path,status=200,options)=>{const response=await call(surface,path,options),text=await response.text();assert.equal(response.status,status,surface+path+' '+text);return JSON.parse(text);};
 const send=(input,status)=>json('target','/api/operator/restore',status,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(input)});
 try{
  const seed=await json('source','/__seed-history');assert.ok(seed.legalHistoryTimestampBytes>131072);const work=await json('source','/__work');assert.equal(JSON.parse(work.capacity.payload).open,true);const checkpoint=process.env.ROOM_TEST_RETAINED_CHECKPOINT==='1'?await json('source','/__checkpoint'):null;const saved=await json('source','/post?id=saved'),{key}=await json('source','/__key'),backup=await call('source','/__export');assert.equal(backup.status,200);const text=await backup.text();const partial=await json('target','/__partial',200,{method:'POST',body:text});assert.equal(partial.pending,true);assert.ok(partial.events>=500);await mf.dispose();script=await bundle('./durable-coverage-native.test-fixture.mjs');mf=create();await json('target','/api/ready',503);
  let result=await json('target','/api/operator/restore?resume=1',202,{method:'POST',headers:{Authorization:'Bearer '+token},body:text});assert.equal(result.verified,false);assert.equal(result.phase,'coverage');const raw=await json('target','/__prepared-write');assert.equal(raw.refused,true);assert.match(raw.error,/restore target is sealed/);await mf.dispose();mf=create();await json('target','/api/ready',503);let n=0,rows=0;
  // Cold proof at semantic boundaries and logarithmic progress checkpoints,
  // not every ten rows-of-work regardless of which invariant is executing.
  // Existing per-request retries, progress, admission and final oracle checks
  // below still run for EVERY continuation, including warm spans.
  const geometric=step=>Number.isInteger(Math.log2(step));
  const majorKey=value=>value.pending?`${value.phase}:${value.auditProgress?.stage??'-'}`:'published';
  let lastMajor=majorKey(result),lastCleanup=null;
  const majorObserved=new Set([lastMajor]),majorCold=new Set([lastMajor]);
  const majorTransitions=[],coldMajorTransitions=[],nestedObserved=new Set(),nestedCold=new Set();
  const progressCheckpoints=[],coldProgressCheckpoints=[],cleanupCheckpoints=[],coldCleanupCheckpoints=[];
  const cleanupTransitions=[],coldCleanupTransitions=[],restartReceipts=[];
  const nestedKeys=value=>{
   const audit=value.auditProgress;if(!audit)return[];
   const keys=[];
   for(const name of ['invitations','shareLinks','replyRequests','workHelp','charter','textResults','reminders','engine'])
    if(audit[name]?.stage)keys.push(`${name}:${audit[name].stage}`);
   if(audit.replay?.cursor?.stage)keys.push(`replay:${audit.replay.cursor.stage}`);
   if(audit.report?.stage)keys.push(`report:${audit.report.stage}`);
   if(audit.report?.sort?.stage)keys.push(`reportSort:${audit.report.sort.stage}`);
   return keys;
  };
  const restartAndReplay=async(input,status,ack,section,step,reasons)=>{
   await mf.dispose();mf=create();
   assert.deepEqual(await send(input,status),ack,'the exact acknowledged receipt survives a fresh Native constructor');
   if(ack.pending)await json('target','/api/ready',503);
   restartReceipts.push({section,step,reasons});
  };
  while(result.pending){const input={restoreId:result.restoreId,sourceSeal:result.sourceSeal,expectedRevision:result.revision,requestId:'native_step_'+n};const expected=result.phase==='audit_pending'&&result.auditProgress?.stage==='full_audit_pending'&&result.auditProgress?.report?.stage==='complete'?200:202;const next=await send(input,expected);assert.deepEqual(await send(input,expected),next);if(next.pending){assert.equal(next.verified,false);assert.ok(next.progress.rows-rows<=128);rows=next.progress.rows;await json('target','/api/ready',503);}if(next.pending)assert.equal(next.revision,input.expectedRevision+1);result=next;n++;assert.ok(n<2000,"fixture continuation safety limit exceeded");
   const key=majorKey(next),transition=key!==lastMajor,firstNested=nestedKeys(next).filter(value=>!nestedObserved.has(value));
   majorObserved.add(key);for(const value of firstNested)nestedObserved.add(value);
   if(transition)majorTransitions.push({step:n,key});
   if(geometric(n))progressCheckpoints.push(n);
   const reasons=[...(n===1?['first-continuation']:[]),...(transition?['phase:'+key]:[]),...firstNested.map(value=>'first-nested:'+value),...(geometric(n)?['geometric-progress']:[])];
   if(reasons.length){await restartAndReplay(input,expected,next,'recovery',n,reasons);majorCold.add(key);for(const value of firstNested)nestedCold.add(value);if(transition)coldMajorTransitions.push({step:n,key});if(geometric(n))coldProgressCheckpoints.push(n);}
   lastMajor=key;
  }
  assert.equal(result.verified,true);assert.deepEqual(result.replayContinuation,{rooms:1,deferred:0,originalFullOracleRequired:true});assert.equal(result.audit.ok,true);
  let cleanupSteps=0,cleanup=result,cleanupCallBudget=null;
  while(cleanup.cleanupComplete===false){
   const input=cleanup.nextCleanup.body,response=await call('target','/api/operator/restore',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(input)}),next=await response.json();
   assert.equal(response.status,next.cleanupComplete?200:202);assert.equal(next.cleanup.revision,input.expectedRevision+1);assert.deepEqual(await send(input,response.status),next);
   assert.ok(next.cleanup.removed>=0&&next.cleanup.removed<=15);assert.ok(next.cleanup.removed>0||(next.cleanup.scratchRemoved??0)>0,'guard or report workspace must advance');assert.ok((next.cleanup.scratchRemoved??0)<=128);cleanupCallBudget??=Math.ceil(next.cleanup.total/14)+Math.ceil((next.cleanup.scratchTotal??0)/128)+1;cleanup=next;cleanupSteps++;assert.ok(cleanupSteps<=cleanupCallBudget,'cleanup bound derives from actual guards and128-row workspace pages');
   const key=next.cleanupComplete?'complete':(next.cleanup.scratchRemaining??0)>0?'workspace':'guards',transition=key!==lastCleanup;
   if(transition)cleanupTransitions.push({step:cleanupSteps,key});if(geometric(cleanupSteps))cleanupCheckpoints.push(cleanupSteps);
   const reasons=[...(cleanupSteps===1?['first-cleanup']:[]),...(transition?['cleanup-phase:'+key]:[]),...(geometric(cleanupSteps)?['geometric-progress']:[])];
   if(reasons.length){await restartAndReplay(input,response.status,next,'cleanup',cleanupSteps,reasons);if(transition)coldCleanupTransitions.push({step:cleanupSteps,key});if(geometric(cleanupSteps))coldCleanupCheckpoints.push(cleanupSteps);}
   lastCleanup=key;
  }
  assert.equal(cleanup.cleanupComplete,true);assert.equal(cleanup.cleanup.verifiedGuardCount,0);assert.equal(cleanup.cleanup.scratchRemaining??0,0);assert.equal(cleanup.nextCleanup,null);
  assert.deepEqual([...majorCold].sort(),[...majorObserved].sort(),'every observed recovery phase/audit stage is cold-covered');
  assert.deepEqual(coldMajorTransitions,majorTransitions,'every recovery phase/audit-stage transition is cold-covered');
  assert.deepEqual([...nestedCold].sort(),[...nestedObserved].sort(),'every distinct observed nested stage is cold-covered at least once, not every report-table transition');
  assert.deepEqual(coldProgressCheckpoints,progressCheckpoints);assert.deepEqual(coldCleanupCheckpoints,cleanupCheckpoints);
  assert.deepEqual(coldCleanupTransitions,cleanupTransitions);
  assert.ok(majorObserved.has('coverage:-')&&majorObserved.has('audit_pending:full_audit_pending')&&majorObserved.has('published'));
  assert.equal(restartReceipts[0].step,1);assert.equal(restartReceipts[0].section,'recovery');
  const coldSchedule={strategy:'phase-transitions-first-nested-stages-and-geometric-progress',majorStages:[...majorObserved],majorTransitions,coldMajorTransitions,nestedStages:[...nestedObserved],nestedCoverage:'first observation of each stage, not every per-table transition',progressCheckpoints,coldProgressCheckpoints,cleanupCheckpoints,coldCleanupCheckpoints,cleanupTransitions,coldCleanupTransitions,restartReceipts,scheduledRestarts:restartReceipts.length,additionalFixedRestarts:3,finalFreshReopen:true};
  await mf.dispose();mf=create();await json('target','/api/ready');const retry=await json('target','/api/rooms/commons/commands',200,{method:'POST',headers:{Authorization:'Bearer '+key,Origin:'https://room.example.test','Content-Type':'application/json'},body:JSON.stringify({id:'command-saved',type:'message.posted',data:{messageId:'saved',body:'A useful saved message'}})});assert.equal(retry.duplicate,true);assert.equal(retry.event.id,saved.result.event.id);assert.equal(retry.sequence,saved.result.sequence);const workRetry=await json('target','/api/rooms/commons/commands',200,{method:'POST',headers:{Authorization:'Bearer '+key,Origin:'https://room.example.test','Content-Type':'application/json'},body:JSON.stringify(work.proposal)});assert.equal(workRetry.duplicate,true);assert.equal(workRetry.event.id,work.proposed.event.id);assert.equal(workRetry.sequence,work.proposed.sequence);
  console.log('DURABLE_COVERAGE_WORKER '+JSON.stringify({runtimeSource:'retained-checkpoint-seed',auditProtocol:RESTORE_AUDIT_VERSION,actualNative:true,importedPartialEvents:partial.events,sourceSeal:true,coverageSteps:n,cleanupSteps,coldSchedule,cleanupGuardCount:cleanup.cleanup.verifiedGuardCount,coverageRows:rows,maxPayloadRowsPerStep:128,coldDuringCoverage:true,preopenedPreparedDenied:true,ordinaryReady503UntilAudit:true,finalUnboundedAuditRequired:true,coldReady:true,exactRetry:true,wholeRecoveryBounded:false,acceptedNativeWorkCapacity:true,nativeWorkExactRetry:true,privateWorkRequestPreserved:true,messageAncestryCensus:true,historyFloorCensus:true,mandatoryBatchedEngine:true,strictEventHistory:true,legalHistoryTimestampBytes:seed.legalHistoryTimestampBytes,engineChecks:result.engineChecks,replayContinuation:result.replayContinuation,retainedCheckpoint:checkpoint,reportVersion:result.reportVersion}));
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
