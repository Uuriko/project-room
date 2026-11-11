import {mkdtemp,rm,readdir,writeFile,readFile} from 'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{DatabaseSync}from'node:sqlite';import{RoomStore}from'../server/store.mjs';import{projectionContentHash}from'../server/write-integrity.mjs';
import {spawn} from 'node:child_process';
import test from 'node:test';import assert from 'node:assert/strict';import{createHash}from'node:crypto';import{fileURLToPath}from'node:url';import{build}from'esbuild';import{Miniflare}from'miniflare';import{performance}from'node:perf_hooks';
async function inspector(mf){
  const base=await mf.getInspectorURL(),http=new URL(base.href.replace(/^ws:/,'http:'));http.pathname='/json/list';
  const targets=await(await fetch(http)).json();const target=targets.find(x=>x.webSocketDebuggerUrl);if(!target)throw Error('missing inspector target');
  const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let id=0;const waiting=new Map();ws.addEventListener('message',event=>{const value=JSON.parse(event.data),item=waiting.get(value.id);if(item){waiting.delete(value.id);value.error?item.reject(Error(JSON.stringify(value.error))):item.resolve(value.result);}});
  return{call(method,params={}){return new Promise((resolve,reject)=>{const key=++id;waiting.set(key,{resolve,reject});ws.send(JSON.stringify({id:key,method,params}));});},close(){ws.close();}};
}
async function processSampler(pid){
  const child=spawn('python3',[fileURLToPath(new URL('../scripts/prototypes/measure-darwin-process.py',import.meta.url)),String(pid)],{stdio:['pipe','pipe','inherit']});
  let text='';let ready;const started=new Promise(resolve=>ready=resolve);
  child.stdout.on('data',data=>{text+=data; if(text.includes('\n'))ready();});
  const ended=new Promise((resolve,reject)=>child.on('exit',code=>code===0?resolve():reject(Error('resource sampler failed '+code))));
  await Promise.race([started,ended.then(()=>{throw Error('sampler exited before ready');})]);
  return async()=>{child.stdin.end('stop\n');await ended;return JSON.parse(text.trim().split('\n').at(-1));};
}
test('actual workerd measures admitted one-time SQL capture and immutable reads after live appends',async()=>{
  const bundle=await build({entryPoints:[fileURLToPath(new URL('./replay-projection-witness.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const measurements=[];
  for(const bytes of (process.env.WITNESS_SIZES?process.env.WITNESS_SIZES.split(',').map(Number):process.env.WITNESS_REQUIRE_MUSE==='1'?[2376000]:[512*1024,1024*1024,1536*1024,1900*1024,2*1024*1024,2376000,4*1024*1024,8*1024*1024])){
    const persistence=await mkdtemp(join(tmpdir(),'witness-existing-'));
    let pidFile=null;
    if(process.env.WITNESS_PROCESS_METRICS==='1'){
      if(process.platform!=='darwin')throw Error('process sampler requires Darwin');
      const binary=process.env.WITNESS_REAL_WORKERD;if(!binary||!/^[A-Za-z0-9_/.~-]+$/.test(binary))throw Error('explicit workerd binary required');
      pidFile=join(persistence,'workerd.pid');const wrapper=join(persistence,'workerd-wrapper');
      await writeFile(wrapper,'#!/bin/sh\nprintf \'%s\\n\' "$$" > "'+pidFile+'"\nexec "'+binary+'" "$@"\n',{mode:0o700});
      process.env.MINIFLARE_WORKERD_PATH=wrapper;
    }
    const makeWorker=()=>new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],inspectorPort:0,durableObjectsPersist:persistence,durableObjects:{ROOM:{className:'ReplayWitnessRoom',useSQLite:true}}});let mf=makeWorker(),debug;
    const mode=process.env.WITNESS_MODE??'whole';
    const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path);return{status:response.status,body:await response.json()};};
    try{
      let seed=await call('/seed?bytes='+bytes),legacyFixture=false;
      if(seed.status!==200){
        const seedFailure=seed;await mf.dispose();
        const files=await readdir(persistence,{recursive:true});let database;
        for(const name of files.filter(x=>x.endsWith('.sqlite'))){const probe=new DatabaseSync(join(persistence,name));if(probe.prepare("SELECT 1 FROM sqlite_master WHERE name='rooms'").get()){database=probe;break;}probe.close();}
        if(!database)throw Error('missing synthetic durable SQLite database');
        // Trusted historical-writer fixture ONLY: install an admitted existing
        // value offline, with its pre-existing independent metadata/content proof.
        // This bypasses today's seed-row limit, not the capture under measurement.
        try{database.exec('BEGIN');database.prepare('UPDATE room_writer_permit SET version=44 WHERE singleton=1').run();
          const state=JSON.parse(database.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);state.room.syntheticPadding='';state.room.syntheticPadding='p'.repeat(bytes-Buffer.byteLength(JSON.stringify(state)));const text=JSON.stringify(state),hash=createHash('sha256').update(text).digest('hex'),content=projectionContentHash(database,'commons',2,text);
          database.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(text);
          database.prepare("UPDATE integrity_room_state SET projection_bytes=?,metadata_hash=?,projection_hash=? WHERE room_id='commons'").run(text.length,hash,content);assert.equal(createHash('sha256').update(database.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection).digest('hex'),database.prepare("SELECT metadata_hash FROM integrity_room_state WHERE room_id='commons'").get().metadata_hash);assert.equal(projectionContentHash(database,'commons',2,text),content);
          const checksum=RoomStore.prototype.integrityChecksum.call({db:database,readTransaction:fn=>fn()}).text;
          database.prepare('UPDATE integrity_snapshot SET checksum=? WHERE id=1').run(checksum);
          database.prepare('UPDATE room_writer_permit SET version=0 WHERE singleton=1').run();database.exec('COMMIT');
        }catch(error){if(database.isTransaction)database.exec('ROLLBACK');throw error;}finally{database.close();}
        mf=makeWorker();legacyFixture=true;seed={status:200,body:{bytes,head:2,seedFailure:seedFailure.body.error}};
      }
      const runtime=(await call('/runtime')).body;debug=await inspector(mf);let heapBefore=null,heapAfter=null,profile=null,inspectorLimitation=null;
      try{heapBefore=await debug.call('Runtime.getHeapUsage');await debug.call('Profiler.enable');await debug.call('Profiler.start');}catch(error){inspectorLimitation=error.message;}
      const stopSampler=pidFile?await processSampler(Number(await readFile(pidFile,'utf8'))):null;
      const start=performance.now(),captured=await call('/capture?mode='+mode),hostWallMs=performance.now()-start;
      const processResources=stopSampler?await stopSampler():null;
      try{profile=(await debug.call('Profiler.stop')).profile;heapAfter=await debug.call('Runtime.getHeapUsage');}catch(error){inspectorLimitation=error.message;}
      if(captured.status!==200){if(bytes>8388608)assert.equal(captured.body.error.message,'witness byte ceiling');measurements.push({mode,requestedBytes:bytes,admitted:false,stage:'existing-value-capture',legacyFixture,runtime,status:captured.status,error:captured.body.error,heapBefore,heapAfter,hostWallMs});continue;}const state=(await call('/state')).body;
      const standaloneSql={};for(const operation of ['octet','cast','slice'])standaloneSql[operation]=await call('/sql-cost?operation='+operation);
      const appended=await call('/append');if(appended.status===200)assert.equal(appended.body.head,7);await mf.dispose();mf=makeWorker();const duplicate=await call('/capture?mode='+mode);assert.equal(duplicate.body.result.duplicate,true);
      assert.equal((await call('/state')).body.capture.metadata_hash,state.capture.metadata_hash);
      const hash=createHash('sha256');let transferred=0,maxSlice=0,maxSliceSqlWallMs=0;const sliceCost={statements:0,rowsRead:0,rowsWritten:0};const stopSliceSampler=pidFile?await processSampler(Number(await readFile(pidFile,'utf8'))):null;const slicesStart=performance.now();
      for(let offset=0;;offset+=16384){const slice=(await call('/slice?offset='+offset)).body;maxSliceSqlWallMs=Math.max(maxSliceSqlWallMs,slice.wallMs);for(const key of Object.keys(sliceCost))sliceCost[key]+=slice.cost[key];if(!slice.bytes)break;const data=Buffer.from(slice.base64,'base64');transferred+=data.length;maxSlice=Math.max(maxSlice,data.length);hash.update(data);}
      const slicesWallMs=performance.now()-slicesStart,sliceProcessResources=stopSliceSampler?await stopSliceSampler():null;
      assert.equal(hash.digest('hex'),state.capture.metadata_hash);assert.equal(transferred,seed.body.bytes);assert.ok(maxSlice<=16384);
      let portableHash=null;
      if(process.env.WITNESS_PORTABLE_HASH==='1'){
        for(let step=0;step<600;step++){
          const advanced=await call('/hash-step');assert.equal(advanced.status,200);portableHash=advanced.body;
          assert.equal(portableHash.head,2);assert.ok(portableHash.controlBytes<=1024);
          if(portableHash.complete)break;
          if(step===2||step===6){await mf.dispose();mf=makeWorker();}
        }
        assert.equal(portableHash.complete,true);assert.equal(portableHash.matchesIndependentProof,true);
        assert.equal(portableHash.bytes,bytes);
        assert.deepEqual((await call('/hash-step')).body,portableHash,'completed hash retry must not consume another chunk');
      }
      const activeIds=new Set(profile?.nodes.filter(node=>!['(idle)','(root)'].includes(node.callFrame.functionName)).map(node=>node.id));
      let activeSampleUs=0;for(let i=0;i<(profile?.samples?.length??0);i++)if(activeIds.has(profile.samples[i]))activeSampleUs+=profile.timeDeltas?.[i]??0;
      measurements.push({mode,requestedBytes:bytes,admitted:true,legacyFixture,runtime,seedFailure:seed.body.seedFailure??null,capturedBytes:captured.body.result.byte_length,cost:captured.body.cost,hostWallMs,processResources,standaloneSql,portableHash,slicesWallMs,sliceProcessResources,sliceCost,maxSliceSqlWallMs,heapBefore,heapAfter,sampledActiveCpuUs:profile?activeSampleUs:null,inspectorLimitation,maxSlice,appendStatus:appended.status,appendError:appended.body.error??null,duplicateCost:duplicate.body.cost});
    }finally{debug?.close();await mf.dispose();await rm(persistence,{recursive:true,force:true});}
  }
  console.log('ONE_TIME_SQL_CAPTURE_WORKER '+JSON.stringify(measurements));if(process.env.WITNESS_REQUIRE_MUSE==='1')assert.equal(measurements.find(row=>row.requestedBytes===2376000)?.admitted,true,'existing Muse-sized value must be capturable');else assert.ok(measurements.some(row=>row.admitted));
});
