import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedScopedInbox} from './helpers/scoped-inbox-source.mjs';
import {Bridge} from '../room-acp/src/bridge.mjs';
import {ServiceError} from '../server/service-error.mjs';
import {CurrentReadBudgetExceeded,chargeCurrentReadBudget,withCurrentRoomWriter} from '../server/current-room-repository.mjs';
async function fixture(t) {
 const store=new RoomStore(':memory:'), seeded=seedScopedInbox(store), server=createRoomServer({store}),home=mkdtempSync(join(tmpdir(),'thread-quota-'));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(home,{recursive:true,force:true});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let clock=Date.now();store.now=()=>clock;
 const post=(id,data={})=>{clock+=2001;return store.command(seeded.owner,'commons',{id,type:'message.posted',data:{messageId:id,body:'Context',...data}});};
 post('quota-root');for(let i=0;i<24;i++)post('quota-child-'+i,{replyToId:'quota-root',body:'x'.repeat(8192)});
 post('new-question',{body:'@Worker which selected API should I use?'});
 const connection={apiBase:`http://127.0.0.1:${server.address().port}`,roomId:'commons',memberId:'worker',identityId:seeded.identityId,credential:seeded.token,hostId:'quota-fixture'};
 const read=async(id,selected=false)=>{const r=await fetch(`${connection.apiBase}/api/rooms/commons/messages/${id}/thread${selected?'?view=message':''}`,{headers:{authorization:`Bearer ${seeded.token}`}});return{status:r.status,value:await r.json()};};
 return {store,seeded,connection,home,read};
}
test('aggregate quota is a typed thread413; existing ACP parks only that thread and answers a later question',async t=>{
 const f=await fixture(t);assert.equal((await f.read('quota-root',true)).status,200);
 const full=await f.read('quota-root');t.diagnostic(JSON.stringify(full));assert.equal(full.status,413);assert.equal(full.value.error.code,'current_thread_too_large');
 const prompts=[],acks=[];const bridge=new Bridge({connection:f.connection,env:{ROOM_ACP_HOME:f.home},host:{session:async()=>({sessionId:'test',created:true}),prompt:async key=>{prompts.push(key);return{recorder:{text:'Use the selected request API.',tools:new Map(),plan:[]},stopReason:'end_turn'};}}});
 await bridge.refreshRoom();await bridge.lease();const ack=bridge.room.ack.bind(bridge.room);bridge.room.ack=async args=>{acks.push(...args.signalIds);return ack(args);};
 const wake=id=>[{signalId:'wake-'+id,messageId:id,author:'owner',body:'Context'}];
 await bridge.turn('quota-root',wake('quota-root'));await bridge.turn('new-question',wake('new-question'));
 assert.deepEqual(prompts,['new-question']);assert.deepEqual(acks,['wake-new-question']);
 const blocked=bridge.chatReceipts.read(bridge.chatReceipts.key('wake-quota-root'));assert.equal(blocked.phase,'queued');assert.equal(blocked.contextBlocked.code,'current_thread_too_large');
 assert.equal(bridge.controller.signal.aborted,false);
});
test('nonparty DM is404 and integrity failures are never translated into a context413',async t=>{
 const f=await fixture(t);assert.equal((await f.read('hidden')).status,404);
 f.store.transaction(()=>withCurrentRoomWriter(f.store.db,'commons',()=>f.store.db.prepare("UPDATE messages SET body='invalid' WHERE room_id='commons' AND message_id='new-question'").run()));
 const bad=await f.read('new-question');assert.equal(bad.status,500);assert.notEqual(bad.value.error?.code,'current_thread_too_large');
});

test('a generic409 with identical public code and message is not a typed aggregate quota',async t=>{
 const f=await fixture(t),prepare=f.store.db.prepare.bind(f.store.db);
 f.store.db.prepare=sql=>{if(sql.includes('INDEXED BY current_messages_thread_public_seq'))throw new ServiceError(409,'current_room_context_unavailable','Current record context exceeds bounded input; use a smaller addressed request');return prepare(sql);};
 t.after(()=>{f.store.db.prepare=prepare;});
 const refusal=await f.read('new-question');assert.equal(refusal.status,409);assert.equal(refusal.value.error.code,'current_room_context_unavailable');
});

test('aggregate helper retains original public409 and exact200record/256KiB limits',()=>{
 for(const b of [{bytes:0,records:200},{bytes:256*1024,records:0}]){
  assert.throws(()=>chargeCurrentReadBudget(b,1),error=>error instanceof CurrentReadBudgetExceeded&&error.status===409&&error.code==='current_room_context_unavailable'&&error.message==='Current record context exceeds bounded input; use a smaller addressed request');
 }
 const b={bytes:0,records:0};chargeCurrentReadBudget(b,256*1024,200);assert.equal(b.bytes,256*1024);assert.equal(b.records,200);
});
