import test from 'node:test';import assert from 'node:assert/strict';
import {build} from 'esbuild';import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Bridge} from '../room-acp/src/bridge.mjs';

test('Worker cold reopen starts and formally answers without loading a large room snapshot',{timeout:60000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'authority-worker-'));
 const script=(await build({entryPoints:[new URL('./acp-formal-delivery.test-fixture.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
 const create=()=>new Miniflare({script,modules:true,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:directory,durableObjects:{ROOM:{className:'FormalDeliveryRoom',useSQLite:true}}});
 let mf=create();t.after(async()=>{await mf.dispose();await rm(directory,{recursive:true,force:true});});
 const keys=await(await mf.dispatchFetch('http://localhost/__seed?large=1')).json();
 await mf.dispose();mf=create();
 const reads=[];let prompts=0;
 const bridge=new Bridge({connection:{...keys,apiBase:'http://localhost',roomId:'commons',memberId:'worker',hostId:'authority-worker'},persistSessions:false,
  host:{session:async()=>({sessionId:'s'}),prompt:async()=>{prompts++;return {recorder:{text:JSON.stringify({outcome:'answered',body:'Authority read survived large history'}),tools:new Map()},stopReason:'end_turn'};}},
  fetchImpl:async(url,options)=>{const response=await mf.dispatchFetch(url,options);if(new URL(url).searchParams.get('view')==='authority')reads.push({url,bytes:Buffer.byteLength(await response.clone().text())});return response;},log:()=>{}});
 await assert.rejects(bridge.room.room(),error=>error.status===409&&error.code==='current_room_context_unavailable');
 await bridge.refreshRoom();await bridge.lease();await bridge.turn('dm',[{signalId:'authority-worker-wake',messageId:'dm',author:'owner',body:'Please answer'}]);
 assert.equal(prompts,1);assert.equal((await bridge.room.requestContext('dm')).request.status,'answered');
 assert.equal(bridge.chatReceipts.read(bridge.chatReceipts.key('authority-worker-wake')).phase,'posted');
 assert.ok(reads.length>0);assert.ok(reads.every(read=>read.bytes<4096));
 await mf.dispose();mf=create();await bridge.refreshRoom();
 assert.equal(bridge.me.id,'worker');assert.equal((await bridge.room.requestContext('dm')).request.status,'answered');
});
