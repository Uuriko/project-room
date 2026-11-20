import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {textVersion} from '../server/text-results.mjs';
import {Bridge} from '../room-acp/src/bridge.mjs';
import {RoomError} from '../room-acp/src/room.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';

async function setup(t, {respondTo, pending = false} = {}) {
  const f = createAcceptanceFixture(), roomId = 'commons', workItemId = 'exact-review-work', memberId = 'exact-reviewer';
  const identity = f.store.identities.create('Exact reviewer');
  linkWithProof(f.store,f.keys.owner,roomId,identity,{memberId,permissions:['verify']});
  const hostId = 'fixture-exact-review';
  f.store.workWakes.setHost(identity.identityId,hostId,true,roomId);
  const send = (member,type,data) => f.store.command(f.keys[member],roomId,{id:randomUUID(),type,data});
  send('owner','work.proposed',{workItemId,title:'Exact agenda review',definitionOfDone:'Verify the named agenda owner.',
    accountableMemberId:'producer',verifierMemberId:memberId,independentVerificationRequired:true,mode:'read'});
  const current = () => f.store.room(roomId).state.workItems[workItemId];
  const transition = (type,data={}) => send('producer',type,{workItemId,expectedRevision:current().revision,...data});
  transition('work.accepted');
  transition('work.started');
  const messageId = randomUUID(), body = 'Evidence for the agenda is ready.';
  const post = send('producer','message.posted',{workItemId,messageId,body});
  const completion = transition('work.completed',{evidenceKind:'room_text',evidenceMessageId:messageId,
    evidenceMessageEventId:post.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,
    producerId:'producer',summary:'Exact evidence',nextAction:'Review the stored text'});
  const server = createRoomServer({store:f.store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{ server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    f.store.close();rmSync(f.directory,{recursive:true,force:true}); });
  const connection = {apiBase:`http://127.0.0.1:${server.address().port}`,roomId,memberId,credential:identity.secret,hostId};
  const counts = {prompt:0,write:0,receipt:0,ack:0};
  function make() {
    const bridge = new Bridge({connection,respondTo,waitMs:0,env:{ROOM_ACP_HOME:join(f.directory,'acp-host')},host:{
      session:async()=>({sessionId:'fixture-review-session'}),prompt:async(_key,prompt)=>{
        counts.prompt++;
        assert.match(prompt[0].text,/Evidence for the agenda is ready/);
        return {stopReason:'end_turn',recorder:{text:JSON.stringify({result:pending?'pending':'pass',summary:'Checked the exact agenda owner and assigned reviewer.'})}};
      },
    }});
    const request = bridge.room.request.bind(bridge.room);
    bridge.room.request = async(path,options)=>{
      if (path==='/mcp') counts.receipt++;
      if (options?.body?.type==='verification.recorded') counts.write++;
      if (path==='/api/agent-heartbeats/ack') counts.ack++;
      return request(path,options);
    };
    return bridge;
  }
  const bridge = make();
  assert.equal(await bridge.lease(),true);
  const {pendingWakes} = await bridge.room.poll({hostId,waitMs:0});
  const wake = pendingWakes.find(item=>item.kind==='work' && item.action==='verify');
  assert.equal(wake?.completionEventId,completion.event.id);
  const verdict = () => f.store.workResult(identity.secret,roomId,workItemId,{completionEventId:completion.event.id}).workThread.verdict;
  const pendingRows = () => f.store.db.prepare('SELECT delivered_at, invalidated_at FROM agent_work_wakes WHERE signal_id=?').get(wake.signalId);
  const recordCompetingVerdict = () => f.store.command(identity.secret,roomId,{id:randomUUID(),type:'verification.recorded',data:{
    workItemId,expectedRevision:current().revision,completionEventId:completion.event.id,evidenceVersion:textVersion(body),
    result:'fail',summary:'The agenda owner is missing from the result.'}});
  return {bridge,wake,counts,make,verdict,pendingRows,recordCompetingVerdict};
}

test('exact work wake runs native review and records one verdict, recovering a lost write through its original receipt',async t=>{
  const f = await setup(t);
  const request = f.bridge.room.request;
  f.bridge.room.request = async(path,options)=>{
    const response = await request(path,options);
    if (options?.body?.type==='verification.recorded') throw new RoomError(0,'network','Committed response lost');
    return response;
  };
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.equal(f.verdict()?.result,'pass');
  assert.deepEqual(f.counts,{prompt:1,write:1,receipt:1,ack:1});
  const restarted = f.make();
  assert.equal(await restarted.lease(),true);
  await restarted.accept(f.wake);
  await restarted.queue.idle();
  assert.deepEqual(f.counts,{prompt:1,write:1,receipt:1,ack:2});
});

test('a work wake a host cannot act on stays pending without a turn or transport acknowledgment',async t=>{
  const f = await setup(t,{respondTo:'owner'});
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.deepEqual(f.counts,{prompt:0,write:0,receipt:0,ack:0});
  assert.equal(f.pendingRows().delivered_at,null);
  assert.equal(f.verdict(),undefined);
});

test('a restarted receiver reconciles an uncertain committed verdict even after Room invalidated its wake',async t=>{
  const f = await setup(t);
  const request = f.bridge.room.request;
  f.bridge.room.request = async(path,options)=>{
    if (path==='/mcp') throw new RoomError(503,'unavailable','Immediate receipt check unavailable');
    const response = await request(path,options);
    if (options?.body?.type==='verification.recorded') throw new RoomError(0,'network','Committed response lost');
    return response;
  };
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.equal(f.verdict()?.result,'pass');
  assert.notEqual(f.pendingRows().invalidated_at,null);
  assert.deepEqual(f.counts,{prompt:1,write:1,receipt:0,ack:0});
  const restarted = f.make();
  const poll = restarted.room.poll.bind(restarted.room);
  restarted.room.poll = async args=>{
    const page = await poll(args);
    assert.equal(page.pendingWakes.some(wake=>wake.signalId===f.wake.signalId),false);
    return page;
  };
  await restarted.pollOnce();
  await restarted.queue.idle();
  assert.equal(restarted.stats.posted,1);
  assert.deepEqual(f.counts,{prompt:1,write:1,receipt:1,ack:0});
});

test('inconclusive exact review remains available after the model stops',async t=>{
  const f = await setup(t,{pending:true});
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.deepEqual(f.counts,{prompt:1,write:0,receipt:0,ack:0});
  assert.equal(f.pendingRows().delivered_at,null);
  assert.equal(f.verdict(),undefined);
});

test('a review that lands while the agent works wins over its stale verdict',async t=>{
  const f = await setup(t);
  const prompt = f.bridge.host.prompt;
  f.bridge.host.prompt = async (...args) => {
    const result = await prompt(...args);
    f.recordCompetingVerdict();
    return result;
  };
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.equal(f.verdict()?.result,'fail');
  assert.notEqual(f.pendingRows().invalidated_at,null);
  assert.deepEqual(f.counts,{prompt:1,write:1,receipt:0,ack:0});
});
