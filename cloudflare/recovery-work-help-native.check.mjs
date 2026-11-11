import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
test('actual Native help audit retains checkpoint policy, global offer indices and warm/cold atomic recovery',{timeout:240000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'help-recovery-')),script=(await build({entryPoints:[fileURLToPath(new URL('./recovery-work-help-native.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text,authorization=['synthetic','work','help','restore','1101'].join('-');
 const create=()=>new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:join(directory,'do'),durableObjects:{ROOM:{className:'HelpRecoveryRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test',ROOM_RESTORE_TOKEN:authorization},serviceBindings:{ASSETS:async()=>new Response('Not found',{status:404})}});let mf=create(),base=await mf.ready;
 const call=(surface,path,options={})=>fetch(new URL(path+(path.includes('?')?'&':'?')+'surface='+surface,base),options),json=async(surface,path,options={})=>{const r=await call(surface,path,options);assert.equal(r.status,200,await r.clone().text());return r.json();},post=(surface,body,extra='')=>json(surface,'/api/operator/restore'+extra,{method:'POST',headers:{authorization:'Bearer '+authorization,...(typeof body==='string'?{}:{'content-type':'application/json'})},body:typeof body==='string'?body:JSON.stringify(body)});
 try{
  const seed=await json('source','/__seed'),text=await(await call('source','/__export')).text(),calls=[],faultCalls=[];let finalCounters=null;
  for(const surface of ['target','corrupt']){
   let response=await post(surface,text),steps=0,helpSteps=0,faulted=false,poisoned=false,latestInput;
   while(response.body.pending){
    const prior=await json(surface,'/__progress'),input={restoreId:response.body.restoreId,sourceSeal:response.body.sourceSeal,expectedRevision:response.body.revision,requestId:'help-step-'+steps};latestInput=input;
    const helper=prior.progress.audit?.workHelp;
    if(prior.progress.audit?.stage==='work_help'){
     helpSteps++;
     if(surface==='corrupt'&&!poisoned&&helper?.stage==='offers'&&helper.offers>0){await json(surface,'/__poison');poisoned=true;}
     if(surface==='target'&&!faulted){const result=await post(surface,input,'?fault=1');if(result.fired){faultCalls.push({cost:result.cost,clockMs:result.clockMs,unchanged:result.unchanged});assert.equal(result.status,422,JSON.stringify(result));assert.equal(result.unchanged,true);assert.deepEqual(await json(surface,'/__progress'),prior);faulted=true;}else{calls.push({surface,warm:true,faultSearchNoTrigger:true,cost:result.cost,clockMs:result.clockMs,bytes:result.body.auditProgress?.bytes-prior.progress.audit.bytes});response=result;assert.equal(result.status,202);steps++;continue;}}
    }
    const warm=surface==='target'&&prior.progress.audit?.stage==='work_help'&&helpSteps%2===0;
    if(!warm){await mf.dispose();mf=create();base=await mf.ready;}
    response=await post(surface,input);const retry=await post(surface,input);assert.deepEqual(retry.body,response.body);assert.equal(retry.status,response.status);
    if(prior.progress.audit?.stage==='work_help'){calls.push({surface,warm,cost:response.cost,clockMs:response.clockMs,bytes:response.body.auditProgress?.bytes-prior.progress.audit.bytes});assert.equal(response.cost.unknown,0);}
    if(response.status===422){assert.equal(surface,'corrupt');assert.equal(poisoned,true);assert.equal(prior.progress.audit.stage,'work_help');assert.deepEqual(await json(surface,'/__progress'),prior);break;}
    assert.ok([200,202].includes(response.status),JSON.stringify(response));assert.ok(++steps<300);
   }
   if(surface==='target'){assert.equal(response.status,200);assert.equal(response.body.subsystemContinuation.workHelp.rooms,1);assert.equal(response.body.subsystemContinuation.workHelp.deferred,0);finalCounters=response.body.subsystemContinuation.workHelp;assert.equal(finalCounters.helpsScanned,seed.helps);assert.equal(finalCounters.offersScanned,seed.offers);assert.ok(finalCounters.offerChecks>seed.offers);assert.ok(helpSteps>=5);assert.equal(faulted,true);assert.equal(response.body.replayContinuation.originalFullOracleRequired,true);await mf.dispose();mf=create();base=await mf.ready;assert.equal((await json(surface,'/api/ready')).status,200);const completedRetry=await post(surface,latestInput);assert.equal(completedRetry.status,200);assert.deepEqual(completedRetry.body,response.body);}
   else{assert.equal(response.status,422);assert.equal(poisoned,true);}
  }
  console.log('WORK_HELP_NATIVE '+JSON.stringify({seed,sourceBytes:Buffer.byteLength(text),finalCounters,calls,faultCalls,counterScope:'per-request adapter spans; excludes cold constructors, raw runtime permit SQL and test-only forensic snapshots',fullOracleStillRequired:true}));
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
