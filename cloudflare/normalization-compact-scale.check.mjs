// CI admission case for the package's default Native runtime. The separate
// normalization-scale.check.mjs retains its original optional 7 MB stress case.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('default Native compact 50k-event normalization preserves bounded post, edit and presence work', {timeout:240000},async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./normalization-scale.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const dir=await mkdtemp(join(tmpdir(),'normalization-compact-scale-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'NormalizationScaleRoom',useSQLite:true}}});
 let mf=create();
 const call=async(path,body)=>{
  console.log('HOST_PHASE '+path);
  const started=performance.now();
  const response=await mf.dispatchFetch('http://localhost'+path,body?{method:'POST',body:JSON.stringify(body)}:{}),result=await response.json();
  console.log('NORMALIZATION_SAMPLE '+JSON.stringify({path,status:response.status,observedHostWallMs:performance.now()-started,...result}));
  assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.cost.unknown,0);
  return result;
 };
 try{
  const optional=await call('/assistant-schema-control?surface=optional');assert.equal(optional.result.controls.length,2);assert.ok(optional.result.controls.every(row=>row.created&&row.corruptRefused&&row.heldRefused));
  const small=await call('/seed?surface=small&fixture=compact');
  assert.equal(small.result.events,1000);assert.equal(small.result.posts,100);
  const smallPlan=await call('/plan?surface=small');
  await call('/execute?surface=small',{roomId:'commons',discardLegacyAssignments:true,planHash:smallPlan.result.planHash,requestId:'native-small-adopt',reason:'Synthetic matched small serving control'});
  await call('/post?surface=small&id=one');
  const smallPost=await call('/post?surface=small&id=two');
  await call('/edit?surface=small');const smallEdit=await call('/edit?surface=small&id=two'),smallPresence=await call('/presence?surface=small');assert.equal(smallPresence.result.members.length,1);
  const smallState=await call('/state?surface=small');
  await mf.dispose();mf=create();const smallPostRetry=await call('/post?surface=small&id=one'),smallEditRetry=await call('/edit?surface=small&id=two');assert.equal(smallPostRetry.result.duplicate,true);assert.equal(smallPostRetry.result.sequence,1001);assert.equal(smallEditRetry.result.duplicate,true);assert.equal(smallEditRetry.result.sequence,smallEdit.result.sequence);assert.equal(smallPostRetry.cost.rowsWritten,2);assert.equal(smallEditRetry.cost.rowsWritten,2);assert.equal((await call('/read?surface=small')).result.messages[0].body,'Updated useful normalized result');assert.equal((await call('/presence?surface=small')).result.members.length,1);
  const seed=await call('/seed?fixture=compact');
  assert.equal(seed.result.fixture,'compact');assert.equal(seed.result.members,1);
  assert.equal(seed.result.events,50000);assert.equal(seed.result.eventCount,50000);assert.equal(seed.result.posts,5000);
  assert.ok(seed.result.projectionBytes>500000&&seed.result.projectionBytes<2000000,JSON.stringify(seed.result));
  const plan=await call('/plan');
  const input={roomId:'commons',discardLegacyAssignments:true,planHash:plan.result.planHash,requestId:'native-scale-adopt',reason:'Synthetic compact 50k-event activation qualification'};
  const adopted=await call('/execute',input);assert.ok(adopted.result.projectionBytes<512);
  await mf.dispose();mf=create();
  const duplicate=await call('/execute',input);assert.equal(duplicate.result.duplicate,true);assert.equal(duplicate.result.sequence,adopted.result.sequence);
  await mf.dispose();mf=create();
  const first=await call('/post?id=one'),second=await call('/post?id=two');
  assert.equal(first.cost.rowsWritten,second.cost.rowsWritten);
  assert.equal(second.cost.rowsWritten,smallPost.cost.rowsWritten);
  assert.equal(second.cost.statements,smallPost.cost.statements);
  assert.ok(second.cost.rowsRead<=smallPost.cost.rowsRead+32);
  assert.ok(second.cost.materializedBytes<=smallPost.cost.materializedBytes+2048);
  await mf.dispose();mf=create();
  const retry=await call('/post?id=one');assert.equal(retry.result.duplicate,true);assert.equal(retry.result.sequence,first.result.sequence);
  assert.equal(retry.cost.rowsWritten,2,'cold exact post retry only flips the existing native runtime permit');
  const read=await call('/read');assert.equal(read.result.messages[0].body,'Useful normalized result');
  await call('/edit');const edited=await call('/edit?id=two');assert.equal(edited.result.duplicate,false);const presence=await call('/presence');assert.equal(presence.result.members.length,1);
  for(const [label,large,small] of [['post',second,smallPost],['edit',edited,smallEdit],['presence',presence,smallPresence]]){assert.equal(large.cost.statements,small.cost.statements,label+' SQL');assert.equal(large.cost.rowsWritten,small.cost.rowsWritten,label+' writes');assert.ok(large.cost.rowsRead<=small.cost.rowsRead+32,label+' reads');assert.ok(large.cost.materializedBytes<=small.cost.materializedBytes+4096,label+' returned');assert.ok(large.cost.carrierWriteBytes<=512,label+' carrier');assert.ok(large.cost.maxProjectionReadBytes<=512,label+' no full projection read');if(label!=='presence'){assert.ok(large.cost.carrierWriteBytes>0,label+' carrier instrumentation observed');assert.ok(large.cost.rowsRead<500,label+' no optional-table catalog scan');}}
  await mf.dispose();mf=create();const editRetry=await call('/edit?id=two');assert.equal(editRetry.result.duplicate,true);assert.equal(editRetry.result.sequence,edited.result.sequence);assert.equal(editRetry.cost.rowsWritten,2);const updated=await call('/read');assert.equal(updated.result.messages[0].body,'Updated useful normalized result');await call('/presence');
  const state=await call('/state');assert.ok(state.result.projectionBytes<512);
  assert.equal(state.result.events,50004);assert.equal(state.result.messages,5002);assert.ok(state.result.sqliteDatabaseBytes>state.result.eventBodyBytes);assert.ok(state.result.sqliteDatabaseBytes>smallState.result.sqliteDatabaseBytes);
  console.log('NORMALIZED_SERVING_COMPARISON '+JSON.stringify({history:[1000,50000],small:{post:smallPost.cost,edit:smallEdit.cost,presence:smallPresence.cost,state:smallState.result},large:{post:second.cost,edit:edited.cost,presence:presence.cost,state:state.result},smallPostRetry:smallPostRetry.cost,smallEditRetry:smallEditRetry.cost,postRetry:retry.cost,editRetry:editRetry.cost,localWallNotProductionCPU:true,physicalStorage:'SQLite databaseSize scalar; logical event/message payload sums separate; excludes KV/files/WAL guarantees'}));
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
