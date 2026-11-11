import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
test('Workers canonical authority survives cold reopen, corruption rollback and reverse',async()=>{
 const bundle=await build({entryPoints:[fileURLToPath(new URL('./message-authority.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'MessageAuthorityTestRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test'}});
 try{const response=await mf.dispatchFetch('https://room.example.test/');assert.equal(response.status,200,await response.clone().text());
 assert.deepEqual(await response.json(),{hasArray:false,count:2,bodies:['Body first','Bounded Worker edit'],refused:true,preserved:2,payloadHashChanged:true,payloadDrift:true,reverse:2});}finally{await mf.dispose();}
});
