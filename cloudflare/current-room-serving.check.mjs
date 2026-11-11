import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('actual Worker current serving survives restart and source-excluded windows stay bounded',async()=>{
  const built=await build({entryPoints:[fileURLToPath(new URL('./current-room-serving.test-fixture.mjs',import.meta.url))],
    bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const directory=await mkdtemp(join(tmpdir(),'current-serving-'));
  const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],
    durableObjectsPersist:directory,durableObjects:{ROOM:{className:'CurrentServingRoom',useSQLite:true}}});
  let mf=create();
  const call=async(path,status=200)=>{const response=await mf.dispatchFetch('http://localhost'+path),body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;};
  try{
    const samples=[];
    for(const [surface,count]of[['small',1000],['large',5000]]){
      const seeded=await call(`/seed?surface=${surface}&count=${count}`);assert.equal(seeded.runtime.valueLimitBytes,8388642);
      await call(`/read?surface=${surface}&as=reader`); // Cold owned-schema discovery measured separately below.
      const excluded=await call(`/read?surface=${surface}&as=reader`);
      assert.equal(excluded.result.messages.length,0);assert.ok(excluded.result.nextCursor);assert.equal(excluded.result.sourceWindow.complete,false);
      assert.ok(excluded.result.sourceWindow.examined>0&&excluded.result.sourceWindow.examined<=64);
      const missing=await call(`/read?surface=${surface}&as=reader&message=missing`);assert.equal(missing.error.status,404);
      const old=await call(`/read?surface=${surface}&as=reader&message=old-0&trace=1`);assert.equal(old.error.status,404);
      samples.push({surface,count,excluded:excluded.cost,missing:missing.cost,old:old.cost,oldCostSources:old.trace?.sort((a,b)=>b.cost.rowsRead-a.cost.rowsRead).slice(0,3),window:excluded.result.sourceWindow});
    }
    for(const operation of ['excluded','missing','old'])assert.ok(samples[1][operation].rowsRead<=samples[0][operation].rowsRead+32,JSON.stringify(samples));
    const first=await call('/post?surface=small&id=saved');const reply=await call('/post?surface=small&id=reply&reply=saved');
    assert.equal(first.result.duplicate,false);assert.equal(reply.result.duplicate,false);
    await mf.dispose();mf=create();
    const retry=await call('/post?surface=small&id=saved');assert.equal(retry.result.duplicate,true);assert.equal(retry.result.sequence,first.result.sequence);
    const selected=await call('/read?surface=small&message=reply');assert.equal(selected.result.messages[0].body,'A useful saved message');
    const state=await call('/state?surface=small');assert.equal(state.permit.enabled,0);assert.equal(state.permit.room_id,null);assert.equal(state.permit.receipt_id,null);
    assert.equal(JSON.parse(state.projection).normalizedCurrent.version,1);
    await call('/seed?surface=head-fault&count=0');await call('/head-fault?surface=head-fault');
    const damaged=await call('/read?surface=head-fault');assert.match(damaged.error.message,/closed current marker lacks/);
    console.log('CURRENT_SERVING_WORKER '+JSON.stringify({samples,post:first.cost,reply:reply.cost,retry:retry.cost,restartRead:selected.cost,head:state.head.sequence,historyCertified:false,existingRoomMigration:false}));
  }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
