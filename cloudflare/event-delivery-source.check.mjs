import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
test('actual Worker retains event-only transport source after restart without widening private message access',async()=>{
 const built=await build({entryPoints:[fileURLToPath(new URL('./event-delivery-source.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const directory=await mkdtemp(join(tmpdir(),'message-source-worker-'));
 const create=()=>new Miniflare({durableObjectsPersist:directory,modules:true,script:built.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'EventSourceRoom',useSQLite:true}}});
 let mf=create();const call=async path=>{const response=await mf.dispatchFetch('http://localhost'+path);assert.equal(response.status,200);return response.json();};
 try{
  const seeded=await call('/seed');assert.equal(seeded.source,'v1:api');assert.ok(seeded.cost.rowsWritten>0);console.log(JSON.stringify({eventOnlyWriteCost:seeded.cost}));
  for(let n=0;n<2;n++){
   const result=await call('/read');assert.equal(result.source,'v1:api');assert.equal(result.projectedHasSource,false);assert.ok([403,404].includes(result.privateReadStatus));assert.equal(JSON.stringify(result.privateRead).includes('Private source fixture'),false);assert.equal(JSON.stringify(result.privateRead).includes('deliverySource'),false);
   if(n===0){await mf.dispose();mf=create();}
  }
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
});
