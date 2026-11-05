import test from 'node:test';import assert from 'node:assert/strict';
import {build} from 'esbuild';import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
test('Native normalized identity link rolls back holder-proof fault and survives cold restart without duplicates',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./current-identity-link.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});const dir=await mkdtemp(join(tmpdir(),'native-current-link-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'IdentityLinkRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
 try{await call('/seed');const linked=await call('/link');assert.equal(linked.faultRolledBack,true);assert.equal(linked.linked,true);assert.deepEqual(linked.permissions,['accept_work']);await mf.dispose();mf=create();const cold=await call('/cold');assert.equal(cold.sameIdentity,true);assert.equal(cold.duplicateRefused,true);assert.equal(cold.links,1);assert.equal(cold.sequence,linked.sequence);assert.deepEqual(cold.permissions,['accept_work']);console.log('NATIVE_CURRENT_LINK '+JSON.stringify({linked,cold}));}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
