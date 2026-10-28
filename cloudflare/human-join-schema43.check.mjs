// Explicit three-source qualification: roots are supplied by the release operator,
// never silently substituted with current code. This is not a production harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

test('persisted Workerd42→43, stale writer refusal, fallback preservation and pending resumption',{timeout:90000},async()=>{
 const old=process.env.ROOM_JOIN_OLD_ROOT, fallback=process.env.ROOM_JOIN_FALLBACK_ROOT;
 assert.ok(old && fallback,'Set ROOM_JOIN_OLD_ROOT (actual schema42 source) and ROOM_JOIN_FALLBACK_ROOT (schema43-aware prior behavior)');
 const aliases={'qualification-old-store':join(old,'server/store.mjs'),'qualification-old-storage':join(old,'cloudflare/storage.mjs'),'qualification-fallback-store':join(fallback,'server/store.mjs'),'qualification-fallback-storage':join(fallback,'cloudflare/storage.mjs')};
 assert.match(await readFile(join(old,'server/writer-fence.mjs'),'utf8'),/STORE_SCHEMA_VERSION = 42/);
 assert.match(await readFile(join(fallback,'server/writer-fence.mjs'),'utf8'),/STORE_SCHEMA_VERSION = 43/);
 const bundle=await build({entryPoints:[fileURLToPath(new URL('./human-join-schema43.fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*'],alias:aliases});
 const directory=await mkdtemp(join(tmpdir(),'join43-worker-'));
 const config={modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'JoinQualification',useSQLite:true}},durableObjectsPersist:directory};
 let mf=new Miniflare(config);
 const call=async path=>{const r=await mf.dispatchFetch('https://qualification.test'+path);assert.equal(r.status,200,await r.clone().text());return r.json();};
 const reopen=async()=>{await mf.dispose();mf=new Miniflare(config);};
 try {
  assert.equal((await call('/seed42')).version,42);await reopen();
  const candidate=await call('/upgrade');assert.deepEqual(candidate.rows.map(x=>x.status),['approved','denied','pending']);await reopen();
  assert.deepEqual(await call('/fallback'),candidate);await reopen();
  const resumed=await call('/resume');assert.deepEqual(resumed.before,candidate);assert.equal(resumed.resumed,true);
  await reopen();const final=await call('/read');assert.equal(final.rows.find(x=>x.request_id==='humanjoin-pending').status,'approved');
 } finally {await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
