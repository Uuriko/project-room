import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
test('actual Native attachment downloads preserve history and privacy before blob reads after cold restart',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./current-attachment-history.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});const dir=await mkdtemp(join(tmpdir(),'native-attachment-history-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'AttachmentHistoryRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const r=await mf.dispatchFetch('http://localhost'+path),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
 try{assert.deepEqual(await call('/file-seed'),{seeded:true});await mf.dispose();mf=create();assert.deepEqual(await call('/file-read'),{denied:['old-file','private-file','staged-file','unknown-file'],fresh:'VXNlZnVsIGJ5dGVz',owner:'VXNlZnVsIGJ5dGVz'});}finally{await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
