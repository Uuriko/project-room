import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {performance} from 'node:perf_hooks';
import {RoomStore} from '../server/store.mjs';import {createRoomServer} from '../server/http.mjs';import {operatorWakeIndex} from '../server/operator-wake-index.mjs';
import {seedScopedInbox} from './helpers/scoped-inbox-source.mjs';import {Bridge} from '../room-acp/src/bridge.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
test('actual HTTP discovers a fresh ordinary question beyond500old wakes and runs it beside three held historical turns',{timeout:30000},async t=>{
 const store=new RoomStore(':memory:'),seed=seedScopedInbox(store),server=createRoomServer({store}),home=mkdtempSync(join(tmpdir(),'fresh-http-'));
 const release=[],prompts=[],acks=[],requests=[];let bridge,draining=false;
 t.after(async()=>{draining=true;for(const done of release)done();if(bridge)await bridge.queue.idle();server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(home,{recursive:true,force:true});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let clock=Date.now();store.now=()=>clock;
 const wakes=[];for(let i=0;i<500;i++){
  clock+=2001;const id='old-root-'+i;store.command(seed.owner,'commons',{id,type:'message.posted',data:{messageId:id,body:'Historical context '+i}});
  wakes.push(store.agentHeartbeats.enqueueWake({agentId:seed.identityId,roomId:'commons',messageId:id,kind:'mention'}).signal);
 }
 const reason='Synthetic fresh discovery',plan=operatorWakeIndex(store,{reason});operatorWakeIndex(store,{reason,planHash:plan.planHash,requestId:'fresh-install'},true);
 const connection={apiBase:`http://127.0.0.1:${server.address().port}`,roomId:'commons',memberId:'worker',identityId:seed.identityId,credential:seed.token,hostId:'fresh-http'};
 bridge=new Bridge({connection,env:{ROOM_ACP_HOME:home},maxSessions:4,minPollIntervalMs:0,fetchImpl:async(url,options)=>{requests.push({path:new URL(url).pathname,order:new URL(url).searchParams.get('order')});return fetch(url,options);},host:{session:async()=>({sessionId:'synthetic',created:true}),prompt:async key=>{prompts.push(key);if(key.startsWith('old-')&&!draining)await new Promise(r=>release.push(r));return{recorder:{text:JSON.stringify(key==='fresh-question'?{outcome:'answered',body:'Use the selected request API with its original request ID.'}:{outcome:'no_reply',body:''}),tools:new Map(),plan:[]},stopReason:'end_turn'};}}});
 const ack=bridge.room.ack.bind(bridge.room);bridge.room.ack=async args=>{acks.push(...args.signalIds);return ack(args);};
 await bridge.refreshRoom();await bridge.lease();assert.equal(bridge.freshWakeDiscovery,true);assert.equal(bridge.queue.reservedPriority,1);
 for(let i=0;i<3;i++)await bridge.accept(wakes[i]);
 for(let i=0;i<1000&&prompts.length<3;i++)await tick();assert.equal(prompts.length,3);
 clock+=2001;store.command(seed.owner,'commons',{id:'fresh-question',type:'message.posted',data:{messageId:'fresh-question',body:'Which selected API should I use?'}});
 const fresh=store.agentHeartbeats.enqueueWake({agentId:seed.identityId,roomId:'commons',messageId:'fresh-question',kind:'mention'}).signal;
 const arrival=performance.now(),before=requests.length;await bridge.discoverRecent();const discovered=performance.now();
 for(let i=0;i<1000&&!acks.includes(fresh.signalId);i++)await tick();
 assert.deepEqual(prompts,['old-root-0','old-root-1','old-root-2','fresh-question']);assert.deepEqual(acks,[fresh.signalId]);
 assert.equal(bridge.wakeCursor,null,'recent discovery never changes oldest progress');
 assert.equal(store.db.prepare('SELECT count(*) n FROM agent_wake_signals WHERE delivered_at IS NULL').get().n>=500,true);
 const receipt=bridge.chatReceipts.read(bridge.chatReceipts.key(fresh.signalId));assert.equal(receipt.phase,'posted');
 t.diagnostic(JSON.stringify({historicalWakes:500,arrivalToDiscoveryMs:discovered-arrival,discoveryToDeliveryObservationMs:performance.now()-discovered,requestsFromDiscovery:requests.length-before,reservedOldTurnsStillActive:release.length}));
 // Exact repeated discovery and cold receipt replay must not run or post twice.
 await bridge.deliverChatReceipt(bridge.chatReceipts.key(fresh.signalId));assert.equal(prompts.filter(x=>x==='fresh-question').length,1);
 const second=new Bridge({connection,env:{ROOM_ACP_HOME:home},host:{},persistSessions:true});
 second.fencingToken=bridge.fencingToken;await second.deliverChatReceipt(second.chatReceipts.key(fresh.signalId));assert.equal(prompts.filter(x=>x==='fresh-question').length,1);
});
