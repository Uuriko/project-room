// Regression derived from the friend's actual listener-noise report. The live
// model chunk provenance was not captured; these controls use synthetic ACP.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedScopedInbox} from './helpers/scoped-inbox-source.mjs';
import {Bridge} from '../room-acp/src/bridge.mjs';
async function fixture(t,{failure=false,formal=false,stopReason='end_turn',text='',tools=new Map(),plan=[]}={}){
 const store=new RoomStore(':memory:'),seeded=seedScopedInbox(store),server=createRoomServer({store}),home=mkdtempSync(join(tmpdir(),'acp-empty-'));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(home,{recursive:true,force:true});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const connection={apiBase:`http://127.0.0.1:${server.address().port}`,roomId:'commons',memberId:'worker',identityId:seeded.identityId,credential:seeded.token,hostId:'empty-response-fixture'},counts={prompts:0,posts:0,acks:0};
 const make=async()=>{
  const bridge=new Bridge({connection,env:{ROOM_ACP_HOME:home},host:{session:async()=>({sessionId:'synthetic',created:true}),prompt:async()=>{counts.prompts++;if(failure)throw Error('synthetic adapter failure');return{recorder:{text,tools,plan},stopReason};}}});
  const post=bridge.room.post.bind(bridge.room),ack=bridge.room.ack.bind(bridge.room);
  bridge.room.post=async args=>{counts.posts++;return post(args);};bridge.room.ack=async args=>{counts.acks++;return ack(args);};
  await bridge.refreshRoom();await bridge.lease();return bridge;
 };
 const thread=formal?'dm':'mention',wake={signalId:'synthetic-empty-wake',messageId:thread,author:'owner',body:'Update complete; no acknowledgement needed'};
 return{store,make,counts,thread,wake};
}
test('successful empty ordinary turn is silent and durable across restart',async t=>{
 const f=await fixture(t),bridge=await f.make(),head=f.store.headSequence('commons');await bridge.turn(f.thread,[f.wake]);assert.equal(f.counts.posts,0);assert.equal(f.store.headSequence('commons'),head);const saved=bridge.chatReceipts.read(bridge.chatReceipts.key(f.wake.signalId));assert.equal(saved.phase,'discarded');assert.equal(saved.disposition,'silent');assert.equal(Object.hasOwn(saved,'body'),false);await(await f.make()).turn(f.thread,[f.wake]);assert.equal(f.counts.prompts,1);assert.equal(f.counts.posts,0);assert.equal(f.counts.acks,2);
});
test('silent outcome is persisted before lost ACK and replay never prompts or posts',async t=>{
 const f=await fixture(t),first=await f.make(),ack=first.room.ack.bind(first.room);let pending;first.room.ack=async args=>{pending=first.chatReceipts.read(first.chatReceipts.key(f.wake.signalId));await ack(args);throw Error('synthetic lost acknowledgement');};await first.turn(f.thread,[f.wake]);assert.equal(pending.disposition,'silent');const requestId=pending.requestId;await(await f.make()).turn(f.thread,[f.wake]);assert.equal(f.counts.prompts,1);assert.equal(f.counts.posts,0);assert.equal(f.counts.acks,2);assert.equal(first.chatReceipts.read(first.chatReceipts.key(f.wake.signalId)).requestId,requestId);
});
test('adapter failure remains visible',async t=>{const f=await fixture(t,{failure:true}),bridge=await f.make();await bridge.turn(f.thread,[f.wake]);assert.equal(f.counts.posts,1);assert.equal(f.counts.prompts,1);const receipt=bridge.chatReceipts.read(bridge.chatReceipts.key(f.wake.signalId));assert.equal(receipt.phase,'posted');assert.notEqual(receipt.disposition,'silent');});
test('empty formal response keeps request open and posts its pending diagnostic',async t=>{const f=await fixture(t,{formal:true}),bridge=await f.make();await bridge.turn(f.thread,[f.wake]);const current=await bridge.room.request('/api/rooms/commons/reply-context?requestMessageId=dm');assert.equal(current.request.status,'open');assert.equal(f.counts.posts,1);assert.equal(f.counts.prompts,1);});
for(const stopReason of ['cancelled','max_tokens','refusal'])test('empty '+stopReason+' remains visible',async t=>{const f=await fixture(t,{stopReason}),bridge=await f.make();await bridge.turn(f.thread,[f.wake]);assert.equal(f.counts.posts,1);});
test('tool-only successful response remains visible',async t=>{const f=await fixture(t,{tools:new Map([['tool',{title:'Inspected source',status:'completed'}]])}),bridge=await f.make();await bridge.turn(f.thread,[f.wake]);assert.equal(f.counts.posts,1);});
test('nonempty ordinary response remains visible',async t=>{const f=await fixture(t,{text:'Useful result'}),bridge=await f.make();await bridge.turn(f.thread,[f.wake]);assert.equal(f.counts.posts,1);});
test('uncertain interrupted empty turn remains started, unacknowledged and never reruns',async t=>{const f=await fixture(t),bridge=await f.make();bridge.host.prompt=async()=>{f.counts.prompts++;bridge.stop();throw Error('interrupted after side effect');};await bridge.turn(f.thread,[f.wake]);assert.equal(bridge.chatReceipts.read(bridge.chatReceipts.key(f.wake.signalId)).phase,'started');await(await f.make()).turn(f.thread,[f.wake]);assert.equal(f.counts.prompts,1);assert.equal(f.counts.posts,0);assert.equal(f.counts.acks,0);});
test('plan-only output is not classified as silent',async t=>{const f=await fixture(t,{plan:[{content:'Inspect results',status:'completed'}]}),bridge=await f.make();await bridge.turn(f.thread,[f.wake]);assert.equal(f.counts.posts,1);});
test('empty claim turn retains its existing result note behavior',async()=>{
 let notes=0,prompts=0;const bridge=new Bridge({connection:{apiBase:'http://localhost',roomId:'claims',memberId:'agent',hostId:'h'},env:{},persistSessions:false,host:{session:async()=>({sessionId:'s'}),prompt:async()=>{prompts++;return{recorder:{text:'',tools:new Map(),plan:[]},stopReason:'end_turn'};}}});bridge.fencingToken='synthetic-lease';bridge.room.checkListener=async()=>({listener:{valid:true}});bridge.room.room=async()=>({state:{room:{ownerId:'owner'},members:{owner:{id:'owner',kind:'human',active:true},agent:{id:'agent',kind:'agent',active:true}}}});bridge.room.claim=async()=>({id:'work',owner:'agent',state:'claimed',history:[{action:'created',agentId:'owner'}]});bridge.room.claimNote=async(_id,body)=>{assert.equal(body,'(no reply text)');notes++;};bridge.room.ack=async()=>{};await bridge.refreshRoom();await bridge.accept({signalId:'claim-empty',workClaim:'work',reason:'assigned'});await bridge.queue.idle();assert.equal(prompts,1);assert.equal(notes,1);
});

test('failed silent receipt save retains uncertain execution and never acknowledges',async t=>{const f=await fixture(t),bridge=await f.make(),save=bridge.chatReceipts.save.bind(bridge.chatReceipts);bridge.chatReceipts.save=(key,receipt)=>{if(receipt.disposition==='silent')throw Error('synthetic disposition save fault');return save(key,receipt);};await bridge.turn(f.thread,[f.wake]);assert.equal(bridge.chatReceipts.read(bridge.chatReceipts.key(f.wake.signalId)).phase,'started');await(await f.make()).turn(f.thread,[f.wake]);assert.equal(f.counts.prompts,1);assert.equal(f.counts.posts,0);assert.equal(f.counts.acks,0);});
