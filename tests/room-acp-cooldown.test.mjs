import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import {RoomClient,RoomError} from '../room-acp/src/room.mjs';
import {Bridge} from '../room-acp/src/bridge.mjs';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedScopedInbox} from './helpers/scoped-inbox-source.mjs';
async function serve(t,handler){const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});return`http://127.0.0.1:${server.address().port}`;}
const reject429=promise=>assert.rejects(promise,error=>error instanceof RoomError&&error.status===429);
const send429=(res,retry)=>{res.writeHead(429,{'content-type':'application/json','retry-after':retry});res.end(JSON.stringify({error:{code:'rate_limited',message:'Synthetic bucket exhausted'}}));};
test('actual Room credential read bucket cooldown gates concurrent different paths without retrying any request',{timeout:10000},async t=>{
 const store=new RoomStore(':memory:'),seeded=seedScopedInbox(store),server=createRoomServer({store,credentialReadBurst:1});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
 const calls=[],room=new RoomClient({apiBase:`http://127.0.0.1:${server.address().port}`,credential:seeded.token,fetchImpl:async(...args)=>{calls.push(performance.now());return fetch(...args);}});
 const path=id=>`/api/rooms/commons/messages/${id}/thread?view=message`;
 await room.request(path('mention'));await reject429(room.request(path('reply')));const failedAt=performance.now();
 const results=await Promise.allSettled([room.request(path('mention')),room.request(path('reply'))]);
 assert.equal(calls.length,4,'429 request is never automatically retried');assert.ok(calls[2]-failedAt>=900);assert.ok(calls[3]-failedAt>=900);
 assert.ok(results.some(row=>row.status==='fulfilled'));for(const row of results)if(row.status==='rejected')assert.equal(row.reason.status,429);
});
test('in-flight 429 extends shared monotonic cooldown for another already-waiting path',{timeout:10000},async t=>{
 const calls=[];let extendedAt;
 const apiBase=await serve(t,async(req,res)=>{calls.push({path:req.url,at:performance.now()});if(req.url==='/one')return send429(res,'1');if(req.url==='/two'){await delay(100);extendedAt=performance.now();return send429(res,'2');}res.end('{}');});
 const room=new RoomClient({apiBase});const first=reject429(room.request('/one')),second=reject429(room.request('/two'));
 await first;const third=room.request('/after');await second;await third;
 assert.deepEqual(calls.map(row=>row.path),['/one','/two','/after']);assert.ok(calls[2].at-extendedAt>=1900,'later429 must extend an existing waiter');
});
test('malformed later Retry-After cannot erase an existing valid cooldown',{timeout:10000},async t=>{
 const calls=[];let validAt;
 const apiBase=await serve(t,async(req,res)=>{calls.push({path:req.url,at:performance.now()});if(req.url==='/valid'){validAt=performance.now();return send429(res,'1');}if(req.url==='/invalid'){await delay(80);return send429(res,'121');}res.end('{}');});
 const room=new RoomClient({apiBase});const valid=reject429(room.request('/valid')),invalid=reject429(room.request('/invalid'));
 await valid;const later=room.request('/later');await invalid;await later;
 assert.equal(calls.length,3);assert.ok(calls[2].at-validAt>=900);
});
test('existing Bridge abort cancels shared cooldown before fetch with no model or send',async t=>{
 let calls=0;const apiBase=await serve(t,(_req,res)=>{calls++;send429(res,'1');});
 const bridge=new Bridge({connection:{apiBase,roomId:'r',memberId:'m',hostId:'h'},persistSessions:false,host:{stop(){}}});
 await reject429(bridge.room.request('/limited'));const pending=bridge.room.request('/not-sent');bridge.stop();
 await assert.rejects(pending,error=>error instanceof RoomError&&error.code==='network');assert.equal(calls,1);
});
test('only conservative integer Retry-After1..120 is accepted; invalid values never schedule a wait',async()=>{
 for(const retry of ['0','-1','1.5','121','999999','tomorrow','']){
  let calls=0;const room=new RoomClient({apiBase:'https://fixture.invalid',fetchImpl:async()=>++calls===1?new Response(JSON.stringify({error:{code:'rate_limited'}}),{status:429,headers:{'retry-after':retry}}):new Response('{}')});
  await assert.rejects(room.request('/first'),error=>error.retryAfterMs===null);await room.request('/next');assert.equal(calls,2);
 }
});

test('stopped Bridge still performs its original bounded disconnect after shared cooldown',{timeout:10000},async t=>{
 const calls=[];const apiBase=await serve(t,(req,res)=>{calls.push({path:req.url,at:performance.now()});if(req.url==='/limited')return send429(res,'1');res.end('{}');});
 const bridge=new Bridge({connection:{apiBase,roomId:'r',memberId:'m',hostId:'h'},persistSessions:false,host:{stop(){}}});
 await reject429(bridge.room.request('/limited'));const limitedAt=performance.now();bridge.stop();
 await bridge.room.disconnect({hostId:'h',fencingToken:'synthetic-existing-lease'});
 assert.deepEqual(calls.map(row=>row.path),['/limited','/api/agent-heartbeats']);assert.ok(calls[1].at-limitedAt>=900);
});
