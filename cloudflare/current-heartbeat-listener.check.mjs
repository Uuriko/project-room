import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
test('actual Native normalized room listener acquires and renews its fenced lease after cold restart',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./current-heartbeat-listener.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});const dir=await mkdtemp(join(tmpdir(),'native-heartbeat-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'HeartbeatRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const r=await mf.dispatchFetch('http://localhost'+path),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
 try{await call('/seed');await call('/link');assert.equal((await call('/lease')).acquired,true);await mf.dispose();mf=create();assert.deepEqual(await call('/lease-cold'),{valid:true,renewed:true,sameToken:true});}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
