import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
test('Workers SQLite keeps normalized policy and trust changes after a cold restart',async()=>{
  const built=await build({entryPoints:[fileURLToPath(new URL('./normalized-policy-settings.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const dir=await mkdtemp(join(tmpdir(),'settings-worker-'));
  const create=()=>new Miniflare({durableObjectsPersist:dir,modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'SettingsRoom',useSQLite:true}}});
  let mf=create();
  const call=async path=>{const r=await mf.dispatchFetch('http://local'+path),body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
  try {
    await call('/seed');const result=await call('/change');
    assert.equal(result.denied.code,'command_rejected');assert.match(result.denied.message,/Only the Room owner/);assert.equal(result.before,result.after);
    await mf.dispose();mf=create();const saved=await call('/read');
    assert.equal(saved.policy.requireIndependentReview,true);assert.equal(saved.policy.requireOwnerDecision,true);assert.equal(saved.trust.enabled,false);
  } finally {await mf.dispose();await rm(dir,{recursive:true,force:true});}
});
