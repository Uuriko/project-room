import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
const bundle=await build({entryPoints:[fileURLToPath(new URL('./restore-lazy-schema.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
for(const unknown of [false,true])test(`actual Workerd streamingrestore knownlazy schemas (unknown=${unknown})`,async t=>{
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'LazyRestoreProbe',useSQLite:true}}});t.after(()=>mf.dispose());
 const source=await mf.dispatchFetch(`http://localhost/seed?id=source&unknown=${unknown?1:0}`);assert.equal(source.status,200);
 const digest=source.headers.get('X-Fixture-Digest'),body=await source.text();
 const response=await mf.dispatchFetch('http://localhost/restore?id=target',{method:'POST',body});
 if(unknown){assert.equal(response.status,422);assert.equal((await response.json()).unknownRejected,true);}
 else{assert.equal(response.status,200);const result=await response.json();assert.equal(result.verified,true);assert.equal(result.contentVerification,'full');assert.equal(result.auditOk,true);assert.equal(result.digest,digest);}
});
