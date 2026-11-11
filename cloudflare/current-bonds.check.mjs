import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
test('actual Native bond consent, peer DM atomicity and cold exact retry preserve independent oracle',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./current-bonds.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});const dir=await mkdtemp(join(tmpdir(),'native-bonds-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'NativeBondsRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const r=await mf.dispatchFetch('http://localhost'+path),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
 try{assert.deepEqual(await call('/bond-seed'),{seeded:true});assert.deepEqual(await call('/bond-flow'),{priorFields:true,rolledBack:true,inbox:true});await mf.dispose();mf=create();assert.deepEqual(await call('/bond-cold'),{exactRetry:true,private:true,revoked:true,oracle:true,messages:1,closed:true});}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
