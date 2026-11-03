import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedScopedInbox} from './helpers/scoped-inbox-source.mjs';
import {Bridge} from '../room-acp/src/bridge.mjs';
import {RoomError} from '../room-acp/src/room.mjs';
async function fixture(t){
 const store=new RoomStore(':memory:'),seeded=seedScopedInbox(store),server=createRoomServer({store}),home=mkdtempSync(join(tmpdir(),'acp-park-context-'));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(home,{recursive:true,force:true});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const connection={apiBase:`http://127.0.0.1:${server.address().port}`,roomId:'commons',memberId:'worker',identityId:seeded.identityId,credential:seeded.token,hostId:'park-context-fixture'};
 let now=Date.now();store.now=()=>now;
 const post=(id,data)=>{now+=2001;return store.command(seeded.owner,'commons',{id,type:'message.posted',data:{messageId:id,body:'Useful context',...data}});};
 post('oversize-root',{body:'@Worker old conversation'});
 for(let i=0;i<30;i++)post('park-old-'+i,{replyToId:'oversize-root',body:'Historical context '+i});
 post('fresh-question',{body:'@Worker which API should I use for a selected request?'});
 post('fresh-fyi',{body:'@Worker FYI: the update is complete; no acknowledgement needed.'});
 const counts={prompts:[],posts:[],acks:[],full:0,requests:[]},logs=[];
 const make=async()=>{
  const bridge=new Bridge({connection,env:{ROOM_ACP_HOME:home},minPollIntervalMs:0,log:line=>logs.push(line),fetchImpl:async(url,options)=>{if(new URL(url).pathname.endsWith('/messages/oversize-root/thread')&&!new URL(url).search)counts.full++;const response=await fetch(url,options);counts.requests.push({path:new URL(url).pathname,selected:new URL(url).searchParams.get('view')==='message',status:response.status});return response;},host:{session:async()=>({sessionId:'synthetic',created:true}),prompt:async(key)=>{counts.prompts.push(key);return{recorder:{text:JSON.stringify(key==='fresh-fyi'?{outcome:'no_reply',body:''}:{outcome:'answered',body:'Use the selected request API and retain the original request ID.'}),tools:new Map(),plan:[]},stopReason:'end_turn'};}}});
  const send=bridge.room.post.bind(bridge.room),ack=bridge.room.ack.bind(bridge.room);
  bridge.room.post=async args=>{counts.posts.push(args);return send(args);};bridge.room.ack=async args=>{counts.acks.push(...args.signalIds);return ack(args);};
  await bridge.refreshRoom();await bridge.lease();return bridge;
 };
 const old=Array.from({length:12},(_,i)=>({signalId:'old-wake-'+i,kind:'mention',messageId:'park-old-'+i,author:'owner',body:'Historical context '+i}));
 const wake=id=>({signalId:id+'-wake',kind:'mention',messageId:id,author:'owner',body:id});
 return{store,seeded,home,make,counts,logs,old,wake};
}
const saved=(bridge,id)=>bridge.chatReceipts.read(bridge.chatReceipts.key(id));
test('real HTTP oversize ordinary batch parks all12wakes, and later question and FYI continue across restart',async t=>{
 const f=await fixture(t),first=await f.make();
 const selected=await first.room.thread('oversize-root',{selected:true});assert.equal(selected.thread.id,'oversize-root');
 await first.turn('oversize-root',f.old);
 const before=saved(first,'old-wake-0');assert.equal(before.phase,'queued');
 assert.equal(before.messageIds.length,12);assert.deepEqual(before.signalIds,f.old.map(row=>row.signalId));
 assert.deepEqual(f.counts.prompts,[]);assert.deepEqual(f.counts.acks,[]);
 const second=await f.make();await second.turn('oversize-root',[...f.old].reverse());
 const cursors=[];second.room.poll=async({cursor})=>{cursors.push(cursor);return cursor===null?{pendingWakes:[f.old[0],f.wake('fresh-question')],more:true,nextCursor:'next-source-page'}:{pendingWakes:[f.wake('fresh-fyi')],more:false};};
 await second.pollOnce();await second.queue.idle();
 assert.equal(f.counts.posts.length,1,'an independent later question must not be blocked by the old oversized thread');
 assert.deepEqual([...f.counts.prompts].sort(),['fresh-fyi','fresh-question']);
 assert.deepEqual(cursors,[null,'next-source-page']);
 assert.equal(f.counts.full,1,'persisted blocked batch must not refetch the full thread');
 assert.deepEqual(saved(second,'old-wake-0'),before);
 assert.equal(before.contextBlocked.code,'current_thread_too_large');
 assert.equal(before.contextBlocked.selectedRead.path,'/api/rooms/commons/messages/oversize-root/thread?view=message');
 assert.equal(first.controller.signal.aborted,false);
 assert.equal(f.counts.posts[0].body,'Use the selected request API and retain the original request ID.');
 assert.equal(saved(second,'fresh-question-wake').phase,'posted');assert.equal(saved(second,'fresh-fyi-wake').disposition,'silent');
 assert.deepEqual([...f.counts.acks].sort(),['fresh-fyi-wake','fresh-question-wake']);
 assert.equal(second.controller.signal.aborted,false);assert.match(f.logs.join('\n'),/oversize-root.*unacknowledged/);
});
for(const [status,code,stopped] of [[413,'other_limit',false],[503,'service_unavailable',false],[409,'selected_message_context_unavailable',true]])
test(`unrelated ordinary failure ${status}/${code} is not downgraded to parked context`,async t=>{
 const f=await fixture(t),bridge=await f.make(),read=bridge.room.thread.bind(bridge.room);
 bridge.room.thread=async(id,options)=>{if(id==='fresh-question'&&!options?.selected)throw new RoomError(status,code,'synthetic');return read(id,options);};
 await bridge.turn('fresh-question',[f.wake('fresh-question')]);const receipt=saved(bridge,'fresh-question-wake');
 assert.equal(receipt.phase,'queued');assert.equal(receipt.contextBlocked,undefined);assert.equal(f.counts.prompts.length,0);assert.equal(f.counts.acks.length,0);assert.equal(bridge.controller.signal.aborted,stopped);
});
test('incomplete formal context still stops unacknowledged and is never marked parked or answered',async t=>{
 const f=await fixture(t),bridge=await f.make();bridge.room.requestContext=async()=>{throw new RoomError(413,'formal_context_too_large','synthetic');};
 await bridge.turn('dm',[{signalId:'formal-wake',messageId:'dm',author:'owner',body:'Please answer'}]);
 assert.equal(saved(bridge,'formal-wake').contextBlocked,undefined);assert.equal(bridge.stopReason,'context_unavailable');
 assert.equal(f.counts.prompts.length,0);assert.equal(f.counts.acks.length,0);assert.equal(f.counts.posts.length,0);
});
test('failed parking save keeps the original batch queued without model execution or ACK',async t=>{
 const f=await fixture(t),bridge=await f.make(),save=bridge.chatReceipts.save.bind(bridge.chatReceipts);
 bridge.chatReceipts.save=(key,value)=>{if(value.contextBlocked)throw Error('Injected parking save fault');return save(key,value);};
 await bridge.turn('oversize-root',f.old);assert.equal(saved(bridge,'old-wake-0').phase,'queued');assert.equal(saved(bridge,'old-wake-0').contextBlocked,undefined);
 assert.equal(f.counts.prompts.length,0);assert.equal(f.counts.acks.length,0);
});

