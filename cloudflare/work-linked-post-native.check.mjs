import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('actual Native adopted OAuth plain and work-linked post retain cold exact receipt and small carrier',{timeout:60000},async t=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./work-linked-post-native.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']}),dir=await mkdtemp(join(tmpdir(),'work-post-native-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'WorkLinkedPostRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const started=performance.now(),r=await mf.dispatchFetch('http://localhost'+path),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));if(body.cost){assert.equal(body.cost.unknown,0);t.diagnostic(JSON.stringify({path,...body.cost,observedHostWallMs:performance.now()-started}));}return body;};
 try{
  assert.equal((await call('/seed')).members,5);await call('/plain');const post=await call('/post');assert.equal(post.result.duplicate,false);assert.equal(post.result.event.data.workItemId,'task');
  assert.ok(post.cost.rowsRead<10000);assert.ok(post.cost.returnedSqlTextBytes<256*1024);assert.ok(post.cost.rowsWritten<100);
  await mf.dispose();mf=create();const retry=await call('/post');assert.equal(retry.result.duplicate,true);assert.equal(retry.result.sequence,post.result.sequence);assert.equal(retry.result.event.id,post.result.event.id);assert.equal(retry.cost.rowsWritten,0);
  const state=await call('/read');assert.equal(state.result.body,'x'.repeat(1648));assert.ok(state.result.carrierBytes<512);assert.deepEqual(state.result.permit,{enabled:0,room_id:null,receipt_id:null});
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
