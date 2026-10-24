import { createAgentDelivery } from '../server/agent-delivery.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';
import { AgentWakeClient } from '../client/agent-wake.mjs';
async function fixture(t) {
  const store = new RoomStore(':memory:'); const owner = store.identities.create('Morgan');
  new AgentRooms(store).create(owner.secret, { roomId:'delivery', title:'Delivery', purpose:'Synthetic tests' });
  const agent = store.identities.create('Taylor');
  store.identities.link(owner.secret,'delivery',{identityId:agent.identityId,memberId:'receiver',displayName:'Taylor',permissions:[]});
  const server=createRoomServer({store});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
  const connection={origin:`http://127.0.0.1:${server.address().port}`,roomId:'delivery',memberId:'receiver',token:agent.secret};
  return {store,owner,agent,connection,client:new AgentWakeClient({connection,deliveryProtocol:'combined'})};
}
const options={hostId:'host',cadenceSeconds:60,waitMs:0,deliveryOnly:true};
test('combined delivery uses one HTTP request, scopes signals, and never acknowledges',async t=>{
  const f=await fixture(t);let calls=0;
  const good=f.store.agentHeartbeats.enqueueWake({agentId:f.agent.identityId,roomId:'delivery',kind:'dm',messageId:'good'}).signal;
  f.store.agentHeartbeats.enqueueWake({agentId:f.agent.identityId,roomId:'other',kind:'dm',messageId:'hidden'});
  const client=new AgentWakeClient({connection:f.connection,deliveryProtocol:'combined',fetchImpl:(...args)=>{calls++;return fetch(...args);}});
  const result=await client.wait(options);
  assert.equal(calls,1);assert.deepEqual(result.pendingWakes.map(x=>x.signalId),[good.signalId]);
  assert.equal(result.acknowledged,false);assert.equal(f.store.agentHeartbeats.pendingWakes(f.agent.identityId).length,2);
  for(const key of ['authMs','leaseMs','pollMs','waitMs','totalMs'])assert.ok(result.serverTiming[key]>=0);
  assert.ok(!JSON.stringify(result).includes(f.agent.secret));
});
test('competing host receives no signals',async t=>{
  const f=await fixture(t);await f.client.wait(options);
  f.store.agentHeartbeats.enqueueWake({agentId:f.agent.identityId,roomId:'delivery',kind:'dm',messageId:'pending'});
  const result=await f.client.wait({...options,hostId:'other'});
  assert.equal(result.status,'listener_contended');assert.deepEqual(result.pendingWakes,[]);
});
test('wrong configured member is refused before host registration',async t=>{
  const f=await fixture(t);
  const client=new AgentWakeClient({connection:{...f.connection,memberId:'wrong'},deliveryProtocol:'combined'});
  await assert.rejects(client.wait(options));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_hosts').get().n,0);
});
test('revocation during held wait prevents delivery',async t=>{
  const f=await fixture(t);
  const original=f.store.agentHeartbeats.addWakeWaiter.bind(f.store.agentHeartbeats);
  f.store.agentHeartbeats.addWakeWaiter=(...args)=>{
    const release=original(...args);
    queueMicrotask(()=>{f.store.identities.unlink(f.owner.secret,'delivery',f.agent.identityId);args[2].onWake();});
    return release;
  };
  await assert.rejects(f.client.wait({...options,waitMs:100}));
});
test('held wait wakes on new signal without a second HTTP request',async t=>{
  const f=await fixture(t);const original=f.store.agentHeartbeats.addWakeWaiter.bind(f.store.agentHeartbeats);
  f.store.agentHeartbeats.addWakeWaiter=(...args)=>{const release=original(...args);queueMicrotask(()=>f.store.agentHeartbeats.enqueueWake({agentId:f.agent.identityId,roomId:'delivery',kind:'dm',messageId:'arrived'}));return release;};
  const result=await f.client.wait({...options,waitMs:1000});
  assert.equal(result.pendingWakes[0].messageId,'arrived');assert.ok(result.waitedMs<1000);
});
test('changed lease fencing after wait discards old observations',async t=>{
  const f=await fixture(t);const original=f.store.agentHeartbeats.addWakeWaiter.bind(f.store.agentHeartbeats);
  f.store.agentHeartbeats.addWakeWaiter=(...args)=>{const release=original(...args);queueMicrotask(()=>{
    f.store.db.prepare('UPDATE agent_wake_listener_leases SET lease_expires_at=0').run();
    f.store.agentHeartbeats.acquireListenerLease({agentId:f.agent.identityId,roomId:'delivery',listenerId:'competitor'});
    args[2].onWake();
  });return release;};
  const result=await f.client.wait({...options,waitMs:100});assert.equal(result.status,'listener_contended');assert.deepEqual(result.pendingWakes,[]);
});

