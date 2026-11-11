import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
test('production Native HTTP redaction survives faults, lost response, cold retry and complete recovery',{timeout:120000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'current-redaction-')),script=(await build({entryPoints:[fileURLToPath(new URL('./current-message-redaction-native.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text,restoreToken='synthetic-redaction-restore-1101-000000';
 const create=()=>new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:join(directory,'do'),durableObjects:{ROOM:{className:'RedactionNativeRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test',ROOM_RESTORE_TOKEN:restoreToken},serviceBindings:{ASSETS:async()=>new Response('Not found',{status:404})}});let mf=create(),base=await mf.ready;
 const call=(surface,path,options={})=>fetch(new URL(path+(path.includes('?')?'&':'?')+'surface='+surface,base),options);
 const json=async(surface,path,status=200,options={})=>{const response=await call(surface,path,options),body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;},receipts=[],keys=new Map();
 try {
  for(const n of [32,1000,5000]) {
   const surface='n'+n;keys.set(n,(await json(surface,'/__seed?n='+n)).key);
   const denied=await json(surface,'/__delete?who=other');assert.equal(denied.status,422,JSON.stringify(denied));
   const fault=await json(surface,'/__delete?fault=1');assert.equal(fault.status,500,JSON.stringify(fault));assert.equal(fault.unchanged,true);
   await mf.dispose();mf=create();base=await mf.ready;
   const saved=await json(surface,'/__delete?lost=1',503);assert.equal(saved.status,201);assert.equal(saved.body.duplicate,false);
   assert.equal(saved.cost.sourceRows,5);assert.equal(saved.sourceQueries,2);for(const plan of saved.sourcePlans)assert.match(plan.join(' '),/SEARCH events USING INDEX current_redaction_message_events/);assert.equal(saved.cost.unknown,0);assert.equal(saved.rawPermit.unknown,0);assert.equal(saved.rawPermit.rowsWritten,2);
   const party=await json(surface,'/__read'),outsider=await json(surface,'/__read?who=other');assert.equal(party.status,200,JSON.stringify(party));assert.equal(outsider.status,404,JSON.stringify(outsider));assert.equal(JSON.stringify(party).includes('native-private-'),false);
   const checked=await json(surface,'/__check');assert.equal(checked.leaks,0);assert.equal(checked.row.body,null);assert.equal(JSON.parse(checked.row.record_json).redacted,true);assert.equal(checked.permit,0);
   await mf.dispose();mf=create();base=await mf.ready;
   const retry=await json(surface,'/__delete');assert.equal(retry.status,200);assert.equal(retry.body.duplicate,true);assert.equal(retry.body.event.id,saved.body.event.id);assert.equal(retry.cost.rowsWritten,0);
   receipts.push({n,eventId:saved.body.event.id,cost:saved.cost,rawPermit:saved.rawPermit,clockMs:saved.clockMs,retry:retry.cost,retryRawPermit:retry.rawPermit,sourceQueries:saved.sourceQueries});
  }
  await json('n32','/__audit');const text=await(await call('n32','/__export')).text();
  const operatorOptions={method:'POST',headers:{authorization:'Bearer '+restoreToken},body:text};
  let response=await call('restored','/api/operator/restore',operatorOptions),result=await response.json();assert.equal(response.status,202,JSON.stringify(result));
  await mf.dispose();mf=create();base=await mf.ready;await json('restored','/api/ready',503);
  let steps=0;while(result.pending){const input={restoreId:result.restoreId,sourceSeal:result.sourceSeal,expectedRevision:result.revision,requestId:'redaction_recovery_'+steps};response=await call('restored','/api/operator/restore',{method:'POST',headers:{authorization:'Bearer '+restoreToken,'content-type':'application/json'},body:JSON.stringify(input)});result=await response.json();assert.ok([200,202].includes(response.status),JSON.stringify(result));assert.ok(++steps<600);}
  assert.equal(result.verified,true);assert.equal(result.audit.ok,true);await mf.dispose();mf=create();base=await mf.ready;await json('restored','/api/ready');await json('restored','/__audit');assert.equal((await json('restored','/__check')).leaks,0);
  const restoredRetry=await json('restored','/api/rooms/commons/commands',200,{method:'POST',headers:{authorization:'Bearer '+keys.get(32),origin:'https://room.example.test','content-type':'application/json'},body:JSON.stringify({id:'native-delete-once',type:'message.deleted',data:{messageId:'private',expectedMessageRevision:1,reason:'remove'}})});
  assert.equal(restoredRetry.duplicate,true);assert.equal(restoredRetry.event.id,receipts[0].eventId);
  console.log('CURRENT_REDACTION_NATIVE '+JSON.stringify({receipts,recoverySteps:steps,sourceBytes:Buffer.byteLength(text),fullOracle:true,coldReady:true,wholePrivacyPurgeBounded:false}));
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
