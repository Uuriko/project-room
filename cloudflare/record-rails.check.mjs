// Authoring gate: Node cannot qualify Worker SQLite/Ed25519/persisted restart.
// Real workerd refuses unknown fixture methods; no permissive platform double.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
test('Worker record rails preserve verified completion, scoped privacy and exact retry after restart',async()=>{
 const bundle=await build({entryPoints:[fileURLToPath(new URL('./record-rails.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const persistence=await mkdtemp(join(tmpdir(),'record-rails-worker-')),config={modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'RecordRailRoom',useSQLite:true}},durableObjectsPersist:persistence};let mf=new Miniflare(config);
 try{const seeded=await mf.dispatchFetch('http://localhost/seed');assert.equal(seeded.status,200,await seeded.clone().text());const receipt=await seeded.json();assert.equal(receipt.recordOnly,true);await mf.dispose();mf=new Miniflare(config);const resumed=await mf.dispatchFetch('http://localhost/resume',{method:'POST',body:JSON.stringify(receipt)});assert.equal(resumed.status,200,await resumed.clone().text());assert.deepEqual(await resumed.json(),{persisted:true,private:true,version:38,paymentStatus:'not_configured'});}finally{await mf.dispose();await rm(persistence,{recursive:true,force:true});}
});
