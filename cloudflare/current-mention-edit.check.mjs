import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
test('actual Native normalized edit preserves mention delivery through fault and cold retry',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./current-mention-edit.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});const dir=await mkdtemp(join(tmpdir(),'native-mention-edit-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'MentionEditRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const r=await mf.dispatchFetch('http://localhost'+path),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
 try{await call('/seed');await call('/link');assert.deepEqual(await call('/edit'),{rollback:true,duplicate:false,body:'Latest body without handle'});await mf.dispose();mf=create();assert.deepEqual(await call('/edit-cold'),{duplicate:true,body:'Latest body without handle',revision:1,mentions:[{id:'native-mentioned',body:'Latest body without handle'}]});}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
