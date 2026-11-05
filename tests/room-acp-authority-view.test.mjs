import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {createRoomServer} from '../server/http.mjs';
import {seedScopedInbox} from './helpers/scoped-inbox-source.mjs';
import {Bridge} from '../room-acp/src/bridge.mjs';
import {RoomClient} from '../room-acp/src/room.mjs';
import {readRoomAuthorityView} from '../server/room-authority-view.mjs';
import {withCurrentRoomWriter} from '../server/current-room-repository.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';

async function fixture(t){
 const store=new RoomStore(':memory:'),seeded=seedScopedInbox(store),server=createRoomServer({store});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
 const apiBase=`http://127.0.0.1:${server.address().port}`,connection={apiBase,roomId:'commons',memberId:'worker',credential:seeded.token,hostId:'authority-test'};
 const bridge=new Bridge({connection,persistSessions:false,host:{},log:()=>{}});
 return {store,seeded,apiBase,connection,bridge,headers:{authorization:'Bearer '+seeded.token}};
}

test('listener authority ignores large conversation history while the full snapshot remains bounded',async t=>{
 const f=await fixture(t);let now=Date.now();f.store.now=()=>now;
 for(let n=0;n<30;n++){now+=2001;f.store.command(f.seeded.owner,'commons',{id:'large-'+n,type:'message.posted',data:{messageId:'large-'+n,body:'x'.repeat(12000),toMemberId:'worker'}});}
 await assert.rejects(f.bridge.room.room(),e=>e.status===409&&e.code==='current_room_context_unavailable');
 f.store.room=()=>{throw Error('Whole-room hydration is forbidden');};
 const prepare=f.store.db.prepare.bind(f.store.db);
 f.store.db.prepare=sql=>{if(/\b(?:FROM|JOIN)\s+(?:messages|events|message_entity_proofs)\b/i.test(sql))throw Error('Authority read touched conversation storage');return prepare(sql);};
 const requests=[],original=f.bridge.room.request.bind(f.bridge.room);
 f.bridge.room.request=(path,...rest)=>{requests.push(path);return original(path,...rest);};
 await f.bridge.refreshRoom();
 assert.equal(f.bridge.me.id,'worker');assert.equal(f.bridge.ownerId,'owner');
 assert.ok(requests.every(path=>path.includes('view=authority')));
 const selected=await f.bridge.room.room({authorityFor:['other']});
 assert.equal(selected.snapshotView,'authority');assert.equal(selected.state.members.other.id,'other');
 assert.ok(Buffer.byteLength(JSON.stringify(selected))<4096);assert.doesNotMatch(JSON.stringify(selected),/xxxx|messages|workItems/);
});

test('selected authority identifies unresolved IDs without claiming absence or returning another roster',async t=>{
 const f=await fixture(t),r=await fetch(f.apiBase+'/api/rooms/commons?view=authority&memberId=other&memberId=missing', {headers:f.headers});
 assert.equal(r.status,200);const v=await r.json();
 assert.deepEqual(v.authoritySelection.requestedMemberIds,['missing','other']);
 assert.deepEqual(v.authoritySelection.unresolvedMemberIds,['missing']);
 assert.deepEqual(Object.keys(v.state.members).sort(),['other','owner','worker']);
 assert.equal(v.authoritySelection.complete,true);assert.equal(v.state.members.other.id,'other');
 assert.equal(v.state.members.third,undefined);
 for(const query of ['view=authority&memberId=bad%20id','view=authority&view=authority','view=authority&messages=recent','view=authority&auth=bad']){
  assert.equal((await fetch(f.apiBase+'/api/rooms/commons?'+query,{headers:f.headers})).status,422,query);
 }
});

test('an older or partial server cannot masquerade as a selected authority response',async()=>{
 for(const value of [
  {roomId:'commons',state:{room:{ownerId:'owner'},members:{worker:{id:'worker'}}}},
  {roomId:'commons',viewerId:'worker',snapshotView:'authority',snapshotVersion:1,authoritySelection:{complete:false,requestedMemberIds:['other'],unresolvedMemberIds:[]},state:{room:{ownerId:'owner'},members:{}}}
 ]){
  const room=new RoomClient({apiBase:'https://room.example.test',roomId:'commons',memberId:'worker',fetchImpl:async()=>Response.json(value)});
  await assert.rejects(room.room({authorityFor:['other']}),e=>e.code==='selected_authority_unavailable');
 }
});

test('parallel turns retain their own selected request authors across awaits',async t=>{
 const f=await fixture(t),bridge=f.bridge;bridge.respondTo='anyone';bridge.fencingToken='fence';
 bridge.readThread=async id=>({thread:{authorId:id}});
 bridge.room.room=async({authorityFor})=>({state:{room:{ownerId:'owner'},members:Object.fromEntries(['owner','worker',...authorityFor].map(id=>[id,{id,kind:id==='owner'?'human':'agent',active:true}]))}});
 bridge.room.checkListener=async()=>{await Promise.resolve();return {listener:{valid:true}};};
 assert.deepEqual(await Promise.all([bridge.authorized({messageIds:['other']}),bridge.authorized({messageIds:['third']})]),[true,true]);
});

