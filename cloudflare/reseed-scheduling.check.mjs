import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';import {fileURLToPath} from 'node:url';import {dirname} from 'node:path';import {execFileSync} from 'node:child_process';
const baselinePin='89816a27e';
test('actual Native per-request reseed signal has constant rows and bytes with1k/5k closed candidates and missing anchors',{timeout:60000},async()=>{
 const original=execFileSync('git',['show',baselinePin+':server/public-work-claims.mjs'],{encoding:'utf8'}),results=[];
 for(const kind of ['baseline','candidate']){
  const script=(await build({entryPoints:[fileURLToPath(new URL('./reseed-scheduling.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*'],plugins:kind==='baseline'?[{name:'frozen-baseline',setup(b){b.onLoad({filter:/server\/public-work-claims\.mjs$/},args=>({contents:original,loader:'js',resolveDir:dirname(args.path)}));}}]:[]})).outputFiles[0].text;
  const mf=new Miniflare({modules:true,script,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'ReseedSchedulingRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test'},serviceBindings:{ASSETS:async()=>new Response('Not found',{status:404})}});
  try{for(const anchored of [false,true])for(const count of [0,1000,5000]){
   const name=kind+'-'+anchored+'-'+count,url=path=>'https://room.example.test'+path+'&case='+name,seed=await mf.dispatchFetch(url('/seed?count='+count+'&anchored='+(anchored?'1':'0')));assert.equal(seed.status,200,await seed.clone().text());
   const response=await mf.dispatchFetch(url('/probe?measure=1'));assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.equal(result.pending,anchored);assert.equal(result.cost.unknown,0);results.push({kind,anchored,count,...result});
  }}finally{await mf.dispose();}
 }
 for(const anchored of [false,true]){const rows=results.filter(r=>r.kind==='candidate'&&r.anchored===anchored);for(const row of rows){assert.equal(row.cost.candidates,0);assert.equal(row.cost.rowsRead,rows[0].cost.rowsRead);assert.equal(row.cost.returnedRows,rows[0].cost.returnedRows);assert.equal(row.cost.returnedBytes,rows[0].cost.returnedBytes);assert.equal(row.cost.sqlBytes,rows[0].cost.sqlBytes);assert.equal(row.cost.bindBytes,rows[0].cost.bindBytes);}const old=results.find(r=>r.kind==='baseline'&&r.anchored===anchored&&r.count===5000);assert.ok(old.cost.rowsRead>rows[2].cost.rowsRead);}
 console.log('RESEED_SCHEDULING_COST '+JSON.stringify({baselinePin,results,scope:'per-request scheduling signal only; adapter physical rows and returned cell bytes, not raw SQL outsideadapter or CPU',actualScheduledGlobalZeroScanStillUnbounded:true}));
});
