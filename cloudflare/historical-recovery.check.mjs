import {RESTORE_AUDIT_VERSION} from '../server/restore-admission.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const restoreCredential='synthetic-durable-restore-00000000000000';
const bundle=async name=>(await build({entryPoints:[fileURLToPath(new URL(name,import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
test('actual Native cold restore consumes original historical receipt and preserves useful result',{timeout:120000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'native-historical-recovery-'));let script=await bundle('./historical-recovery.test-fixture.mjs');const create=()=>new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'DurableCoverageRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test',ROOM_RESTORE_TOKEN:restoreCredential},serviceBindings:{ASSETS:async()=>new Response('Not found',{status:404})}});let mf=create();
 const call=(surface,path,options={})=>mf.dispatchFetch('https://room.example.test'+path+(path.includes('?')?'&':'?')+'surface='+surface,{...options,headers:{Host:'room.example.test',...Object.fromEntries(new Headers(options.headers))}});
 const json=async(surface,path,status=200,options)=>{const response=await call(surface,path,options),text=await response.text();assert.equal(response.status,status,surface+path+' '+text);return JSON.parse(text);};
 try{
  const seeded=await json('source','/__historical'),{key}=await json('source','/__key'),backup=await call('source','/__export');assert.equal(backup.status,200);const text=await backup.text(),partial=await json('target','/__partial',200,{method:'POST',body:text});assert.equal(partial.pending,true);await mf.dispose();script=await bundle('./durable-coverage-native.test-fixture.mjs');mf=create();await json('target','/api/ready',503);
  let result=await json('target','/api/operator/restore?resume=1',202,{method:'POST',headers:{Authorization:'Bearer '+restoreCredential},body:text}),steps=0,sawHistorical=false;
  while(result.pending){const input={restoreId:result.restoreId,sourceSeal:result.sourceSeal,expectedRevision:result.revision,requestId:'historical_native_'+steps},expected=result.auditProgress?.stage==='full_audit_pending'?200:202;const next=await json('target','/api/operator/restore',expected,{method:'POST',headers:{Authorization:'Bearer '+restoreCredential,'Content-Type':'application/json'},body:JSON.stringify(input)});assert.deepEqual(await json('target','/api/operator/restore',expected,{method:'POST',headers:{Authorization:'Bearer '+restoreCredential,'Content-Type':'application/json'},body:JSON.stringify(input)}),next);result=next;if(result.auditProgress?.replay?.cursor?.checkpoint?.sourceKind==='historical')sawHistorical=true;steps++;assert.ok(steps<200);if(result.pending)await json('target','/api/ready',503);if(steps%5===0){await mf.dispose();mf=create();}}
  assert.equal(sawHistorical,true);assert.equal(result.verified,true);assert.deepEqual(result.replayContinuation,{rooms:1,deferred:0,originalFullOracleRequired:true});await mf.dispose();mf=create();await json('target','/api/ready');
  const retry=await json('target','/api/rooms/legacy-room/commands',200,{method:'POST',headers:{Authorization:'Bearer '+key,Origin:'https://room.example.test','Content-Type':'application/json'},body:JSON.stringify({id:'historical-result',type:'message.posted',data:{messageId:'historical-result',workItemId:'task',body:seeded.body}})});assert.equal(retry.duplicate,true);assert.equal(retry.event.id,seeded.post.event.id);assert.equal(retry.sequence,seeded.post.sequence);
  console.log('HISTORICAL_RECOVERY_NATIVE '+JSON.stringify({auditProtocol:RESTORE_AUDIT_VERSION,writerFormat:'normalized-current-v1-native-work-3',sourcePrefix:seeded.prefix,modernTail:seeded.head-seeded.prefix,steps,interruptedLoad:true,partialImportedEvents:partial.events,coldResume:true,readinessBarrier:true,originalHistoricalBasis:true,replayDeferred:0,requiredFullOracle:true,exactResultRetry:true,wholeRecoveryBounded:false}));
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
