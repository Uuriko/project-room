import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rmSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {textVersion} from '../server/text-results.mjs';
import {Bridge} from '../room-acp/src/bridge.mjs';
import {RoomError} from '../room-acp/src/room.mjs';
import {reviewOutput, reviewRepairable, REVIEW_REPAIR_PROMPT} from '../room-acp/src/review-wake.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';

async function setup(t, {respondTo, pending = false, nextAction, replies = []} = {}) {
  const f = createAcceptanceFixture(), roomId = 'commons', workItemId = 'exact-review-work', memberId = 'exact-reviewer';
  const identity = f.store.identities.create('Exact reviewer');
  linkWithProof(f.store,f.keys.owner,roomId,identity,{memberId,permissions:['verify']});
  const producerId = 'correction-producer', producerHost = 'fixture-correction-producer';
  const producer = f.store.identities.create('Correction producer');
  linkWithProof(f.store,f.keys.owner,roomId,producer,{memberId:producerId,permissions:['accept_work','complete_work']});
  f.store.workWakes.setHost(producer.identityId,producerHost,true,roomId);
  const hostId = 'fixture-exact-review';
  f.store.workWakes.setHost(identity.identityId,hostId,true,roomId);
  const send = (member,type,data) => f.store.command(f.keys[member],roomId,{id:randomUUID(),type,data});
  send('owner','work.proposed',{workItemId,title:'Exact agenda review',definitionOfDone:'Verify the named agenda owner.',
    accountableMemberId:producerId,verifierMemberId:memberId,independentVerificationRequired:true,mode:'read'});
  const current = () => f.store.room(roomId).state.workItems[workItemId];
  const transition = (type,data={}) => f.store.command(producer.secret,roomId,{id:randomUUID(),type,
    data:{workItemId,expectedRevision:current().revision,...data}});
  transition('work.accepted');
  transition('work.started');
  const messageId = randomUUID(), body = 'Evidence for the agenda is ready.';
  const post = f.store.command(producer.secret,roomId,{id:randomUUID(),type:'message.posted',data:{workItemId,messageId,body}});
  const completion = transition('work.completed',{evidenceKind:'room_text',evidenceMessageId:messageId,
    evidenceMessageEventId:post.event.id,evidenceVersion:textVersion(body),previousCompletionEventId:null,
    producerId,summary:'Exact evidence',nextAction:'Review the stored text'});
  const server = createRoomServer({store:f.store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{ server.closeStreams();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    f.store.close();rmSync(f.directory,{recursive:true,force:true}); });
  const connection = {apiBase:`http://127.0.0.1:${server.address().port}`,roomId,memberId,credential:identity.secret,hostId};
  const counts = {prompt:0,write:0,receipt:0,ack:0}, prompts = [];
  function make() {
    const bridge = new Bridge({connection,respondTo,waitMs:0,env:{ROOM_ACP_HOME:join(f.directory,'acp-host')},host:{
      session:async()=>({sessionId:'fixture-review-session'}),prompt:async(_key,prompt,options)=>{
        counts.prompt++;
        prompts.push({prompt,sessionId:options?.sessionId});
        if (prompt !== REVIEW_REPAIR_PROMPT) assert.match(prompt[0].text,/Evidence for the agenda is ready/);
        if (replies.length) { const reply = replies.shift(); return typeof reply === 'string' ? {stopReason:'end_turn',recorder:{text:reply}} : reply; }
        const result = pending ? 'pending' : nextAction ? 'fail' : 'pass';
        return {stopReason:'end_turn',recorder:{text:JSON.stringify({result,summary:'Checked the exact agenda owner and assigned reviewer.',
          ...(nextAction ? {nextAction} : {})})}};
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
  const correctionSignals = () => f.store.workWakes.pending(producer.identityId,{roomId,hostId:producerHost});
  const readAsProducer = async ({tool,arguments:args}) => {
    const response = await fetch(connection.apiBase+'/mcp', {method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+producer.secret},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:args}})});
    assert.equal(response.status,200);
    const value = (await response.json()).result;
    assert.equal(value?.isError ?? false,false);
    return value.structuredContent;
  };
  return {bridge,wake,counts,prompts,make,verdict,pendingRows,recordCompetingVerdict,correctionSignals,readAsProducer};
}

test('an ACP failed review hands the exact reproducer to the producer with one protected wake read',async t=>{
  const nextAction = 'Run node --test --test-name-pattern="request journey at 390px" scripts/reply-request-browser-check.mjs in the reviewed worktree. Expect the hidden composer timeout.';
  const f = await setup(t,{nextAction});
  const request = f.bridge.room.request;
  f.bridge.room.request = async(path,options)=>{
    const value = await request(path,options);
    if (options?.body?.type==='verification.recorded') throw new RoomError(0,'network','Committed response lost');
    return value;
  };
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.equal(f.verdict().result,'fail');
  assert.deepEqual(f.counts,{prompt:1,write:1,receipt:1,ack:1});
  const corrections = f.correctionSignals();
  assert.equal(corrections.length,1);
  const [correction] = corrections;
  assert.equal(correction.action,'revise');
  assert.equal(correction.completionEventId,f.wake.completionEventId);
  assert.equal(correction.evidenceVersion,f.wake.evidenceVersion);
  assert.equal(correction.workRevision,f.wake.workRevision+1);
  assert.equal(JSON.stringify(correction).includes(nextAction),false);
  const brief = await f.readAsProducer(correction.nextRead);
  assert.ok(brief.brief.includes(nextAction));
  assert.equal(brief.revision,correction.workRevision);
  assert.equal(brief.continuation.tool,'room_resolve_blocker');
  assert.equal(brief.continuation.arguments.expectedRevision,correction.workRevision);
  assert.notEqual(correction.nextRead.arguments.includeDiscussion,true);
});

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

test('an already settled review is checked without allocating a model session',async t=>{
  const f = await setup(t);
  let sessions=0, reads=0;
  const session=f.bridge.host.session, request=f.bridge.room.request;
  f.bridge.host.session=async(...args)=>{
    sessions++;
    return session(...args);
  };
  f.bridge.room.request=async(path,options)=>{
    if(path.includes('/work-result?')) reads++;
    return request(path,options);
  };
  f.recordCompetingVerdict();
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.equal(reads,1);
  assert.equal(sessions,0);
  assert.equal(f.verdict()?.result,'fail');
  assert.deepEqual(f.counts,{prompt:0,write:0,receipt:0,ack:0});
});

// The final reply of the live #6411 exact review on 2026-11-21: prose before
// the JSON and a 1620-character summary. It parked with no attempted write.
const malformed6411 = readFileSync(new URL('./fixtures/room-acp-malformed-review-6411.txt', import.meta.url),'utf8');
const repaired6411 = JSON.stringify({result:'fail',summary:'Head a0fccc9 checked from source: lost-response and race paths hold; a paused member can still have an ACP turn started after the lease, and no test covers it.'});

test('a recorded malformed review is unsupported but repairable; explicit pending and stopped turns are not',()=>{
  assert.equal(reviewOutput({text:malformed6411},'end_turn'),null);
  assert.equal(reviewRepairable({text:malformed6411},'end_turn'),true);
  assert.equal(reviewRepairable({text:malformed6411},'cancelled'),false);
  assert.equal(reviewRepairable({text:JSON.stringify({result:'pending',summary:'No evidence access.'})},'end_turn'),false);
  assert.equal(reviewRepairable({text:'I could not check it.\n\n{"result": "pending", "summary": "No access."}'},'end_turn'),false);
  assert.equal(reviewRepairable({text:'  '},'end_turn'),false);
  assert.equal(reviewRepairable({text:repaired6411},'end_turn'),false);
});

test('a completed review with malformed verdict text gets one same-session repair before any write',async t=>{
  const f = await setup(t,{replies:[malformed6411,repaired6411]});
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.equal(f.verdict()?.result,'fail');
  assert.deepEqual(f.counts,{prompt:2,write:1,receipt:0,ack:1});
  assert.equal(f.prompts[1].prompt,REVIEW_REPAIR_PROMPT);
  assert.equal(f.prompts[1].sessionId,f.prompts[0].sessionId);
  // A redelivered wake after filing starts no turn.
  const restarted = f.make();
  assert.equal(await restarted.lease(),true);
  await restarted.accept(f.wake);
  await restarted.queue.idle();
  assert.equal(f.counts.prompt,2);
  assert.equal(f.counts.write,1);
});

test('a second malformed reply parks after exactly one repair, and the bound survives restart',async t=>{
  const f = await setup(t,{replies:[malformed6411,malformed6411,repaired6411]});
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.deepEqual(f.counts,{prompt:2,write:0,receipt:0,ack:0});
  assert.equal(f.pendingRows().delivered_at,null);
  assert.equal(f.verdict(),undefined);
  const restarted = f.make();
  assert.equal(await restarted.lease(),true);
  await restarted.accept(f.wake);
  await restarted.queue.idle();
  assert.deepEqual(f.counts,{prompt:2,write:0,receipt:0,ack:0});
});

test('explicit pending, prose-wrapped pending and a stopped turn park without a repair prompt',async t=>{
  for (const reply of ['Missing access.\n{"result":"pending","summary":"No evidence access."}',
    {stopReason:'cancelled',recorder:{text:malformed6411}}]) {
    const f = await setup(t,{replies:[reply,repaired6411]});
    await f.bridge.accept(f.wake);
    await f.bridge.queue.idle();
    assert.deepEqual(f.counts,{prompt:1,write:0,receipt:0,ack:0});
    assert.equal(f.verdict(),undefined);
  }
});