test('mismatched parked receipt binding fails closed without loading, prompting or ACK',async t=>{
 const f=await fixture(t),bridge=await f.make();await bridge.turn('oversize-root',f.old);
 const key=bridge.chatReceipts.key('old-wake-0'),receipt=bridge.chatReceipts.read(key);
 bridge.chatReceipts.save(key,{...receipt,contextBlocked:{...receipt.contextBlocked,requestId:'different-operation'}});
 await assert.rejects(bridge.deliverChatReceipt(key),/Invalid blocked context receipt/);
 assert.equal(f.counts.full,1);assert.equal(f.counts.prompts.length,0);assert.equal(f.counts.acks.length,0);
});

test('ten fresh same-root batches reuse one durable parked-thread fact after restart with measured HTTP counts',async t=>{
 const f=await fixture(t);let bridge=await f.make();const measurements=[];
 for(let i=0;i<10;i++){
  if(i===5)bridge=await f.make();const start=f.counts.requests.length;
  await bridge.turn('oversize-root',[{...f.old[0],signalId:'series-'+i}]);
  measurements.push(f.counts.requests.length-start);await delay(150);
 }
 t.diagnostic('PARKED_THREAD_HTTP '+JSON.stringify({batches:10,perBatch:measurements,total:measurements.reduce((a,b)=>a+b,0),full:f.counts.full,statuses:f.counts.requests.reduce((counts,row)=>({...counts,[row.status]:(counts[row.status]??0)+1}),{})}));
 assert.equal(f.counts.full,1);assert.equal(f.counts.prompts.length,0);assert.equal(f.counts.acks.length,0);
 for(let i=0;i<10;i++)assert.equal(saved(bridge,'series-'+i).contextBlocked.code,'current_thread_too_large');
});
test('fresh source-author authorization is still required when a parked-thread fact exists',async t=>{
 const f=await fixture(t),bridge=await f.make();await bridge.turn('oversize-root',f.old);
 f.store.agentPlugin.revokeApiKey({identityId:f.seeded.identityId,keyId:f.seeded.keyId});
 await bridge.turn('oversize-root',[{...f.old[0],signalId:'revoked-fact'}]);
 assert.equal(saved(bridge,'revoked-fact').contextBlocked,undefined);assert.equal(f.counts.full,1);assert.equal(f.counts.prompts.length,0);assert.equal(f.counts.acks.length,0);
});
test('changed protected root invalidates the parked-thread fingerprint before reuse',async t=>{
 const f=await fixture(t),bridge=await f.make();await bridge.turn('oversize-root',f.old);
 f.store.command(f.seeded.owner,'commons',{id:'root-edited',type:'message.edited',data:{messageId:'oversize-root',body:'Changed root context',expectedMessageRevision:0}});
 await bridge.turn('oversize-root',[{...f.old[0],signalId:'changed-root'}]);assert.equal(f.counts.full,2);assert.equal(f.counts.prompts.length,0);assert.equal(f.counts.acks.length,0);
});
test('even a matching local fact cannot turn a current formal request into ordinary parked context',async t=>{
 const f=await fixture(t),bridge=await f.make();await bridge.turn('oversize-root',f.old);
 const selected=await bridge.room.thread('dm',{selected:true});
 if(bridge.parkedThreads){const fact=bridge.parkedThreads.read(bridge.parkedThreads.key('oversize-root'));
 bridge.parkedThreads.save(bridge.parkedThreads.key('dm'),{...fact,threadKey:'dm',rootHash:createHash('sha256').update(JSON.stringify(selected.thread)).digest('hex'),selectedRead:{method:'GET',path:'/api/rooms/commons/messages/dm/thread?view=message'}});}
 await bridge.turn('dm',[{signalId:'formal-after-fact',messageId:'dm',author:'owner',body:'Please answer'}]);
 assert.equal((await bridge.room.request('/api/rooms/commons/reply-context?requestMessageId=dm')).request.status,'answered');
 assert.equal(saved(bridge,'formal-after-fact').contextBlocked,undefined);assert.deepEqual(f.counts.prompts,['dm']);
});

test('wrong-member parked-thread fact is rejected after fresh authority without full read or ACK',async t=>{
 const f=await fixture(t),bridge=await f.make();await bridge.turn('oversize-root',f.old);
 const key=bridge.parkedThreads.key('oversize-root'),fact=bridge.parkedThreads.read(key);
 bridge.parkedThreads.save(key,{...fact,memberId:'another-member'});
 await bridge.turn('oversize-root',[{...f.old[0],signalId:'wrong-member-fact'}]);
 assert.equal(saved(bridge,'wrong-member-fact').contextBlocked,undefined);assert.equal(f.counts.full,1);assert.equal(f.counts.prompts.length,0);assert.equal(f.counts.acks.length,0);
 assert.match(f.logs.join('\n'),/Invalid parked thread fact/);
});
