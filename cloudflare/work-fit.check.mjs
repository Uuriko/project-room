// Node HTTP coverage cannot prove Worker SQLite transaction/restart semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
test('advisory work fit persists and rolls back atomically in actual Worker SQLite across restart',async()=>{
 const bundle=await build({entryPoints:[fileURLToPath(new URL('./work-fit.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const persistence=await mkdtemp(join(tmpdir(),'work-fit-worker-')),config={modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'WorkFitRoom',useSQLite:true}},durableObjectsPersist:persistence};let mf=new Miniflare(config);
 try{const res=await mf.dispatchFetch('http://localhost/seed');assert.equal(res.status,200,await res.clone().text());const receipt=await res.json();await mf.dispose();mf=new Miniflare(config);const resumed=await mf.dispatchFetch('http://localhost/resume',{method:'POST',body:JSON.stringify(receipt)});assert.equal(resumed.status,200,await resumed.clone().text());assert.deepEqual(await resumed.json(),{persisted:true,retryStable:true,rollbackAtomic:true});}finally{await mf.dispose();await rm(persistence,{recursive:true,force:true});}
});