test('scoped API key uses its room and host namespace and requires both heartbeat scopes',async t=>{
  const f=await fixture(t);
  const issue=scopes=>'rak_'+f.store.agentPlugin.issueApiKey({identityId:f.agent.identityId,scopes}).secret;
  const token=issue(['rooms:read','mcp:room:delivery','heartbeats:read','heartbeats:report']);
  const client=new AgentWakeClient({connection:{...f.connection,token},deliveryProtocol:'combined'});
  await client.wait(options);
  const hosts=f.store.db.prepare('SELECT host_id FROM agent_hosts').all();
  assert.equal(hosts.length,1);assert.notEqual(hosts[0].host_id,'host');
  const denied=new AgentWakeClient({connection:{...f.connection,token:issue(['rooms:read','mcp:room:delivery','heartbeats:read'])},deliveryProtocol:'combined'});
  await assert.rejects(denied.wait({...options,hostId:'denied'}));
});
test('auto uses combined delivery but falls back once only for unsupported endpoint',async t=>{
  const f=await fixture(t);let probes=0;
  const client=new AgentWakeClient({connection:f.connection,deliveryProtocol:'auto',fetchImpl:(url,opts)=>{
    if(new URL(url).pathname.endsWith('/receive')){probes++;return Promise.resolve(Response.json({error:{code:'not_found'}},{status:404}));}
    return fetch(url,opts);
  }});
  await client.wait(options);await client.wait(options);assert.equal(probes,1);
});
test('auto never falls back after denial or an ambiguous server failure',async t=>{
  const f=await fixture(t);
  for(const status of [403,503]){
    let calls=0;
    const client=new AgentWakeClient({connection:f.connection,deliveryProtocol:'auto',fetchImpl:async()=>{calls++;return Response.json({error:{code:'denied'}},{status});}});
    await assert.rejects(client.wait(options));assert.equal(calls,1);
  }
});
test('combined pages preserve all signals without replaying or acknowledging them',async t=>{
  const f=await fixture(t);
  for(let i=0;i<55;i++)f.store.agentHeartbeats.enqueueWake({agentId:f.agent.identityId,roomId:'delivery',kind:'dm',messageId:`m${i}`});
  const a=await f.client.wait(options);assert.equal(a.more,true);assert.ok(a.nextCursor);
  const b=await f.client.wait({...options,cursor:a.nextCursor});
  assert.equal(new Set([...a.pendingWakes,...b.pendingWakes].map(x=>x.signalId)).size,55);
  const again=await f.client.wait(options);
  assert.deepEqual(again.pendingWakes.map(x=>x.signalId),a.pendingWakes.map(x=>x.signalId));
});
test('combined empty wait returns a bounded timeout',async t=>{
  const f=await fixture(t);const r=await f.client.wait({...options,waitMs:20});
  assert.equal(r.timedOut,true);assert.deepEqual(r.pendingWakes,[]);assert.ok(r.waitedMs>=10);
});

test('invalid delivery body is rejected before registering or polling a host', async () => {
  let writes=0;
  const handler=createAgentDelivery({store:{transaction:()=>{writes++;}},actor:()=>({identityId:'identity'}),
    bearer:()=> 'pri_test',body:async()=>({roomId:'room',memberId:'member',hostId:'host',cadenceSeconds:60,waitMs:-1}),
    json:()=>assert.fail('response'),rate:()=>{},reject:(_status,code)=>{throw new Error(code);}});
  await assert.rejects(handler({}, {}, {remoteAddress:'local'}),/invalid_body/);
  assert.equal(writes,0);
});
