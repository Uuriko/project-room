import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';
import {installFakeWebhookDns} from './helpers/fake-webhook-dns.mjs';
import {createWakeAdapters} from '../server/wake-adapters.mjs';
import {jobByName,jobIsDue,earliestFutureAlarm} from '../server/jobs.mjs';
const job=jobByName('webhook-dispatch');
function fixture(t){
 const f=createAcceptanceFixture();t.after(()=>{f.store.close();rmSync(f.directory,{recursive:true,force:true});});
 let now=1750000000000;f.store.now=()=>now;
 const identity=f.store.identities.create('scheduler-agent');
 linkWithProof(f.store,f.keys.owner,'commons',identity,{memberId:'wakeagent',displayName:'Wake Agent',permissions:['accept_work']});
 const adapters=createWakeAdapters({env:{ROOM_WAKE_ADAPTERS:'1'},clock:()=>now});
 f.store.agentPlugin.setWakeAdapters(adapters);installFakeWebhookDns(f.store);
 f.store.agentPlugin.subscribeWebhook({identityId:identity.identityId,url:'https://agent.example.test/wake',events:['agent.wake']});
 const calls=[];const ctx={fetchImpl:async(_url,init)=>{calls.push(JSON.parse(init.body));return new Response('',{status:200});}};
 return {...f,identity,adapters,calls,ctx,now:()=>now,advance:ms=>{now+=ms;},offer:id=>f.store.agentPlugin.deliverWakePing({identityId:identity.identityId,signal:{signalId:id,roomId:'commons',reason:'assignment'}}),alarm:()=>earliestFutureAlarm([job],{env:{},store:f.store,now,lastRan:{}})};
}
for (const hostUrl of [false,true]) test(`drained delivery schedules real job retries and fresh generation (host URL ${hostUrl})`,async t=>{
 const f=fixture(t), deliveries=hostUrl?2:1;
 if(hostUrl) f.store.agentHeartbeats.heartbeat({agentId:f.identity.identityId,hostId:'push',mode:'wakeable',wakeUrl:'https://host.example.test/wake'});
 f.offer('old');await job.run(f.store,f.ctx);assert.equal(f.calls.length,deliveries);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM agent_webhook_deliveries WHERE state IN ('pending','failed')").get().n,0);
 for(let attempt=1;attempt<=2;attempt++){
  const target=f.now()+300000;
  assert.equal(f.alarm(),target,'no pending delivery must still schedule the coalescer retry');
  assert.equal(f.alarm(),target,'observing due time must not consume retry');
  f.advance(299999);assert.equal(jobIsDue(job,f.store,f.now()),false);
  f.advance(1);assert.equal(jobIsDue(job,f.store,f.now()),true);
  await job.run(f.store,f.ctx);assert.equal(f.calls.length,(attempt+1)*deliveries,'retry must reach synthetic transport after initial row is delivered');
  f.store.agentPlugin.deliverWakePing({identityId:f.identity.identityId,signal:{signalId:'old',roomId:'commons',reason:'rewake'},rewake:{attempt,count:1}});
  await job.run(f.store,f.ctx);assert.equal(f.calls.length,(attempt+1)*deliveries,'replayed attempt must not deliver twice');
 }
 assert.equal(f.alarm(),null);assert.equal(job.enabled({},f.store),false);
 f.advance(1);assert.equal(f.offer('fresh').coalesced,true);
 assert.equal(f.alarm(),f.now()+299999);f.advance(299999);await job.run(f.store,f.ctx);
 assert.equal(f.calls.length,4*deliveries);assert.equal(f.calls.at(-1).data.signal.signalId,'fresh');
 f.store.agentPlugin.noteWakeRead(f.identity.identityId,'commons');assert.equal(f.alarm(),null);
 const disabled=createWakeAdapters({clock:f.now});disabled.coalescer.offer(f.identity.identityId,{roomId:'commons',signalId:'off'});
 f.store.agentPlugin.setWakeAdapters(disabled);assert.equal(f.alarm(),null,'disabled adapter never arms a retry timer');
});
test('assignment-only heartbeat acknowledgement stops scheduled rewake',async t=>{
 const f=fixture(t),id=f.identity.identityId;
 f.store.agentHeartbeats.heartbeat({agentId:id,hostId:'worker',mode:'pull-only',workWakes:true});
 f.store.command(f.keys.owner,'commons',{id:'assignment',type:'work.proposed',data:{workItemId:'task',title:'Synthetic assignment',definitionOfDone:'Done',mode:'read',accountableMemberId:'wakeagent'}});
 const [wake]=f.store.agentHeartbeats.pendingWakes(id,{hostId:'worker'});assert.equal(wake.kind,'work');
 f.offer(wake.signalId);await job.run(f.store,f.ctx);
 const result=f.store.agentHeartbeats.ackWakes({agentId:id,signalIds:[wake.signalId],roomId:'commons'});
 assert.deepEqual(result.acknowledged,[wake.signalId]);assert.equal(f.adapters.coalescer.status(id,'commons'),'acked');
 assert.equal(f.alarm(),null);f.advance(300000);await job.run(f.store,f.ctx);assert.equal(f.calls.length,1);
});

test('late heartbeat ack of old signal preserves the fresh coalesced generation until its own ack',async t=>{
 const f=fixture(t),agentId=f.identity.identityId,hb=f.store.agentHeartbeats;
 hb.heartbeat({agentId,hostId:'reader',mode:'pull-only'});
 const enqueue=messageId=>hb.enqueueWake({agentId,kind:'mention',roomId:'commons',messageId}).signal;
 const s1=enqueue('s1');f.offer(s1.signalId);await job.run(f.store,f.ctx);
 f.advance(1);const s2=enqueue('s2');assert.equal(f.offer(s2.signalId).coalesced,true);
 const wrongRoom=hb.ackWakes({agentId,signalIds:[s2.signalId],roomId:'other'});
 assert.deepEqual(wrongRoom.acknowledged,[]);
 assert.deepEqual(hb.ackWakes({agentId,signalIds:[s1.signalId],roomId:'commons'}).acknowledged,[s1.signalId]);
 assert.equal(f.adapters.coalescer.status(agentId,'commons'),'pending','old ack cannot consume newer generation');
 assert.equal(f.alarm(),f.now()+299999);
 f.advance(299999);await job.run(f.store,f.ctx);
 assert.equal(f.calls.length,2);assert.equal(f.calls.at(-1).data.signal.signalId,s2.signalId);
 assert.equal(hb.pendingWakes(agentId).some(w=>w.signalId===s2.signalId),true);
 // Explicit room scope is retained even if a caller supplies an ID also
 // present in another in-memory entry; no whole-agent clearing by accident.
 f.adapters.coalescer.offer(agentId,{roomId:'other',signalId:s2.signalId});
 assert.deepEqual(hb.ackWakes({agentId,signalIds:[s2.signalId],roomId:'commons'}).acknowledged,[s2.signalId]);
 assert.equal(f.adapters.coalescer.status(agentId,'commons'),'acked');
 assert.equal(f.adapters.coalescer.status(agentId,'other'),'pending');
 f.store.agentPlugin.noteWakeRead(agentId,'other');assert.equal(f.alarm(),null,'explicit whole-room read remains separate');
 f.advance(300000);await job.run(f.store,f.ctx);assert.equal(f.calls.length,2);
});
