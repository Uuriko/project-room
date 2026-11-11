import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
test('actual Worker newest uses reverse selected indexes with constant examined rows and admitted bytes',async t=>{
 const bundle=await build({entryPoints:[fileURLToPath(new URL('./wake-newest-window.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'NewestWakeProbe',useSQLite:true}}});t.after(()=>mf.dispose());
 const observations=[];
 for(const table of ['agent_wake_signals','agent_work_wakes'])for(const count of [1000,10000]){
  const response=await mf.dispatchFetch('http://localhost/'+table+count,{method:'POST',body:JSON.stringify({table,count})}),r=await response.json();
  assert.equal(response.status,200,JSON.stringify(r));observations.push(r);console.log(JSON.stringify(r));
  assert.equal(r.first,(table==='agent_wake_signals'?'signal-':'work-')+String(count-1).padStart(5,'0'));
  assert.equal(r.more,true);assert.ok(r.scalarRows<=129);assert.ok(r.scalarReads<=130);assert.ok(r.admitted.bytes<=131072);assert.ok(r.admitted.rows<=128);assert.equal(r.payloadReads,r.admitted.rows);
  for(const p of r.plans){assert.match(p,/USING INDEX agent_(wake_signals|work_wakes)_ordered_room_pending/);assert.doesNotMatch(p,/SCAN |TEMP B-TREE/);}
 }
 for(let n=0;n<observations.length;n+=2){assert.equal(observations[n].scalarReads,observations[n+1].scalarReads);assert.equal(observations[n].totalRowsRead,observations[n+1].totalRowsRead);}
 const response=await mf.dispatchFetch('http://localhost/oversize',{method:'POST',body:JSON.stringify({table:'agent_wake_signals',count:1000,oversize:true})});
 assert.equal(response.status,503);const bad=await response.json();assert.equal(bad.code,'storage_unavailable');assert.equal(bad.payloadReads,0);console.log(JSON.stringify({oversize:bad}));
});