test('unresolved authors retain their wake rather than execute, acknowledge or stop unrelated work',async t=>{
 const f=await fixture(t),bridge=f.bridge;bridge.respondTo='anyone';await bridge.refreshRoom();await bridge.lease();
 const readThread=bridge.readThread.bind(bridge);
 bridge.readThread=async(id,...rest)=>id==='dm'?{thread:{authorId:'missing-author'}}:readThread(id,...rest);
 let prompts=0;const acks=[];bridge.host.session=async()=>({sessionId:'synthetic'});
 bridge.host.prompt=async()=>{prompts++;return {recorder:{text:'A useful answer',tools:new Map()},stopReason:'end_turn'};};
 bridge.room.ack=async value=>{acks.push(...value.signalIds);};
 await bridge.turn('dm',[{signalId:'unresolved-wake',messageId:'dm',body:'Ask',author:'owner'}]);
 assert.equal(prompts,0);assert.equal(acks.length,0);assert.equal(bridge.controller.signal.aborted,false);
 await bridge.turn('mention',[{signalId:'independent-wake',messageId:'mention',body:'Another ask',author:'owner'}]);
 assert.equal(prompts,1);assert.deepEqual(acks,['independent-wake']);
});

test('selected authority works beyond the full roster census limit and enforces its own exact selection bound',t=>{
 const store=new RoomStore(':memory:');t.after(()=>store.close());const events=initialRoom();
 for(let n=0;n<110;n++)events.push(event({roomId:'commons',actorId:'owner',type:'member.added',data:{memberId:'crowd-'+n,displayName:'Crowd '+n,kind:'agent',permissions:[]}}));
 store.initialize(events,{representation:'normalized-current-v1'});const token=store.issueAccessKey('commons','crowd-0');
 assert.throws(()=>store.roomAuthority('commons'),e=>e.code==='current_room_context_unavailable');
 store.room=()=>{throw Error('Whole-room hydration is forbidden');};
 const value=readRoomAuthorityView(store,token,'commons',['crowd-109']);
 assert.deepEqual(Object.keys(value.state.members).sort(),['crowd-0','crowd-109','owner']);
 const ids=Array.from({length:64},(_,n)=>'crowd-'+(n+1));
 assert.equal(Object.keys(readRoomAuthorityView(store,token,'commons',ids).state.members).length,66);
 assert.throws(()=>readRoomAuthorityView(store,token,'commons',[...ids,'crowd-100']),e=>e.status===422&&e.code==='invalid_snapshot_view');
});

test('selected member corruption is rejected rather than trusted as compact metadata',async t=>{
 const f=await fixture(t),row=f.store.db.prepare("SELECT payload FROM current_room_records WHERE room_id='commons' AND domain='members' AND record_key='other'").get();
 const changed=row.payload.replace('"displayName":"other"','"displayName":"wrong"');assert.notEqual(changed,row.payload);
 f.store.transaction(()=>withCurrentRoomWriter(f.store.db,'commons',()=>f.store.db.prepare("UPDATE current_room_records SET payload=? WHERE room_id='commons' AND domain='members' AND record_key='other'").run(changed)));
 const independent=await fetch(f.apiBase+'/api/rooms/commons?view=authority',{headers:f.headers});
 assert.equal(independent.status,200,'unrelated corrupt member must not force a roster read');
 const r=await fetch(f.apiBase+'/api/rooms/commons?view=authority&memberId=other',{headers:f.headers});
 assert.equal(r.status,500);assert.doesNotMatch(await r.text(),/wrong/);
});

test('a mixed same-thread batch processes allowed wakes without losing them beside denied or unresolved authors',async t=>{
 const f=await fixture(t),bridge=f.bridge;bridge.respondTo='owner';await bridge.refreshRoom();await bridge.lease();
 const room=bridge.room.room.bind(bridge.room);bridge.room.room=async options=>{const result=await room(options);if(result.state.members.other)result.state.members.other.kind='human';return result;};
 const original=bridge.readThread.bind(bridge);
 bridge.readThread=async(id,...rest)=>id==='denied-message'?{thread:{id,authorId:'other'}}:id==='unresolved-message'?{thread:{id,authorId:'missing'}}:original(id,...rest);
 let prompts=0;const acks=[];bridge.host.session=async()=>({sessionId:'synthetic'});
 bridge.host.prompt=async()=>{prompts++;return {recorder:{text:'A useful answer',tools:new Map()},stopReason:'end_turn'};};
 bridge.room.ack=async value=>acks.push(...value.signalIds);
 await bridge.turn('mention',[
  {signalId:'allowed-wake',messageId:'mention',body:'Owner ask',author:'owner'},
  {signalId:'denied-wake',messageId:'denied-message',body:'Other ask',author:'other'},
  {signalId:'unresolved-wake',messageId:'unresolved-message',body:'Missing author',author:'missing'}
 ]);
 assert.equal(prompts,1);assert.deepEqual(acks.sort(),['allowed-wake','denied-wake']);assert.equal(bridge.stats.skipped,1);
 assert.equal(bridge.controller.signal.aborted,false);
});

test('claim assignment is re-read after authority and listener validation',async t=>{
 const f=await fixture(t),bridge=f.bridge;bridge.respondTo='anyone';bridge.fencingToken='fence';
 let owner='worker';bridge.room.claim=async()=>({owner,history:[{action:'created',agentId:'owner'}]});
 const room=bridge.room.room.bind(bridge.room);bridge.room.room=async options=>{const result=await room(options);owner='other';return result;};
 bridge.room.checkListener=async()=>({listener:{valid:true}});
 assert.equal(await bridge.authorized({claimId:'claim'}),false);
});
