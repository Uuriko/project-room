import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('Workers SQLite carries certification and preserves normalized history across bounded writes',async()=>{
 const bundled=await build({entryPoints:[fileURLToPath(new URL('./message-continuity.test-fixture.mjs',import.meta.url))],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const mf=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'MessageContinuityTestRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:'https://room.example.test'}});
 try{const response=await mf.dispatchFetch('https://room.example.test/__test-message-continuity',{headers:{Host:'room.example.test','CF-Connecting-IP':'192.0.2.1'}});assert.equal(response.status,200,await response.clone().text());const r=await response.json();assert.equal(r.head,r.certified);assert.ok(r.tail<=9);assert.equal(r.body,'Corrected.');assert.equal(r.parity,true);}finally{await mf.dispose();}
});
