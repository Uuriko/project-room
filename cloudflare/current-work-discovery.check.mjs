import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,mkdir,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('actual Worker standing work seeks addressed records at legal500 tasks with1k/5k message history',{timeout:180000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'standing-discovery-')),samples=[];
 try {
  const baseline=join(directory,'baseline');await mkdir(baseline);
  execFileSync('tar',['-x','-C',baseline],{input:execFileSync('git',['archive','3f1e947c7','server','src','client','strings','cloudflare','package.json'],{maxBuffer:64*1024*1024})});
  await symlink(await realpath(new URL('../node_modules',import.meta.url)),join(baseline,'node_modules'),'dir');
  for(const [name,root] of [['before',baseline],['after',fileURLToPath(new URL('../',import.meta.url))]]) {
   const bundled=await build({entryPoints:[fileURLToPath(new URL('./native-inbox-discovery.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*'],plugins:[{name:'pinned-source',setup(b){b.onResolve({filter:/^@discovery\//},args=>({path:join(root,'server',args.path.endsWith('store')?'store.mjs':'current-room-repository.mjs')}));}}]});
   const mf=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'InboxDiscoveryProbe',useSQLite:true}}});
   try {
    for(const count of [1000,5000]) {
     const call=async suffix=>{const response=await mf.dispatchFetch(`http://localhost${suffix}${suffix.includes('?')?'&':'?'}surface=${count}`);const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
     await call(`/seed?count=${count}`);
     let cursor=null,calls=0,responseBytes=0,physicalRowsRead=0,returnedSqlTextBytes=0,statements=0;
     const work=[],requests=[],started=performance.now();
     do {
      const body=await call('/work'+(cursor?'?cursor='+encodeURIComponent(cursor):''));calls++;
      assert.equal(body.cost.unknown,0);assert.equal(body.cost.rowsWritten,0);assert.equal(body.rawRuntime.rowsWritten,0);
      responseBytes+=Buffer.byteLength(JSON.stringify(body));physicalRowsRead+=body.cost.rowsRead;returnedSqlTextBytes+=body.cost.returnedSqlTextBytes;statements+=body.cost.statements;
      work.push(...body.result.work.map(item=>item.id));requests.push(...body.result.replyRequests.map(item=>item.id));cursor=body.result.page.nextCursor;
      assert.ok(calls<=500);if(name==='after')assert.ok(calls<=2,'No scan of unrelated task IDs');
     }while(cursor);
     assert.deepEqual(work,['zz-late-owned']);assert.deepEqual(requests,['zz-late-request']);
     if(name==='before')assert.equal(calls,500);else assert.equal(calls,1);
     const sample={name,messages:count,tasks:500,calls,responseBytes,physicalRowsRead,returnedSqlTextBytes,statements,elapsedMs:performance.now()-started,cpuMeasured:false,taskIds:work,requestIds:requests,complete:true};
     samples.push(sample);console.log('STANDING_WORK_SAMPLE '+JSON.stringify(sample));
    }
   }finally{await mf.dispose();}
  }
  console.log('STANDING_WORK_TOTAL '+JSON.stringify(samples));
 }finally{await rm(directory,{recursive:true,force:true});}
});
