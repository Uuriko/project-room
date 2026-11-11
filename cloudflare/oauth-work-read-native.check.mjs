import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('actual Native adopted OAuth selected work and exact result survive cold reopen',{timeout:60000},async t=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./oauth-work-read-native.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']}),dir=await mkdtemp(join(tmpdir(),'oauth-work-read-native-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'OAuthWorkReadRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const started=performance.now(),r=await mf.dispatchFetch('http://localhost'+path),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));if(body.cost){assert.equal(body.cost.unknown,0);t.diagnostic(JSON.stringify({path,...body.cost,observedHostWallMs:performance.now()-started}));}return body;};
 try{
  assert.equal((await call('/seed')).members,5);
  const selected=await call('/read');assert.equal(selected.value.revision,4);assert.ok(JSON.stringify(selected.value).includes('Saved useful result.'));assert.equal(selected.cost.unknown,0);
  const latest=await call('/messages-latest');assert.equal(latest.value.messages.at(-1).messageId,'later-11');
  const query=await call('/messages-query');assert.equal(query.value.messages.length,12);assert.equal(query.value.query.matched,12);assert.ok(query.value.query.scanned>12);assert.equal(query.value.query.text,'LaTeR');
  const first=await call('/messages-forward');assert.equal(first.value.messages.length,1);
  const batch=await call('/batch');assert.equal(batch.value.items.length,2);assert.equal(batch.cost.unknown,0);
  await mf.dispose();mf=create();const cold=await call('/read');assert.equal(cold.value.revision,4);assert.equal(cold.value.workItemId,'task');

 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
