import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
test('actual Native operator text phase cold resumes, exact retries, saved fault and corrupt receipt',{timeout:120000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'text-recovery-')),script=(await build({entryPoints:[fileURLToPath(new URL('./recovery-text-results-native.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text,authorization=['synthetic','text','restore','1101'].join('-');
 const create=()=>new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:join(directory,'do'),durableObjects:{ROOM:{className:'TextRecoveryRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test',ROOM_RESTORE_TOKEN:authorization},serviceBindings:{ASSETS:async()=>new Response('Not found',{status:404})}});let mf=create(),base=await mf.ready;
 const call=(surface,path,options={})=>fetch(new URL(path+(path.includes('?')?'&':'?')+'surface='+surface,base),options),json=async(surface,path,options={})=>{const r=await call(surface,path,options);assert.equal(r.status,200,await r.clone().text());return r.json();},post=(surface,body,extra='')=>json(surface,'/api/operator/restore'+extra,{method:'POST',headers:{authorization:'Bearer '+authorization,...(typeof body==='string'?{}:{'content-type':'application/json'})},body:typeof body==='string'?body:JSON.stringify(body)});
 try{
  const seeded=await json('source','/__seed'),text=await(await call('source','/__export')).text(),receipts=[];
  for(const surface of ['target','corrupt']){
   let response=await post(surface,text),steps=0,textSteps=0,faulted=false,poisoned=false;
   while(response.body.pending){
    const prior=await json(surface,'/__progress'),input={restoreId:response.body.restoreId,sourceSeal:response.body.sourceSeal,expectedRevision:response.body.revision,requestId:'text-step-'+steps};
    if(prior.progress.audit?.stage==='text_results'){
     textSteps++;
     if(surface==='corrupt'&&!poisoned){await json(surface,'/__poison');poisoned=true;}
     if(surface==='target'&&!faulted){const fault=await post(surface,input,'?fault=1');assert.equal(fault.status,422,JSON.stringify(fault));assert.equal(fault.fired,true);assert.deepEqual(await json(surface,'/__progress'),prior);faulted=true;}
    }
    if(!(surface==='target'&&prior.progress.audit?.stage==='text_results'&&textSteps===2)){await mf.dispose();mf=create();base=await mf.ready;}
    response=await post(surface,input);const retry=await post(surface,input);assert.deepEqual(retry.body,response.body);assert.equal(retry.status,response.status);
    if(prior.progress.audit?.stage==='text_results'){receipts.push({surface,cost:response.cost,clockMs:response.clockMs,bytes:response.body.auditProgress?.bytes-prior.progress.audit.bytes});assert.equal(response.cost.unknown,0);}
    if(response.status===422){assert.equal(surface,'corrupt');assert.equal(prior.progress.audit.stage,'text_results');assert.deepEqual(await json(surface,'/__progress'),prior);break;}
    assert.ok([200,202].includes(response.status),JSON.stringify(response));assert.ok(++steps<180);
   }
   if(surface==='target'){assert.equal(response.status,200);assert.deepEqual(response.body.subsystemContinuation.textResults,{rooms:1,projected:1,audited:1});assert.ok(textSteps>=3);assert.equal(faulted,true);assert.equal(response.body.replayContinuation.originalFullOracleRequired,true);}
   else{assert.equal(response.status,422);assert.equal(poisoned,true);}
  }
  console.log('TEXT_RESULT_NATIVE '+JSON.stringify({events:seeded.events,sourceBytes:Buffer.byteLength(text),receipts,withdrawn:true,fullOracleStillRequired:true}));
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
