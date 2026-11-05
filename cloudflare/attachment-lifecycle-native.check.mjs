import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {fileURLToPath} from 'node:url';
test('actual SQLite Worker cold attachment expiry, private deletion, rollback and old DML refusal',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./attachment-lifecycle-native.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const directory=await mkdtemp(join(tmpdir(),'attachment-lifecycle-'));
 const create=()=>new Miniflare({durableObjectsPersist:directory,modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'AttachmentLifecycleRoom',useSQLite:true}}});let mf=create();
 const call=async path=>{const r=await mf.dispatchFetch('http://local'+path),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
 try {
  await call('/prepare');await mf.dispose();mf=create();
  const expired=await call('/expire');assert.deepEqual(expired.rows,[{id:'expire',state:'expired',cleared:1},{id:'fault',state:'committed',cleared:0},{id:'private',state:'committed',cleared:0}]);
  const privacyBefore=await call('/privacy');assert.deepEqual(privacyBefore,{other:404,bob:200});
  const fault=await call('/fault');assert.equal(fault.failed,true);assert.equal(fault.before,fault.after);assert.equal(fault.state,'committed');assert.equal(fault.permit,0);
  const removed=await call('/delete');assert.equal(removed.status,'deleted');assert.equal(removed.duplicate,false);
  assert.deepEqual(await call('/privacy'),{other:404,bob:410});
  await mf.dispose();mf=create();assert.equal((await call('/delete')).duplicate,true);
  const old=await call('/old');assert.equal(old.errors.length,3);for(const error of old.errors)assert.match(error,/unsupported current room writer/);
  console.log('ATTACHMENT_LIFECYCLE_NATIVE '+JSON.stringify({expired,privacyBefore,fault,removed,old}));
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
