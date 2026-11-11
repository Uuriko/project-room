import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {build} from 'esbuild';import {Miniflare} from 'miniflare';import {fileURLToPath} from 'node:url';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
test('actual Native bounded merge/hash point queries, not production source encoding or authority',{timeout:120000},async()=>{
 const script=(await build({entryPoints:[fileURLToPath(new URL('./recovery-report.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
 const directory=await mkdtemp(join(tmpdir(),'report-component-'));const create=()=>new Miniflare({durableObjectsPersist:directory,modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'ReportFixture',useSQLite:true}}});let mf=create();
 try{const results=[];for(const n of [64,512]){
  const init=await mf.dispatchFetch('https://fixture.test/init?n='+n);assert.equal(init.status,200);let calls=0,final,max={statements:0,rowsRead:0,rowsWritten:0,bytes:0},total={...max};
  do{const response=await mf.dispatchFetch('https://fixture.test/step');assert.equal(response.status,200);final=await response.json();for(const k of Object.keys(max)){max[k]=Math.max(max[k],final.cost[k]);total[k]+=final.cost[k];}assert.ok(++calls<10000);if(calls===3){await mf.dispose();mf=create();}}while(final.state!=='complete');
  const values=Array.from({length:n},(_,i)=>({id:n-i,body:i<2?'x'.repeat(160000)+'🦉':'item'+String(i%17),value:i%3}));const expected=createHash('sha256').update(canonical(values.map(canonical).sort())).digest('hex');assert.equal(final.result.sha256,expected);assert.equal(final.result.rows,n);
  console.log('REPORT_NATIVE_POINT '+JSON.stringify({n,calls,max,total}));
  // A merge unit: 3 reference reads + 2 chunk reads, each scalar+payload, and 1 write.
  assert.ok(max.statements<=16*11);assert.ok(max.rowsRead<=16*11*2);assert.ok(max.bytes<=2*1024*1024);results.push({n,calls,max,total});
 }
 const sourceStart=await mf.dispatchFetch('https://fixture.test/source-init'),source=await sourceStart.json();assert.equal(sourceStart.status,200);assert.equal(source.blobKind,'ArrayBuffer');
 const hash=createHash('sha256');let sourceCarry='',sourceCalls=0,sourceMax={statements:0,rowsRead:0,rowsWritten:0,bytes:0};
 for(;;){const response=await mf.dispatchFetch('https://fixture.test/source-step');assert.equal(response.status,200);const row=await response.json();if(row.chunk!==null){let text=sourceCarry+row.chunk;sourceCarry='';if(!row.last&&/[\ud800-\udbff]$/.test(text)){sourceCarry=text.slice(-1);text=text.slice(0,-1);}hash.update(text);}for(const k of Object.keys(sourceMax))sourceMax[k]=Math.max(sourceMax[k],row.cost[k]);if(++sourceCalls===2){await mf.dispose();mf=create();}if(row.last)break;assert.ok(sourceCalls<2000);}
 assert.equal(hash.digest('hex'),source.expected);assert.ok(sourceMax.statements<=64);assert.ok(sourceMax.rowsRead<=128);assert.equal(sourceMax.rowsWritten,0);console.log('REPORT_NATIVE_SOURCE '+JSON.stringify({sourceCalls,sourceMax,blobKind:source.blobKind,coldRestart:true,exactWholeRowOracle:true}));
 console.log('REPORT_NATIVE_COST '+JSON.stringify({scope:'merge/hash SQL only; excludes constructor/source ingestion/control checkpoint; no production endpoint proof',results}));}finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
