import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';import {mkdtemp,rm,mkdir,symlink,realpath} from 'node:fs/promises';import {execFileSync} from 'node:child_process';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
test('actual Worker native work removes board mirror scans and retains exact cap/retry behavior',{timeout:120000},async()=>{
 const root=fileURLToPath(new URL('..',import.meta.url));
 const sourceBefore=execFileSync('git',['rev-parse','a75c9e0bf'],{cwd:root,encoding:'utf8'}).trim();
 const sourceAfter=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 let ceilingProof;const directory=await mkdtemp(join(tmpdir(),'native-work-cost-')),receipts=[];
 try{const baseline=join(directory,'baseline');await mkdir(baseline);const archive=execFileSync('git',['archive',sourceBefore,'server','src','client','strings','cloudflare','package.json'],{cwd:root,maxBuffer:64*1024*1024});execFileSync('tar',['-x','-C',baseline],{input:archive});await symlink(await realpath(new URL('../node_modules',import.meta.url)),join(baseline,'node_modules'),'dir');
 for(const [name,store] of [['before',join(baseline,'server/store.mjs')],['after',fileURLToPath(new URL('../server/store.mjs',import.meta.url))]]){
  const fixture=fileURLToPath(new URL('./current-native-work-worker.test-fixture.mjs',import.meta.url));
  const built=await build({entryPoints:[fixture],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*'],plugins:[{name:'qualified-store',setup(b){
   b.onResolve({filter:/^\.\.\/server\/store\.mjs$/},args=>args.importer===fixture?{path:store}:undefined);
   // The historical Store must use its own adapter and seed producers; mixing
   // today's restore guards into its older schema is not a valid baseline.
   if(name==='before')b.onResolve({filter:/^(\.\/storage\.mjs|\.\.\/server\/bootstrap\.mjs|\.\.\/src\/events\.js)$/},args=>args.importer===fixture?{path:join(baseline,'cloudflare',args.path)}:undefined);
  }}]});
  const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:join(directory,name),durableObjects:{ROOM:{className:'NativeWorkProbe',useSQLite:true}}});let mf=create();
  const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.cost.unknown,0);assert.equal(body.rawRuntime.unknown,0);return body;};
  try{for(const count of [32,128]){
   await call('/seed?count='+count+'&surface='+count);const accepted=await call('/accept?surface='+count);assert.equal(accepted.result.event.type,'work.accepted');
   const retry=await call('/accept?surface='+count);assert.equal(retry.result.duplicate,true);assert.equal(retry.cost.rowsWritten,0);
   const capped=await call('/cap?surface='+count);assert.equal(capped.result.code,'work_board_full');assert.equal(capped.result.eventsUnchanged,true);assert.equal(capped.result.auditUnchanged,true);
   assert.equal(accepted.legacyClaims,name==='before'?1:0);receipts.push({name,count,accepted:accepted.cost,acceptedRuntime:accepted.rawRuntime,retry:retry.cost,retryRuntime:retry.rawRuntime,cap:capped.cost,capRuntime:capped.rawRuntime,capacityQueries:capped.capacityQueries,capTop:capped.topQueries});
  }
  if(name==='after'){await call('/seed?count=500&active=499&surface=ceiling');const capped=await call('/cap?cap=499&id=task-0499&surface=ceiling');assert.equal(capped.result.code,'work_board_full');assert.equal(capped.result.eventsUnchanged,true);assert.equal(capped.result.auditUnchanged,true);assert.equal(capped.capacityQueries.length,2);ceilingProof={count:500,active:499,cost:capped.cost,runtime:capped.rawRuntime,capacityQueries:capped.capacityQueries};}
  await mf.dispose();mf=create();const coldRetry=await call('/accept?surface=128');assert.equal(coldRetry.result.duplicate,true);assert.equal(coldRetry.cost.rowsWritten,0);
  }finally{await mf.dispose();}
 }
 const before=receipts.filter(x=>x.name==='before'),after=receipts.filter(x=>x.name==='after');
 assert.ok(after[1].accepted.rowsRead<before[1].accepted.rowsRead);assert.ok(after.every(x=>x.accepted.rowsWritten<before.find(y=>y.count===x.count).accepted.rowsWritten));
 console.log('CURRENT_NATIVE_WORK_COST '+JSON.stringify({receipts,ceilingProof,sourceBefore,sourceAfter,syntheticNormalizedRooms:true,historyCertified:false}));
 }finally{await rm(directory,{recursive:true,force:true});}
});
