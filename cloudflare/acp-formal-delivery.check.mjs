import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Bridge} from '../room-acp/src/bridge.mjs';

test('formal bridge delivery survives Worker SQLite reopen and a lost committed response without hydration', {timeout:60000}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'formal-worker-')), state=await mkdtemp(join(tmpdir(),'formal-host-'));
  const script=(await build({entryPoints:[new URL('./acp-formal-delivery.test-fixture.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']})).outputFiles[0].text;
  const create=()=>new Miniflare({script,modules:true,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjectsPersist:dir,durableObjects:{ROOM:{className:'FormalDeliveryRoom',useSQLite:true}}});
  let mf=create();t.after(async()=>{await mf.dispose();await rm(dir,{recursive:true,force:true});await rm(state,{recursive:true,force:true});});
  const keys=await(await mf.dispatchFetch('http://localhost/__seed')).json();
  await mf.dispose();mf=create();
  let prompts=0, lose=true;const sent=[];
  const connection={...keys,apiBase:'http://localhost',roomId:'commons',memberId:'worker',hostId:'formal-worker-host'};
  const make=()=>new Bridge({connection,env:{ROOM_ACP_HOME:state},host:{session:async()=>({sessionId:'s',created:true}),prompt:async()=>{
    prompts++;return {recorder:{text:JSON.stringify({outcome:'answered',body:'Worker verified answer'}),tools:new Map()},stopReason:'end_turn'};
  }},fetchImpl:async(url,options)=>{
    const response=await mf.dispatchFetch(url,options);
    if(options?.body&&JSON.parse(options.body).data?.responseToRequestId){sent.push(options.body);if(lose){lose=false;await response.clone().json();throw Error('response lost after commit');}}
    return response;
  }});
  const wake={signalId:'formal-worker-signal',messageId:'dm',author:'owner',body:'Please answer'};
  const first=make();await first.refreshRoom();await first.lease();
  await first.turn('dm',[wake]);
  const read=bridge=>bridge.room.requestContext('dm');
  assert.equal((await read(first)).request.status,'answered');
  const sequence=(await(await mf.dispatchFetch('http://localhost/__sequence')).json()).sequence;
  await mf.dispose();mf=create();
  const second=make();await second.refreshRoom();await second.lease();await second.turn('dm',[wake]);
  const current=await read(second);assert.equal(current.request.status,'answered');
  assert.equal(current.page.items.find(item=>item.kind==='answered').message.body,'Worker verified answer');
  assert.equal(prompts,1);assert.equal(sent.length,2);assert.equal(new Set(sent).size,1);
  assert.equal((await(await mf.dispatchFetch('http://localhost/__sequence')).json()).sequence,sequence);
  assert.equal(second.chatReceipts.read(second.chatReceipts.key(wake.signalId)).phase,'posted');
});
