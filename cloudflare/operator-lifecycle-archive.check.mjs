import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
test('actual Native operator lifecycle archive rollback and cold receipt preserve both room grants',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./operator-lifecycle-archive.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});const dir=await mkdtemp(join(tmpdir(),'native-archived-claims-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'OperatorLifecycleRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const r=await mf.dispatchFetch('http://localhost'+path),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));assert.deepEqual(body,{duplicate:true,rooms:2,archived:true,preservedAccess:true});};
 try{await call('/seed');await mf.dispose();mf=create();await call('/cold');}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
