import test from 'node:test';import assert from 'node:assert/strict';import {initialRoom} from '../server/bootstrap.mjs';import {operatorNormalization} from '../server/operator-normalization.mjs';import {RoomStore} from '../server/store.mjs';import {AgentRooms} from '../server/agent-rooms.mjs';import {createRoomServer} from '../server/http.mjs';import {RoomAgentClient} from '../client/room-agent.mjs';import {linkWithProof} from './helpers/link-with-proof.mjs';
async function setup(t,count=1,otherCount=1){
 const s=new RoomStore(':memory:'),owner=s.identities.create('Owen'),worker=s.identities.create('Vega'),other=s.identities.create('Lyra');new AgentRooms(s).create(owner.secret,{roomId:'commons',title:'Agent work',purpose:'Coordinate',starter:false});
 for(const person of [worker,other]){linkWithProof(s,owner.secret,'commons',person,{displayName:person.identityId===worker.identityId?'Vega':'Lyra',permissions:[]});s.dmConsents.request('commons',owner.identityId,person.identityId,'Fixture');s.dmConsents.decide('commons',person.identityId,owner.identityId,'approve');}
 // Spread legitimate source creation across ordinary chat-flood windows.
 let clock=s.now();s.now=()=>clock;
 for(let i=0;i<count;i++){clock+=2001;s.command(owner.secret,'commons',{id:'ask-'+i,type:'message.posted',data:{messageId:'ask-'+i,toMemberId:worker.identityId,requestKind:'reply',body:'PRIVATE-BODY-SENTINEL'}});}
 for(let i=0;i<otherCount;i++){clock+=2001;s.command(owner.secret,'commons',{id:'other-private-'+i,type:'message.posted',data:{messageId:'other-private-'+i,toMemberId:other.identityId,requestKind:'reply',body:'OTHER-PRIVATE-SENTINEL'}});}
 s.room=()=>{throw Error('forbidden full-room hydration');};const server=createRoomServer({store:s});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));s.close();});const origin='http://127.0.0.1:'+server.address().port,client=new RoomAgentClient({origin,roomId:'commons',memberId:worker.identityId,token:worker.secret});return{s,owner,worker,other,origin,client};
}
test('normalized selected agent work is private and never hydrates a room',async t=>{
 const f=await setup(t),before=f.s.headSequence('commons'),result=await f.client.agentWork();assert.deepEqual(result.requests.map(r=>r.id),['ask-0']);assert.deepEqual(result.runs,{});assert.equal(result.executionGranted,false);assert.equal(result.ownerId,f.owner.identityId);assert.doesNotMatch(JSON.stringify(result),/PRIVATE-BODY-SENTINEL|OTHER-PRIVATE-SENTINEL|other-private/);assert.equal(f.s.headSequence('commons'),before);
});

test('normalized empty work is observed only after complete source coverage',async t=>{
 const f=await setup(t,0),result=await f.client.agentWork();assert.deepEqual(result.requests,[]);assert.deepEqual(result.runs,{});assert.deepEqual(result.blockedBy,{});
});
for(const [label,count,otherCount]of [['open queue',9,1],['invisible source beyond four eight-record refill windows',0,33]])test('normalized '+label+' refuses partial coverage instead of reporting complete or empty',async t=>{
 const f=await setup(t,count,otherCount),before=f.s.headSequence('commons');await assert.rejects(f.client.agentWork(),e=>e.status===422&&e.code==='reply_list_too_large'&&/nextRead/.test(e.message));assert.equal(f.s.headSequence('commons'),before);
});
test('normalized refill can prove empty after nine invisible requests without leaking their identities',async t=>{
 const f=await setup(t,0,9),before=f.s.headSequence('commons'),result=await f.client.agentWork();
 assert.deepEqual(result.requests,[]);assert.deepEqual(result.runs,{});assert.deepEqual(result.blockedBy,{});assert.equal(result.executionGranted,false);
 assert.doesNotMatch(JSON.stringify(result),/OTHER-PRIVATE-SENTINEL|other-private/);assert.equal(f.s.headSequence('commons'),before);
});
test('normalized work preserves paused and archived blockers without granting execution',async t=>{
 const f=await setup(t);f.s.wakeQueue.pause(f.worker.secret,'commons',{requestId:'pause-worker',reason:null});
 let result=await f.client.agentWork();assert.deepEqual(result.blockedBy,{'ask-0':['paused']});
 f.s.command(f.owner.secret,'commons',{id:'archive',type:'room.archived',data:{}});result=await f.client.agentWork();assert.deepEqual(result.blockedBy,{'ask-0':['room_archived','paused']});assert.ok(result.archivedAt);assert.equal(result.executionGranted,false);
});
test('a protected metadata read failure withholds the work view and never becomes observed empty',async t=>{
 const f=await setup(t),prepare=f.s.db.prepare.bind(f.s.db);f.s.db.prepare=sql=>{if(/FROM current_room_records/.test(sql))throw Error('injected protected read failure');return prepare(sql);};await assert.rejects(f.client.agentWork());f.s.db.prepare=prepare;assert.equal((await f.client.agentWork()).requests.length,1);
});

test('normalized observation preserves a real pre-adoption run and stale-attempt reconciliation',async t=>{
 const s=new RoomStore(':memory:');s.initialize(initialRoom());const owner=s.issueAccessKey('commons','owner');s.command(owner,'commons',{id:'add-runner',type:'member.added',data:{memberId:'runner',displayName:'Vega',kind:'agent',permissions:[]}});const worker=s.issueAccessKey('commons','runner');
 s.dmConsents.request('commons','owner','runner','Fixture');s.dmConsents.decide('commons','runner','owner','approve');s.command(owner,'commons',{id:'run-request',type:'message.posted',data:{messageId:'run-request',toMemberId:'runner',requestKind:'reply',body:'PRIVATE-RUN-SENTINEL'}});
 const request=s.replyRequests.list(worker,'commons').requests[0];s.requestRuns.apply(worker,'commons',{action:'claim',requestMessageId:request.id,attemptId:'real-attempt',expectedRequestRevision:request.revision,contextEventId:request.contextEventId});
 const plan=operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true});operatorNormalization(s,{roomId:'commons',discardLegacyAssignments:true,planHash:plan.planHash,requestId:'run-adoption',reason:'Synthetic retained run qualification'},true);s.room=()=>{throw Error('forbidden full room hydration');};
 const server=createRoomServer({store:s});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeStreams();server.closeAllConnections();await new Promise(r=>server.close(r));s.close();});const client=new RoomAgentClient({origin:'http://127.0.0.1:'+server.address().port,roomId:'commons',memberId:'runner',token:worker});
 let observed=await client.agentWork();assert.equal(observed.runs['run-request'].state,'working');assert.equal(observed.executionGranted,false);assert.doesNotMatch(JSON.stringify(observed),/PRIVATE-RUN-SENTINEL/);
 const later=s.now()+120001;s.now=()=>later;observed=await client.agentWork();assert.equal(observed.runs['run-request'].state,'unknown');
});
