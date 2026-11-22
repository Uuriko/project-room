import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {rmSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createAcceptanceFixture} from '../scripts/acceptance-fixture.mjs';
import {createRoomServer} from '../server/http.mjs';
import {textVersion} from '../server/text-results.mjs';
import {Bridge} from '../room-acp/src/bridge.mjs';
import {RoomError} from '../room-acp/src/room.mjs';
import {reviewOutput, reviewRepairable, explicitVerdict, unfencedJson, repeatedTopLevelKey, REVIEW_REPAIR_PROMPT} from '../room-acp/src/review-wake.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';

async function setup(t, {respondTo, reviewScope, pending = false, nextAction, replies = [], observeStage} = {}) {
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
    const bridge = new Bridge({connection,respondTo,reviewScope,observeStage,waitMs:0,env:{ROOM_ACP_HOME:join(f.directory,'acp-host')},host:{
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
  const receipt = () => bridge.reviewReceipts.read(bridge.reviewReceipts.key(wake.signalId));
  return {bridge,wake,counts,prompts,make,receipt,receiptPhase:()=>receipt()?.phase,verdict,pendingRows,recordCompetingVerdict,correctionSignals,readAsProducer};
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
  const f = await setup(t,{reviewScope:{requesterId:'owner',openedAfter:0}});
  const request = f.bridge.room.request;
  const reads = [];
  f.bridge.room.request = async(path,options)=>{
    if (path.includes('/work-context') || path.includes('/work-result')) reads.push(path.split('?')[0]);
    const response = await request(path,options);
    if (options?.body?.type==='verification.recorded') throw new RoomError(0,'network','Committed response lost');
    return response;
  };
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.equal(f.verdict()?.result,'pass');
  assert.deepEqual(reads,['/api/rooms/commons/work-result']);
  assert.deepEqual(f.counts,{prompt:1,write:1,receipt:1,ack:1});
  const restarted = f.make();
  assert.equal(await restarted.lease(),true);
  await restarted.accept(f.wake);
  await restarted.queue.idle();
  assert.deepEqual(f.counts,{prompt:1,write:1,receipt:1,ack:2});
});

test('exact review prompt separates earlier correction from current evidence',async t=>{
  const f = await setup(t);
  const correction = { completionEventId:'prior-result', summary:'The prior result is stale.' };
  const releaseChecks = { status:'passed', checks:[{ name:'build' }] };
  const read = f.bridge.room.request;
  f.bridge.room.request = async (path,options) => {
    const value = await read(path,options);
    if (path.includes('/work-result')) {
      Object.assign(value.workThread, { correction, releaseChecks });
    }
    return value;
  };
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  const [{ text }] = f.prompts[0].prompt;
  const context = JSON.parse(text.split('\n\n').at(-1));
  assert.equal(context.currentResult.receipt.eventId, f.wake.completionEventId);
  assert.deepEqual(context.correctionToPriorResult, correction);
  assert.deepEqual(context.releaseChecks, releaseChecks);
  assert.equal(context.workThread, undefined);
});

test('the scope check refuses ineligible or incomplete origin facts without contacting the model',async t=>{
  for (const [label,reviewScope,changeOrigin] of [
    ['different requester',{requesterId:'another-member',openedAfter:0}],
    ['earlier proposal',{requesterId:'owner',openedAfter:Date.now()+60_000}],
    ['legacy response',{requesterId:'owner',openedAfter:0},()=>undefined],
    ['missing requester in both records',{openedAfter:0},origin=>({...origin,proposedById:undefined})],
    ['write mode',{requesterId:'owner',openedAfter:0},origin=>({...origin,mode:'write'})],
    ['no independent verification',{requesterId:'owner',openedAfter:0},origin=>({...origin,independentVerificationRequired:false})],
  ]) {
    await t.test(label,async t=>{
      const f = await setup(t,{reviewScope});
      const exact = await f.bridge.room.request('/api/rooms/commons/work-result?'+new URLSearchParams({
        workItemId:f.wake.workItemId,completionEventId:f.wake.completionEventId,
      }));
      assert.equal(exact.review.origin.proposedById,'owner');
      assert.equal(exact.review.action.tool,'room_record_verification');
      const producer = await f.readAsProducer(f.wake.nextRead);
      assert.equal(producer.review,undefined);
      if (changeOrigin) {
        const request = f.bridge.room.request;
        f.bridge.room.request = async(path,options)=>{
          const value = await request(path,options);
          if (path.includes('/work-result')) value.review.origin = changeOrigin(value.review.origin);
          return value;
        };
      }
      await f.bridge.accept(f.wake);
      await f.bridge.queue.idle();
      assert.equal(f.verdict(),undefined);
      assert.deepEqual(f.counts,{prompt:0,write:0,receipt:0,ack:0});
    });
  }
});

test('a durable exact review claim and first provider output appear before the verdict', async t => {
  const f = await setup(t);
  const reports = new Map();
  const request = f.bridge.reviewRuntimeRoom.request.bind(f.bridge.reviewRuntimeRoom);
  f.bridge.reviewRuntimeRoom.request = (path, options) => {
    const result = request(path, options);
    reports.set(options.body.phase, { input: options.body, result });
    return result;
  };
  const prompt = f.bridge.host.prompt;
  f.bridge.host.prompt = async (key, payload, options) => {
    assert.equal(f.receiptPhase(), 'started');
    assert.equal((await reports.get('claimed').result).status, 'claimed');
    options.onDispatched();
    assert.equal(reports.has('started'), false, 'Dispatch alone does not confirm provider output');
    options.onFirstOutput('text');
    assert.equal((await reports.get('started').result).status, 'started');
    assert.equal(reports.get('claimed').input.attemptId, reports.get('started').input.attemptId);
    assert.equal(reports.get('started').input.completionEventId, f.wake.completionEventId);
    assert.equal(f.verdict(), undefined);
    assert.equal(f.pendingRows().delivered_at, null);
    return prompt(key, payload, options);
  };
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.equal(f.verdict()?.result, 'pass');
  assert.deepEqual(f.counts, {prompt:1, write:1, receipt:0, ack:1});
});

test('a rate-limited progress report does not pause or repeat the verdict', async t => {
  const f = await setup(t);
  const got = [];
  f.bridge.reviewRuntimeRoom.request = async (path, options) => {
    got.push(options.body.phase);
    throw new RoomError(429, 'rate_limited', 'Progress write rate limited', 120);
  };
  const prompt = f.bridge.host.prompt;
  f.bridge.host.prompt = (key, payload, options) => {
    options.onFirstOutput('text');
    return prompt(key, payload, options);
  };
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.deepEqual(got, ['claimed', 'started']);
  assert.equal(f.verdict()?.result, 'pass');
  assert.deepEqual(f.counts, {prompt:1, write:1, receipt:0, ack:1});
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

test('a parked review keeps a coarse disposition and local timing without filing a verdict', async t => {
  for (const [reply, reason] of [
    ['{"result":"pending","summary":"Private text is not telemetry."}', 'explicit_pending'],
    ['The evidence is incomplete.', 'unsupported_output'],
    ['', 'no_output'],
    [{stopReason:'cancelled',recorder:{text:'Late data is not a verdict.'}}, 'turn_not_completed'],
  ]) {
    const phases = [];
    const f = await setup(t, { replies: [reply], observeStage: event => phases.push(event) });
    await f.bridge.accept(f.wake);
    await f.bridge.queue.idle();
    assert.equal(f.receipt().phase, 'needs_review');
    assert.equal(f.receipt().reason, reason);
    assert.deepEqual(phases.filter(row => row.stage.startsWith('review_')).map(row => row.stage),
      ['review_prompt_returned', 'review_parked']);
    assert.doesNotMatch(JSON.stringify(f.receipt()) + JSON.stringify(phases), /Private text|evidence is incomplete|Late data/);
    assert.equal(f.verdict(), undefined);
    assert.equal(f.pendingRows().delivered_at, null);
    assert.deepEqual(f.counts, {prompt:1, write:0, receipt:0, ack:0});
  }
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

test('the recorded #6411 reply is byte-exact and states one explicit fail with an over-limit summary',()=>{
  // Pinned to the fixture as first published on this branch (6de84bdd3).
  assert.equal(createHash('sha256').update(malformed6411).digest('hex'),'539d092df623d56806d4c816b184eb6289da7a36dc62d813daa83a420fb72f0e');
  const json = JSON.parse(malformed6411.slice(malformed6411.indexOf('{')));
  assert.equal(json.result,'fail');
  assert.equal(json.summary.length > 1500,true);
  assert.equal(explicitVerdict({text:malformed6411}),'fail');
  assert.equal(explicitVerdict({text:'Looks fine to me.'}),null);
});

test('the initial review prompt states the summary and nextAction limits',async t=>{
  const f = await setup(t);
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.match(f.prompts[0].prompt[0].text,/summary at most 1500 characters/);
  assert.match(f.prompts[0].prompt[0].text,/nextAction at most 1000 characters/);
});

test('the repair prompt asks for a compact restatement of the same verdict',()=>{
  const text = REVIEW_REPAIR_PROMPT[0].text;
  assert.equal(REVIEW_REPAIR_PROMPT.length,1);
  assert.match(text,/Preserve the verdict you already reached/);
  assert.match(text,/only raw JSON: \{"result":"pass"\|"fail","summary":"\.\.\."\} with no other text/);
  assert.match(text,/only the exact candidate, the smallest decisive evidence supporting that verdict, and any verification limits/);
  assert.match(text,/Aim for 600 characters and keep the summary at most 1500 characters/);
  assert.match(text,/Omit unrelated checks and use short verbatim excerpts where useful/);
  assert.match(text,/nextAction is allowed only on fail and must be at most 1000 characters/);
  assert.match(text,/Do not run new checks, add claims, or change the verdict/);
  assert.match(text,/answer \{"result":"pending","summary":"\.\.\."\}/);
});

test('a recorded malformed review is unsupported but repairable; explicit pending and stopped turns are not',()=>{
  assert.equal(reviewOutput({text:malformed6411},'end_turn'),null);
  assert.equal(reviewRepairable({text:malformed6411},'end_turn'),true);
  assert.equal(reviewRepairable({text:malformed6411},'cancelled'),false);
  assert.equal(reviewRepairable({text:JSON.stringify({result:'pending',summary:'No evidence access.'})},'end_turn'),false);
  assert.equal(reviewRepairable({text:'I could not check it.\n\n{"result": "pending", "summary": "No access."}'},'end_turn'),false);
  assert.equal(reviewRepairable({text:'  '},'end_turn'),false);
  assert.equal(reviewRepairable({text:repaired6411},'end_turn'),false);
  // Both explicit verdicts in one reply is ambiguous: park, do not repair.
  assert.equal(reviewRepairable({text:'First {"result":"pass","summary":"a"} then {"result":"fail","summary":"b"}'},'end_turn'),false);
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

test('negative control: a repair that says pass after an explicit fail is not filed and parks',async t=>{
  const flipped = JSON.stringify({result:'pass',summary:'Head a0fccc9 checked from source; all paths hold.'});
  const f = await setup(t,{replies:[malformed6411,flipped]});
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.deepEqual(f.counts,{prompt:2,write:0,receipt:0,ack:0});
  assert.equal(f.prompts[1].prompt,REVIEW_REPAIR_PROMPT);
  assert.equal(f.verdict(),undefined);
  assert.equal(f.pendingRows().delivered_at,null);
  assert.equal(f.receiptPhase(),'needs_review');
  const restarted = f.make();
  assert.equal(await restarted.lease(),true);
  await restarted.accept(f.wake);
  await restarted.queue.idle();
  assert.deepEqual(f.counts,{prompt:2,write:0,receipt:0,ack:0});
});

test('a reply that states both pass and fail parks without a repair prompt',async t=>{
  const f = await setup(t,{replies:['Earlier {"result":"pass","summary":"a"}; now {"result":"fail","summary":"b"}',repaired6411]});
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.deepEqual(f.counts,{prompt:1,write:0,receipt:0,ack:0});
  assert.equal(f.verdict(),undefined);
  assert.equal(f.receiptPhase(),'needs_review');
});

// Fresh Claude Haiku reformats of the #6411 reply (2026-11-21, four runs, two
// prompt orders) each returned exactly one ```json fence around otherwise
// valid JSON. This fixture has the same shape with a within-limit summary.
const fence = body => '```json\n' + body + '\n```';
const fenced6411 = fence(JSON.stringify(JSON.parse(repaired6411),null,2));

test('first pass: exactly one whole-message JSON fence is formatting, anything else stays strict',()=>{
  assert.equal(reviewOutput({text:fenced6411},'end_turn')?.result,'fail');
  assert.equal(reviewOutput({text:'\n```\n' + repaired6411 + '\n```\n'},'end_turn')?.result,'fail');
  assert.equal(reviewOutput({text:'```JSON\r\n' + repaired6411 + '\r\n```'},'end_turn')?.result,'fail');
  assert.equal(reviewOutput({text:fenced6411},'cancelled'),null);
  for (const text of [
    'Verdict:\n' + fenced6411,                      // prose before
    fenced6411 + '\nThanks.',                       // prose after
    fenced6411 + '\n' + fenced6411,                 // two blocks
    fence(repaired6411 + '\n```\n```json\n' + repaired6411), // nested second block
    fence('{"result":"fail","summary":"x"'),        // malformed JSON
    fence(JSON.stringify({result:'pending',summary:'No access.'})),
    fence(JSON.stringify({result:'fail',summary:'x'.repeat(1501)})),
    fence(JSON.stringify({result:'fail',summary:'x',nextAction:'y'.repeat(1001)})),
    fence(JSON.stringify({result:'pass',summary:'x',nextAction:'y'})),
    fence(JSON.stringify({result:'fail',summary:'x',extra:1})),
    '```js\n' + repaired6411 + '\n```',            // other language tag
    '```' + repaired6411 + '```',                    // inline fence
  ]) assert.equal(reviewOutput({text},'end_turn'),null,text);
  assert.equal(unfencedJson(42),42);
  // A fenced pending is still explicit pending, so it is not repaired.
  assert.equal(reviewRepairable({text:fence(JSON.stringify({result:'pending',summary:'No access.'}))},'end_turn'),false);
  assert.equal(reviewRepairable({text:fenced6411},'end_turn'),false);
});

test('first pass: a fenced verdict files without any repair prompt',async t=>{
  const f = await setup(t,{replies:[fenced6411,repaired6411]});
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.equal(f.verdict()?.result,'fail');
  assert.deepEqual(f.counts,{prompt:1,write:1,receipt:0,ack:1});
});

test('first pass: a fenced over-limit summary is still repaired once, not filed',async t=>{
  const long = fence(JSON.stringify({result:'fail',summary:'x'.repeat(1620)}));
  const f = await setup(t,{replies:[long,fenced6411]});
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.equal(f.prompts[1].prompt,REVIEW_REPAIR_PROMPT);
  assert.equal(f.verdict()?.result,'fail');
  assert.deepEqual(f.counts,{prompt:2,write:1,receipt:0,ack:1});
});

test('repair: the #6411 reply then a fenced restated fail files after exactly one repair',async t=>{
  const f = await setup(t,{replies:[malformed6411,fenced6411]});
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.equal(f.prompts[1].prompt,REVIEW_REPAIR_PROMPT);
  assert.equal(f.verdict()?.result,'fail');
  assert.deepEqual(f.counts,{prompt:2,write:1,receipt:0,ack:1});
});

test('repair: fenced replies that reverse, add prose, repeat blocks, are malformed, pending or over limit park unfiled',async t=>{
  for (const reply of [
    fence(JSON.stringify({result:'pass',summary:'All paths hold.'})),
    'Here it is:\n' + fenced6411,
    fenced6411 + '\n' + fenced6411,
    fence('{"result":"fail",'),
    fence(JSON.stringify({result:'pending',summary:'Not verified.'})),
    fence(JSON.stringify({result:'fail',summary:'x'.repeat(1501)})),
  ]) {
    const f = await setup(t,{replies:[malformed6411,reply,fenced6411]});
    await f.bridge.accept(f.wake);
    await f.bridge.queue.idle();
    assert.deepEqual(f.counts,{prompt:2,write:0,receipt:0,ack:0},reply);
    assert.equal(f.verdict(),undefined);
    assert.equal(f.receiptPhase(),'needs_review');
  }
});

test('no single explicit verdict: a prose hold or a verdict only in words parks with no repair prompt',async t=>{
  const holds = [
    'HOLD: insufficient evidence. I could not run the tests and reached no verdict.',
    'Looks like a pass to me, but I did not check everything.',
    fence('{"result":"PASS","summary":"x"}'),
    '{"summary":"No verdict."}',
  ];
  for (const reply of holds) {
    assert.equal(reviewRepairable({text:reply},'end_turn'),false,reply);
    const f = await setup(t,{replies:[reply,JSON.stringify({result:'pass',summary:'Repaired into a pass.'})]});
    await f.bridge.accept(f.wake);
    await f.bridge.queue.idle();
    assert.deepEqual(f.counts,{prompt:1,write:0,receipt:0,ack:0},reply);
    assert.equal(f.verdict(),undefined);
    assert.equal(f.receiptPhase(),'needs_review');
  }
  // The #6411 reply states exactly one fail, so it remains repairable.
  assert.equal(reviewRepairable({text:malformed6411},'end_turn'),true);
});

// JSON.parse keeps the last repeated key, so a duplicate field could turn a
// stated fail into a filed pass. Raw, fenced and escape-spelled duplicates of
// any top-level field are not verdicts and park before any repair prompt.
const duplicateRecords = [
  '{"result":"fail","summary":"Pause path fails.","result":"pass"}',
  '{"result":"pass","result":"pass","summary":"Same value twice."}',
  '{"result":"fail","summary":"Pause path fails.","\\u0072esult":"pass"}',
  '{"resul\\u0074":"fail","summary":"a","summary":"b"}',
  '{"result":"fail","summary":"a","\\u0073ummary":"b"}',
  '{"result":"fail","summary":"a","nextAction":"run x","next\\u0041ction":"run y"}',
  '{ "result" : "fail" , "summary" : "a" ,\n  "result"\n:\n"pass" }',
];

test('a repeated top-level field, raw, fenced or JSON-escaped, is never a verdict',()=>{
  for (const record of duplicateRecords) {
    assert.equal(repeatedTopLevelKey(record),true,record);
    assert.equal(reviewOutput({text:record},'end_turn'),null,record);
    assert.equal(reviewOutput({text:fence(record)},'end_turn'),null,record);
    assert.equal(reviewRepairable({text:record},'end_turn'),false,record);
    assert.equal(reviewRepairable({text:fence(record)},'end_turn'),false,record);
  }
});

test('a valid summary that quotes or escapes field names is still one verdict',()=>{
  const quoting = [
    JSON.stringify({result:'fail',summary:'The reply repeated "result":"pass" after "result":"fail" and "summary":"x".'}),
    '{"result":"pass","summary":"Escaped key \\"\\u0072esult\\": \\"fail\\" and a backslash \\\\\\" stay inside this string."}',
    JSON.stringify({result:'fail',summary:'Nested-looking text {"result":"pass","result":"fail"} is evidence.',nextAction:'Send {"summary":"a","summary":"b"} and expect a park.'}),
  ];
  for (const record of quoting) {
    assert.equal(repeatedTopLevelKey(record),false,record);
    assert.ok(reviewOutput({text:record},'end_turn'),record);
    assert.ok(reviewOutput({text:fence(record)},'end_turn'),record);
  }
  // A JSON-escaped key with no repeat is the same field and still files.
  assert.deepEqual(reviewOutput({text:'{"\\u0072esult":"fail","summary":"a"}'},'end_turn'),{result:'fail',summary:'a'});
});

test('first pass: a duplicate-field record parks with no repair prompt and no verdict write',async t=>{
  for (const record of [duplicateRecords[0],fence(duplicateRecords[2]),duplicateRecords[1]]) {
    const f = await setup(t,{replies:[record,repaired6411]});
    await f.bridge.accept(f.wake);
    await f.bridge.queue.idle();
    assert.deepEqual(f.counts,{prompt:1,write:0,receipt:0,ack:0},record);
    assert.equal(f.verdict(),undefined);
    assert.equal(f.receiptPhase(),'needs_review');
  }
});

test('repair: a duplicate-field restatement, raw or fenced, is not filed',async t=>{
  for (const reply of ['{"result":"fail","summary":"a","\\u0072esult":"fail"}',fence('{"result":"fail","summary":"a","summary":"b"}')]) {
    const f = await setup(t,{replies:[malformed6411,reply,repaired6411]});
    await f.bridge.accept(f.wake);
    await f.bridge.queue.idle();
    assert.deepEqual(f.counts,{prompt:2,write:0,receipt:0,ack:0},reply);
    assert.equal(f.verdict(),undefined);
    assert.equal(f.receiptPhase(),'needs_review');
  }
});

test('a fresh receiver resumes the same claim after session preparation stops', async t => {
  const f = await setup(t);
  const claims = [];
  function observe(bridge) {
    const request = bridge.reviewRuntimeRoom.request.bind(bridge.reviewRuntimeRoom);
    bridge.reviewRuntimeRoom.request = (path, options) => {
      const response = request(path, options);
      if (options.body.phase === 'claimed') claims.push({ id: options.body.attemptId, response });
      return response;
    };
  }
  observe(f.bridge);
  f.bridge.host.session = async () => {
    assert.equal((await claims[0].response).status, 'claimed');
    throw Error('receiver stopped while preparing the session');
  };
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.equal(claims.length, 1);
  assert.equal(f.counts.prompt, 0);
  assert.throws(f.receipt, { code: 'ENOENT' });
  assert.equal((await f.readAsProducer(f.wake.nextRead)).reviewRuntime.status, 'claimed');

  const fresh = f.make();
  observe(fresh);
  const prepare = fresh.host.session.bind(fresh.host);
  fresh.host.session = async (...args) => {
    assert.deepEqual(await claims[1].response, await claims[0].response);
    return prepare(...args);
  };
  assert.equal(await fresh.lease(), true);
  await fresh.accept(f.wake);
  await fresh.queue.idle();
  assert.equal(claims.length, 2);
  assert.equal(claims[1].id, claims[0].id);
  assert.equal(f.receipt().requestId, claims[0].id);
  assert.deepEqual(f.counts, {prompt:1,write:1,receipt:0,ack:1});
  assert.equal(f.verdict().result, 'pass');
});

test('restart surfaces a review interrupted before output and never runs it twice', async t => {
  const f = await setup(t);
  f.bridge.host.prompt = async () => { f.counts.prompt++; throw Error('host stopped'); };
  await f.bridge.accept(f.wake);
  await f.bridge.queue.idle();
  assert.equal(f.receiptPhase(), 'started');
  const fresh = f.make();
  assert.equal(await fresh.lease(), true);
  await fresh.accept(f.wake);
  await fresh.queue.idle();
  assert.equal(f.receipt()?.reason, 'turn_interrupted');
  assert.deepEqual(f.counts, {prompt:1,write:0,receipt:0,ack:0});
  assert.equal(f.pendingRows().delivered_at, null);
  const exact = await f.readAsProducer(f.wake.nextRead);
  assert.equal(exact.reviewRuntime.status, 'interrupted');

  // A replacement runtime may have the seat and lease but lose its local disk.
  const receipts = fresh.reviewReceipts;
  rmSync(join(receipts.dir, receipts.key(f.wake.signalId) + '.json'));
  const replacement = f.make();
  assert.equal(await replacement.lease(), true);
  await replacement.accept(f.wake);
  await replacement.queue.idle();
  assert.deepEqual(f.counts, {prompt:1,write:0,receipt:0,ack:0});
  assert.equal(f.pendingRows().delivered_at, null);
});
