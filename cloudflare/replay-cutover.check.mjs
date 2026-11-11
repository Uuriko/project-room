import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('actual Worker durable Muse-sized witness progresses across restart with constant source guard cost',async()=>{
  const built=await build({entryPoints:[fileURLToPath(new URL('./replay-cutover.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const directory=await mkdtemp(join(tmpdir(),'durable-cutover-'));
  const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'ReplayCutoverRoom',useSQLite:true}}});
  let mf=create();const call=async path=>{const r=await mf.dispatchFetch('http://localhost'+path),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
  try{
    const runtime=await call('/runtime');assert.equal(runtime.storage.valueLimitBytes,8388642,'use the qualified October runtime');
    await call('/seed?bytes=2376000');const captured=await call('/durable-capture');
    const baseline=await call('/append-cost?i=90&baseline=1');const before=await call('/append-cost?i=0');await call('/seed-derived?count=17405&generation='+captured.generation);
    const after=await call('/append-cost?i=1');assert.deepEqual(after.eventStatementCosts,before.eventStatementCosts,'derived history must not grow the ordinary append guard');
    await call('/readmit');
    let progress={bytes:0};const measured=await call(`/durable-step-cost?generation=${captured.generation}&bytes=0&step=0`),first=measured.result;progress=first;
    await mf.dispose();mf=create();
    for(let step=1;progress.phase!=='witness_verified'&&step<200;step++){
      progress=await call(`/durable-step?generation=${captured.generation}&bytes=${progress.bytes}&step=${step}`);
      if(step===3)await call('/append-cost?i=2');
    }
    assert.equal(progress.phase,'witness_verified');assert.equal(progress.bytes,2376000);assert.equal(progress.certified,false);assert.equal(progress.head,2);
    const historical=await call(`/durable-step?generation=${captured.generation}&bytes=0&step=0`);
    assert.deepEqual({...historical,duplicate:false},first,'old phase receipt remains historical after later advances');
    const duplicateCapture=await call('/durable-capture');assert.deepEqual({...duplicateCapture,duplicate:false},captured);
    console.log('DURABLE_REPLAY_CAPTURE_WORKER '+JSON.stringify({runtime,head:progress.head,bytes:progress.bytes,phase:progress.phase,certified:false,derivedLeaves:17405,withoutGuard:baseline.eventStatementCosts,guardBefore:before.eventStatementCosts,guardAfter:after.eventStatementCosts,hashStepCost:measured.cost,originalStepBytes:historical.bytes}));
  }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});


test('actual Worker partitions 17,405 captured messages through bounded codec steps and partial restart',async()=>{
  const built=await build({entryPoints:[fileURLToPath(new URL('./replay-cutover.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const directory=await mkdtemp(join(tmpdir(),'codec-cutover-'));
  const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'ReplayCutoverRoom',useSQLite:true}}});
  let mf=create();const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
  try{
    assert.equal((await call('/runtime')).storage.valueLimitBytes,8388642);
    const seed=await call('/seed-codec');assert.ok(seed.bytes>2376000&&seed.bytes<4194304);
    const capture=await call('/durable-capture');let progress={bytes:0};
    for(let i=0;progress.phase!=='witness_verified'&&i<300;i++)progress=await call(`/durable-step?generation=${capture.generation}&bytes=${progress.bytes}&step=${i}`);
    assert.equal(progress.phase,'witness_verified');progress={bytes:0};let first,maxRecords=0,maxInputBytes=0,steps=0;
    while(progress.phase!=='codec_partitioned'&&steps<1000){
      progress=await call(`/durable-codec?generation=${capture.generation}&bytes=${progress.bytes}&step=${steps}`);
      first??=progress;maxRecords=Math.max(maxRecords,progress.records);assert.ok(progress.inputBytes<=262144);assert.ok(progress.logicalUnitRows<=200);maxInputBytes=Math.max(maxInputBytes,progress.inputBytes);assert.ok(progress.leafCommitments.length<=32);steps++;
      if(steps===2){await mf.dispose();mf=create();}
      if(steps===4)await call('/append-cost?i=33');
    }
    assert.equal(progress.phase,'codec_partitioned');assert.equal(progress.bytes,seed.bytes);assert.equal(progress.certified,false);assert.ok(maxRecords<=32);
    const census=await call('/codec-census');assert.equal(census.messages,17405);assert.ok(census.maxLeafBytes<1000);assert.equal(census.entries,305);assert.ok(census.maxReceiptBytes<=4096);
    const leaf=await call('/codec-leaf?generation='+capture.generation);assert.equal(leaf.value.id,'request-17');assert.equal(leaf.value.body,'x'.repeat(720));
    const original=await call(`/durable-codec?generation=${capture.generation}&bytes=0&step=0`);assert.deepEqual({...original,duplicate:false},first);
    await call('/codec-leaf-tamper');await mf.dispose();mf=create();
    const refused=await mf.dispatchFetch('http://localhost/codec-leaf?generation='+capture.generation);assert.equal(refused.status,500);
    assert.match((await refused.json()).message,/independent replay leaf binding changed/);
    console.log('DURABLE_REPLAY_CODEC_WORKER '+JSON.stringify({bytes:seed.bytes,steps,maxRecords,maxInputBytes,census,head:progress.head,certified:false,publication:progress.publication}));
  }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});


test('actual Worker abandons and cleans a large derived generation across restart without serving changes', async () => {
  const built = await build({entryPoints:[fileURLToPath(new URL('./replay-cutover.test-fixture.mjs', import.meta.url))],
    bundle:true, write:false, format:'esm', platform:'neutral', external:['node:*','cloudflare:*']});
  const directory = await mkdtemp(join(tmpdir(), 'abandon-cutover-'));
  const create = () => new Miniflare({modules:true, script:built.outputFiles[0].text,
    compatibilityDate:'2026-07-30', compatibilityFlags:['nodejs_compat'], durableObjectsPersist:directory,
    durableObjects:{ROOM:{className:'ReplayCutoverRoom',useSQLite:true}}});
  let mf = create();
  const call = async path => {
    const response = await mf.dispatchFetch('http://localhost' + path), body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  try {
    assert.equal((await call('/runtime')).storage.valueLimitBytes, 8388642);
    await call('/seed?bytes=2376000');
    const capture = await call('/durable-capture'), suffix = '?generation=' + capture.generation;
    await call('/seed-derived?count=17405&generation=' + capture.generation);
    const before = await call('/lifecycle-census' + suffix);
    const abandoned = await call('/durable-abandon' + suffix);
    assert.equal(abandoned.lifecycle, 'abandoned');
    assert.equal(abandoned.certified, false);
    let progress = {deleted:0}, first, steps = 0;
    const maxCost = {statements:0,rowsRead:0,rowsWritten:0};
    const maxWarmCost = {statements:0,rowsRead:0,rowsWritten:0};
    let coldCost;
    while (!progress.done && steps < 100) {
      const response = await call(`/durable-cleanup${suffix}&deleted=${progress.deleted}&step=${steps}`);
      first ??= response.result;
      progress = response.result;
      assert.ok(progress.rowsDeleted <= 200);
      for (const key of Object.keys(maxCost)) {
        maxCost[key] = Math.max(maxCost[key], response.cost[key]);
        if (steps !== 1) maxWarmCost[key] = Math.max(maxWarmCost[key], response.cost[key]);
      }
      if (steps === 1) coldCost = response.cost;
      if (++steps === 1) { await mf.dispose(); mf = create(); }
    }
    assert.equal(progress.done, true);
    const after = await call('/lifecycle-census' + suffix);
    assert.equal(after.units, 0);
    assert.equal(after.head, before.head);
    assert.equal(after.metadataHash, before.metadataHash);
    const historical = await call(`/durable-cleanup${suffix}&deleted=0&step=0`);
    assert.deepEqual({...historical.result,duplicate:false}, first);
    const oldAbandonment = await call('/durable-abandon' + suffix);
    assert.deepEqual({...oldAbandonment,duplicate:false}, abandoned);
    console.log('DURABLE_REPLAY_ABANDONMENT_WORKER ' + JSON.stringify({head:after.head,derivedUnits:17405,
      steps,maxPhysicalCost:maxCost,maxWarmPhysicalCost:maxWarmCost,coldAdmissionCost:coldCost,certified:false,servingMetadataUnchanged:true}));
  } finally { await mf.dispose(); await rm(directory,{recursive:true,force:true}); }
});


test('actual Worker first-H COW measures idle/active overhead and preserves proof across restart and erasure', async () => {
  const built = await build({entryPoints:[fileURLToPath(new URL('./replay-cutover.test-fixture.mjs',import.meta.url))],
    bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const directory = await mkdtemp(join(tmpdir(),'cow-cutover-'));
  const create = () => new Miniflare({modules:true,script:built.outputFiles[0].text,
    compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,
    durableObjects:{ROOM:{className:'ReplayCutoverRoom',useSQLite:true}}});
  let mf = create();
  const call = async (surface,path) => {
    const response = await mf.dispatchFetch('http://localhost'+path+(path.includes('?')?'&':'?')+'surface='+surface);
    const body = await response.json();
    assert.equal(response.status,200,JSON.stringify(body));return body;
  };
  try {
    assert.equal((await call('cow-active','/runtime')).storage.valueLimitBytes,8388642);
    const measurements = {};
    let captured;
    for (const mode of ['baseline','idle','active']) {
      const surface = 'cow-'+mode;
      await call(surface,'/cow-seed?mode='+mode);
      if (mode==='active') {
        captured = await call(surface,'/cow-capture');
        await call(surface,'/seed-derived?count=17405&generation='+captured.generation);
      }
      measurements[mode] = [await call(surface,'/cow-write-cost?revision=0'),
        await call(surface,'/cow-write-cost?revision=1')];
    }
    assert.equal(measurements.baseline[0].source.rows,0);
    assert.equal(measurements.idle[0].source.rows,0);
    assert.equal(measurements.active[0].source.rows,1);
    assert.deepEqual(measurements.active[1].source,measurements.active[0].source);
    await mf.dispose();mf=create();
    const h = await call('cow-active','/cow-read?generation='+captured.generation);
    assert.equal(h.row.body,'Independent original body');
    assert.equal(h.row.edited_at,null);
    assert.equal((await call('cow-active','/cow-delete?generation='+captured.generation)).remaining,0);
    await call('cow-fault','/cow-seed');
    await call('cow-fault','/cow-capture');
    const before = await call('cow-fault','/cow-state');
    const failed = await mf.dispatchFetch('http://localhost/cow-fault?surface=cow-fault');
    assert.equal(failed.status,500);
    assert.match((await failed.json()).message,/synthetic Worker COW storage failure/);
    assert.deepEqual(await call('cow-fault','/cow-state'),before);
    console.log('DURABLE_REPLAY_COW_WORKER '+JSON.stringify({derivedUnits:17405,measurements,
      restartOldProofPreserved:true,erasureRemovedGeneration:true,storageFaultRolledBack:true,certified:false}));
  } finally {await mf.dispose();await rm(directory,{recursive:true,force:true});}
});


test('actual Worker preserves H work and released body across restart and explicit privacy erasure',async()=>{
  const built=await build({entryPoints:[fileURLToPath(new URL('./replay-cutover.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const directory=await mkdtemp(join(tmpdir(),'reference-cow-'));
  const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'ReplayCutoverRoom',useSQLite:true}}});
  let mf=create();const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path+(path.includes('?')?'&':'?')+'surface=references'),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
  try{
    assert.equal((await call('/runtime')).storage.valueLimitBytes,8388642);
    const seed=await call('/reference-seed');await call('/seed-derived?count=17405&generation='+seed.capture.generation);
    const edit=await call('/reference-edit');await mf.dispose();mf=create();
    const read=(kind,key)=>call('/reference-read?generation='+seed.capture.generation+'&kind='+kind+'&key='+key);
    assert.deepEqual((await read('work','task')).row,seed.work);
    assert.deepEqual((await read('body',seed.body.sha)).row,seed.body);
    const tail=await call('/tail-read?generation='+seed.capture.generation+'&sequence=5');
    assert.equal(tail.sequence,5);assert.equal(tail.certified,false);assert.ok(tail.inputBytes<=262144);
    const before=await call('/cow-state');
    const fault=await mf.dispatchFetch('http://localhost/tail-fault?surface=references');
    assert.equal(fault.status,500);assert.match((await fault.json()).message,/synthetic prospective binding failure/);
    assert.deepEqual(await call('/cow-state'),before);

    assert.equal((await call('/reference-delete')).remaining,0);
    console.log('DURABLE_REPLAY_REFERENCE_COW '+JSON.stringify({cost:edit.cost,oldWorkAndBodySurviveRestart:true,privacyRemovedAllRawUnits:true,certified:false}));
  }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});


test('actual Worker H member keyset pages stay bounded with 1,000 and 17,405 proved rows',async()=>{
  const built=await build({entryPoints:[fileURLToPath(new URL('./replay-cutover.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const directory=await mkdtemp(join(tmpdir(),'h-member-page-'));
  const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'ReplayCutoverRoom',useSQLite:true}}});
  let mf=create();const call=async(surface,path)=>{const response=await mf.dispatchFetch('http://localhost'+path+(path.includes('?')?'&':'?')+'surface='+surface),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
  try{
    const costs={};
    for(const [surface,count] of [['h-small',1000],['h-large',17405]]){
      const seed=await call(surface,'/h-page-seed?count='+count);
      await call(surface,'/readmit');
      const page=await call(surface,'/h-page?generation='+seed.capture.generation);
      assert.equal(page.result.rows.length,16);assert.equal(page.result.examined,16);assert.equal(page.result.done,false);
      assert.ok(page.result.inputBytes<=262144);assert.ok(page.result.logicalUnitRows<=200);
      costs[count]=page.cost;
      await mf.dispose();mf=create();
      const next=await call(surface,'/h-page?generation='+seed.capture.generation+'&after='+page.result.after);
      assert.equal(next.result.rows[0].key,'member-00016');assert.equal(next.result.certified,false);
    }
    assert.ok(costs[17405].rowsRead<=costs[1000].rowsRead+16,JSON.stringify(costs));
    console.log('DURABLE_H_MEMBER_PAGE '+JSON.stringify({costs,historyProvenance:'unknown',certified:false}));
  }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});


test('actual Worker complete H work/default qualification resumes across process loss with historical retry',async()=>{
  const built=await build({entryPoints:[fileURLToPath(new URL('./replay-cutover.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const directory=await mkdtemp(join(tmpdir(),'h-work-qualification-'));
  const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'ReplayCutoverRoom',useSQLite:true}}});
  let mf=create();const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path+(path.includes('?')?'&':'?')+'surface=h-work'),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
  try{
    const seed=await call('/work-qualification-seed');let first,last,maxInputBytes=0,maxReads=0,maxWarmReads=0,maxWrites=0;const samples={};
    for(let count=0;count<seed.count;count++){
      const step=await call('/work-qualify?generation='+seed.capture.generation+'&count='+count);first??=step.result;last=step.result;
      assert.deepEqual(step.source,seed.source);assert.equal(step.result.workCount,count+1);assert.ok(step.result.inputBytes<=262144);
      maxInputBytes=Math.max(maxInputBytes,step.result.inputBytes);maxReads=Math.max(maxReads,step.cost.rowsRead);maxWrites=Math.max(maxWrites,step.cost.rowsWritten);
      if(count!==1)maxWarmReads=Math.max(maxWarmReads,step.cost.rowsRead);
      if([0,1,2,64].includes(count))samples[count]=step.cost;
      if(count===0){await mf.dispose();mf=create();}
    }
    assert.ok(samples[64].rowsRead<=samples[2].rowsRead+2,'examined H work must not be rescanned: '+JSON.stringify(samples));
    assert.equal(last.phase,'work_qualified');assert.equal(last.workDefaultsQualified,true);assert.equal(last.certified,false);
    const retry=await call('/work-qualify?generation='+seed.capture.generation+'&count=0');assert.deepEqual({...retry.result,duplicate:false},first);
    console.log('DURABLE_H_WORK_QUALIFICATION '+JSON.stringify({count:seed.count,maxInputBytes,maxReads,maxWarmReads,maxWrites,samples,restarted:true,unchangedServingProof:true,historyProvenance:'unknown',certified:false}));
  }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});

test('actual Worker nested retained identity growth stays in fixed codec controls and bounded steps',async()=>{
  const built=await build({entryPoints:[fileURLToPath(new URL('./replay-cutover.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const directory=await mkdtemp(join(tmpdir(),'nested-retained-'));
  const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'ReplayCutoverRoom',useSQLite:true}}});
  let mf=create();const call=async(surface,path)=>{const response=await mf.dispatchFetch('http://localhost'+path+(path.includes('?')?'&':'?')+'surface='+surface),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
  try{
    const measured={};
    for(const [surface,count] of [['archive-small',1000],['archive-large',24000]]){
      const seed=await call(surface,'/nested-archive-seed?count='+count);let progress={bytes:0},step=0;
      while(progress.phase!=='witness_verified'&&step<300)progress=await call(surface,'/durable-step?generation='+seed.capture.generation+'&bytes='+progress.bytes+'&step='+step++);
      assert.equal(progress.phase,'witness_verified');progress={bytes:0};step=0;
      let maximumInputBytes=0,maximumLogicalRows=0,maximumWarmReads=0,representativeCost;
      while(progress.phase!=='codec_partitioned'&&step<1200){
        const next=await call(surface,'/nested-archive-codec?generation='+seed.capture.generation+'&bytes='+progress.bytes+'&step='+step);
        progress=next.result;assert.ok(progress.inputBytes<=262144);assert.ok(progress.logicalUnitRows<=200);
        maximumInputBytes=Math.max(maximumInputBytes,progress.inputBytes);maximumLogicalRows=Math.max(maximumLogicalRows,progress.logicalUnitRows);
        if(step!==3)maximumWarmReads=Math.max(maximumWarmReads,next.cost.rowsRead);
        if(step===2)representativeCost=next.cost;
        if(step===2){await mf.dispose();mf=create();}
        if(step===4)await call(surface,'/append-cost?i=77');
        step++;
      }
      assert.equal(progress.phase,'codec_partitioned');
      const census=await call(surface,'/nested-archive-census?generation='+seed.capture.generation);
      assert.equal(census.count,count);assert.equal(census.frame.entries,count);assert.equal(census.frame.kind,'entry-array');
      assert.equal(census.maximumLeafBytes,130);assert.equal(census.sample,'retained-000017-'+'x'.repeat(112));
      measured[count]={sourceBytes:seed.capture.bytes,steps:step,maximumInputBytes,maximumLogicalRows,maximumWarmReads,representativeCost};
    }
    assert.ok(measured[24000].representativeCost.rowsRead<=measured[1000].representativeCost.rowsRead+32,JSON.stringify(measured));
    const bad=await call('archive-bad','/nested-archive-seed?count=1&bad=1');let progress={bytes:0},step=0;
    while(progress.phase!=='witness_verified')progress=await call('archive-bad','/durable-step?generation='+bad.capture.generation+'&bytes='+progress.bytes+'&step='+step++);
    const before=await call('archive-bad','/nested-archive-state');
    const refused=await mf.dispatchFetch('http://localhost/nested-archive-codec?generation='+bad.capture.generation+'&bytes=0&step=0&surface=archive-bad');
    assert.equal(refused.status,500);assert.match((await refused.json()).message,/codec/);
    assert.deepEqual(await call('archive-bad','/nested-archive-state'),before);
    console.log('DURABLE_NESTED_RETAINED_CODEC '+JSON.stringify({measured,restarted:true,concurrentAppend:true,invalidIdentityRefusedAtomically:true,certified:false,semanticMembershipQualified:false}));
  }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
