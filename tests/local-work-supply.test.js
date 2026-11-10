import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverLocalWork, runPlannedRequest } from '../client/local-work-supply.mjs';
const now = Date.now(), head = 'a'.repeat(40);
const policy = { repository:'owner/repo', number:1, kind:'failed_ci', acceptance:'Attribute the failed job at exact head',
  valueReason:'Unblock selected MVP change', value:8, minutes:20, requires:['node'], scopes:['repo/client'] };
const pr = {headRefOid:head,state:'OPEN',statusCheckRollup:[{name:'unit',status:'COMPLETED',conclusion:'FAILURE'}]};
const discover = (result=pr, policies=[policy]) => discoverLocalWork({policies,now,readPullRequest:async()=>result});
test('discovers only selected open actionable work; skipped CI is not failure or success', async()=>{
  assert.equal((await discover()).jobs.length,1);
  for(const result of [{...pr,state:'MERGED'},{...pr,statusCheckRollup:[]},{...pr,statusCheckRollup:[{status:'COMPLETED',conclusion:'SKIPPED'}]}])
    assert.equal((await discover(result)).jobs.length,0);
  assert.equal((await discover({...pr,statusCheckRollup:[]},[{...policy,kind:'review'}])).jobs.length,1);
  await assert.rejects(discover({...pr,headRefOid:'unknown'}));
  await assert.rejects(discover(pr,[{...policy,number:'1; echo bad'}]));
});
const setup = async () => {
  const {jobs}=await discover();
  const snapshot={jobs,devices:[{id:'mac',fingerprint:'a'.repeat(16),verified:true,available:true,observedAt:new Date(now).toISOString(),capabilities:['node']}]};
  return {snapshot,deviceId:'mac',bindings:[{source:jobs[0].source,revision:head,deviceId:'mac',requestMessageId:'request',requestRevision:2}],
    runnerOptions:{},refresh:async()=>snapshot,clock:()=>now};
};
test('pins request revision and invokes existing runner only after fresh planning',async()=>{
  const input=await setup();let invoked=0;
  const result=await runPlannedRequest({...input,runner:async options=>{
    assert.equal(options.selectRequest({id:'request',revision:2}),true);
    assert.equal(options.selectRequest({id:'request',revision:3}),false);
    assert.equal(options.selectRequest({id:'other',revision:2}),false);
    await options.preflight();invoked++;return {status:'delivered'};
  }});
  assert.equal(result.status,'delivered');assert.equal(invoked,1);
});
test('changed source, stale device, reservations and verified receipts prevent new execution',async()=>{
  for(const mutation of [s=>s.jobs[0].revision='b'.repeat(40),s=>s.devices[0].available=false,
    s=>s.devices[0].observedAt='2000-01-01',s=>s.reservations=[{deviceId:'mac',...s.jobs[0]}],
    s=>s.receipts=[{...s.jobs[0],status:'verified',evidence:'receipt'}]]){
    const input=await setup(),fresh=structuredClone(input.snapshot);mutation(fresh);
    await assert.rejects(runPlannedRequest({...input,refresh:async()=>fresh,runner:async options=>{await options.preflight();throw Error('should not execute');}}),/Assignment changed/);
  }
});
test('missing formal binding does not run, idle is honest, no selection override',async()=>{
  const input=await setup();
  assert.equal((await runPlannedRequest({...input,bindings:[]})).status,'needs_request');
  assert.equal((await runPlannedRequest({...input,snapshot:{...input.snapshot,jobs:[]}})).status,'idle');
  await assert.rejects(runPlannedRequest({...input,runnerOptions:{selectRequest:()=>true}}));
});

test('real service claim, durable journal, delivery and replay execute a selected request once',async t=>{
  const {createAcceptanceFixture}=await import('../scripts/acceptance-fixture.mjs');
  const {createRoomServer}=await import('../server/http.mjs');
  const {openRequestJournal}=await import('../client/request-runner.mjs');
  const {RoomAgentClient}=await import('../client/room-agent.mjs');
  const {rmSync}=await import('node:fs');
  const f=createAcceptanceFixture(), server=createRoomServer({store:f.store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const db=openRequestJournal(`${f.directory}/supply.sqlite`);
  t.after(async()=>{db.close();server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.store.close();rmSync(f.directory,{recursive:true,force:true});});
  for(const [from,to] of [['owner','producer'],['producer','owner']]){
    f.store.dmConsents.request('commons',from,to,'fixture');f.store.dmConsents.decide('commons',to,from,'approve');
  }
  f.store.command(f.keys.owner,'commons',{id:'supply-request',type:'message.posted',data:{messageId:'supply-request',requestKind:'reply',toMemberId:'producer',body:'Verify selected fixture'}});
  const connection={origin:`http://127.0.0.1:${server.address().port}`,roomId:'commons',memberId:'producer',token:f.keys.producer};
  const client=new RoomAgentClient(connection), context=await client.replyContext('supply-request');
  const input=await setup();input.bindings[0].requestMessageId='supply-request';input.bindings[0].requestRevision=context.request.revision;
  let calls=0;input.runnerOptions={connection,db,execute:async()=>{calls++;return {body:'Selected fixture verified.'};}};
  assert.equal((await runPlannedRequest(input)).status,'delivered');
  assert.equal((await client.replyContext('supply-request')).request.status,'answered');
  await runPlannedRequest(input);
  assert.equal(calls,1,'re-entry must recover the saved outcome, not invoke host again');
});

test('discovers failed StatusContext checks and excludes pending or successful contexts',async()=>{
  for(const state of ['FAILURE','ERROR','PENDING','SUCCESS']){
    const result=await discover({...pr,statusCheckRollup:[{__typename:'StatusContext',state,context:'external CI',targetUrl:'https://example.test/ci'}]});
    const failed=['FAILURE','ERROR'].includes(state);
    assert.equal(result.jobs.length,failed?1:0);
    if(failed) assert.deepEqual(result.observations[0].failedChecks,[{name:'external CI',url:'https://example.test/ci'}]);
  }
});
test('preflight rejects a newly unavailable alias of the same physical device',async()=>{
  const input=await setup(), fresh=structuredClone(input.snapshot);
  fresh.devices.push({...fresh.devices[0],id:'alias',available:false});
  await assert.rejects(runPlannedRequest({...input,refresh:async()=>fresh,runner:async options=>{
    await options.preflight();throw Error('host must not execute');
  }}),/Assignment changed/);
});
