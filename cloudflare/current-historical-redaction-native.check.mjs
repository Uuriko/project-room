import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
test('actual Native historical H prefix erasures preserve original evidence and recover through operator continuation',{timeout:120000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'historical-privacy-')),script=(await build({entryPoints:[fileURLToPath(new URL('./current-historical-redaction-native.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text,restoreAuthorization=['synthetic','historical','privacy','restore','1101'].join('-');
 const create=()=>new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:join(directory,'do'),durableObjects:{ROOM:{className:'HistoricalPrivacyRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test',ROOM_RESTORE_TOKEN:restoreAuthorization},serviceBindings:{ASSETS:async()=>new Response('Not found',{status:404})}});let mf=create(),base=await mf.ready;
 const call=(surface,path,options={})=>fetch(new URL(path+(path.includes('?')?'&':'?')+'surface='+surface,base),options),json=async(surface,path,status=200,options={})=>{const response=await call(surface,path,options),body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;};
 try{
  const f=await json('source','/__seed'),receipts=[];
  const denied=await json('source','/__erase?id=prefix-private&who=worker');assert.equal(denied.status,422);
  const fault=await json('source','/__erase?id=prefix-one&fault=1');assert.equal(fault.status,500);assert.equal(fault.fired,true);assert.equal(fault.unchanged,true);
  await mf.dispose();mf=create();base=await mf.ready;
  for(const id of ['prefix-one','prefix-two','prefix-private']){
   const saved=await json('source','/__erase?id='+id+'&lost=1',503);assert.equal(saved.status,201,JSON.stringify(saved));assert.equal(saved.body.duplicate,false);assert.equal(saved.cost.unknown,0);
   await mf.dispose();mf=create();base=await mf.ready;
   const retry=await json('source','/__erase?id='+id);assert.equal(retry.status,200);assert.equal(retry.body.duplicate,true);assert.equal(retry.body.event.id,saved.body.event.id);assert.equal(retry.cost.rowsWritten,0);receipts.push({id,cost:saved.cost,clockMs:saved.clockMs,retry:retry.cost});
  }
  const checked=await json('source','/__audit');assert.equal(checked.leaks,0);assert.equal(checked.proofs.find(row=>row.action==='historical_replay_privacy_basis').n,1);assert.equal(checked.proofs.find(row=>row.action==='historical_replay_erased').n,3);
  const text=await(await call('source','/__export')).text();let response=await call('target','/api/operator/restore',{method:'POST',headers:{authorization:'Bearer '+restoreAuthorization},body:text}),progress=await response.json();assert.equal(response.status,202,JSON.stringify(progress));
  await mf.dispose();mf=create();base=await mf.ready;await json('target','/api/ready',503);
  let steps=0;while(progress.pending){const input={restoreId:progress.restoreId,sourceSeal:progress.sourceSeal,expectedRevision:progress.revision,requestId:'historical_privacy_'+steps};response=await call('target','/api/operator/restore',{method:'POST',headers:{authorization:'Bearer '+restoreAuthorization,'content-type':'application/json'},body:JSON.stringify(input)});progress=await response.json();assert.ok([200,202].includes(response.status),JSON.stringify(progress));assert.ok(++steps<600);}
  assert.equal(progress.verified,true);assert.equal(progress.audit.ok,true);await mf.dispose();mf=create();base=await mf.ready;await json('target','/api/ready');
  const restored=await json('target','/__audit');assert.deepEqual(restored,checked);
  const retry=await json('target','/api/rooms/legacy-room/commands',200,{method:'POST',headers:{authorization:'Bearer '+f.key,origin:'https://room.example.test','content-type':'application/json'},body:JSON.stringify({id:'erase-prefix-one',type:'message.deleted',data:{messageId:'prefix-one',expectedMessageRevision:1,reason:'Authorized removal'}})});assert.equal(retry.duplicate,true);
  console.log('HISTORICAL_PRIVACY_NATIVE '+JSON.stringify({head:f.head,prefix:f.prefix,receipts,proofRows:checked.proofs,sourceBytes:Buffer.byteLength(text),steps,fullOracle:true,coldReady:true,originalReceiptsExact:true,sourceLimit:256*1024,metadataLimit:128*1024,wholePurgeBounded:false}));
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
