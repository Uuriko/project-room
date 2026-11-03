import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('existing-seat holder proof and OAuth survive a Workers cold reopen and revoke', { timeout: 60000 }, async () => {
 const built=await build({entryPoints:[fileURLToPath(new URL('./existing-seat-oauth.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const dir=await mkdtemp(join(tmpdir(),'existing-seat-worker-'));
 const create=()=>new Miniflare({modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'ExistingSeatRoom',useSQLite:true}}});
 let mf=create();const call=async path=>{const r=await mf.dispatchFetch('http://localhost'+path),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
 try {assert.deepEqual(await call('/seed'),{ok:true});assert.deepEqual(await call('/read'),{valid:true,sameMember:true});await mf.dispose();mf=create();assert.deepEqual(await call('/read'),{valid:true,sameMember:true});assert.deepEqual(await call('/revoke'),{valid:false,sameMember:false});}
 finally {await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
