import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

// Authoring gate: Worker SQLite triggers, indexed record parity and persisted
// restart/flag rollback are a separate runtime contract from Node owner tests.
// Credible regression: missing body hydration or incompatible JSON/trigger SQL.
// Real Miniflare/workerd owns persistence; no new production test seam/double.
for(const enabled of [false,true]) test(`Worker projection bodies ${enabled?'ON':'OFF'} preserve indexed text across restart and flag rollback`,async()=>{
  const bundled=await build({entryPoints:[fileURLToPath(new URL('./projection-at-rest.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const persistence=await mkdtemp(join(tmpdir(),'room-projection-body-worker-'));
  const config={modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],bindings:{ROOM_BODIES_AT_REST:enabled?'1':'0'},durableObjects:{ROOM:{className:'ProjectionBodyRoom',useSQLite:true}},durableObjectsPersist:persistence};
  let mf=new Miniflare(config);
  try {
    const seeded=await mf.dispatchFetch('http://localhost/seed');
    assert.equal(seeded.status,200,await seeded.clone().text());
    const receipt=await seeded.json(); // Synthetic credential remains test-local.
    await mf.dispose();mf=new Miniflare(config);
    const resumed=await mf.dispatchFetch('http://localhost/resume',{method:'POST',body:JSON.stringify(receipt)});
    assert.equal(resumed.status,200,await resumed.clone().text());
    assert.deepEqual(await resumed.json(),{resumed:true,indexed:true,bodyRows:enabled?1:0});
    await mf.dispose();mf=new Miniflare({...config,bindings:{ROOM_BODIES_AT_REST:'0'}});
    const disabled=await mf.dispatchFetch('http://localhost/disable',{method:'POST',body:JSON.stringify(receipt)});
    assert.equal(disabled.status,200,await disabled.clone().text());
    assert.deepEqual(await disabled.json(),{disabled:true,fullProjection:true});
  } finally {await mf.dispose();await rm(persistence,{recursive:true,force:true});}
});
