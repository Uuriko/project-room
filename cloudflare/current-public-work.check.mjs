import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

test('published task HTTP pages survive Worker reopen and honor withdrawals without private task disclosure',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./current-public-work.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const dir=await mkdtemp(join(tmpdir(),'public-work-native-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'PublicWorkRoom',useSQLite:true}}});
 let mf=create();const call=async path=>mf.dispatchFetch('http://localhost'+path);
 try{
  assert.equal((await call('/__seed')).status,200);await mf.dispose();mf=create();
  const first=await call('/r/public-work-room.json');assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-store');
  const page=await first.json();assert.deepEqual(page.tasks.map(x=>x.id),['public-0','public-1','public-2','public-3']);
  assert.doesNotMatch(JSON.stringify(page),/PRIVATE-WORK|PRIVATE-INSTRUCTIONS/);assert.equal(page.coverage.tasks.executionGranted,false);
  const next=new URL(page.coverage.tasks.nextRead,'http://localhost/r/public-work-room.json');
  const second=await(await call(next.pathname+next.search)).json();assert.deepEqual(second.tasks.map(x=>x.id),['public-4','public-5','public-6']);assert.equal(second.coverage.tasks.hasMore,false);
  assert.doesNotMatch(JSON.stringify(second),/PRIVATE-WORK|PRIVATE-INSTRUCTIONS|zz-private/);
  const html=await(await call('/r/public-work-room')).text();assert.match(html,/Save a useful result for task 0/);assert.match(html,/More public tasks/);
  assert.equal((await call('/r/public-work-room.json?workAfter=bad%20cursor')).status,422);
  assert.equal((await call('/r/public-work-room.json?workAfter=x&workAfter=y')).status,422);
  await mf.dispose();mf=create();assert.equal((await call(next.pathname+next.search)).status,422);
  const expired=await mf.dispatchFetch('http://localhost/r/public-work-room?workAfter=expired',{headers:{accept:'text/html'}});
  assert.equal(expired.status,422);assert.match(await expired.text(),/Reload public tasks/);
  assert.equal((await call('/__withdraw?mode=task')).status,200);
  assert.ok(!(await(await call('/r/public-work-room.json')).json()).tasks.some(x=>x.id==='public-0'));
  assert.equal((await call('/__withdraw?mode=archive')).status,200);assert.equal((await call('/r/public-work-room.json')).status,404);
  await mf.dispose();mf=create();assert.equal((await call('/r/public-work-room.json')).status,404);
 }finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
