import test from 'node:test';
import assert from 'node:assert/strict';
import { setTier } from '../server/autonomy-tiers.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { openRequestJournal, runRequestOnce } from '../client/request-runner.mjs';
import { buildBrowserFailureWork } from '../scripts/browser-failure-work.mjs';
import { previewDevelopmentLoop, submitDevelopmentLoop, linkDevelopmentEvidence } from '../scripts/development-loop.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
async function fixture(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  f.store.command(f.keys.owner,'commons',{id:'add-coordinator',type:'member.added',data:{memberId:'coordinator',displayName:'Coordinator',kind:'agent',permissions:['steer'],accountableHumanId:'owner'}});
  setTier(f.store.db,'commons','coordinator','t2_standard',{updatedBy:'owner',nowMs:f.store.now()});
  f.keys.coordinator=f.store.issueAccessKey('commons','coordinator');
  for (const [a,b] of [['coordinator','producer'],['producer','coordinator']]) { f.store.dmConsents.request('commons',a,b,'fixture'); f.store.dmConsents.decide('commons',b,a,'approve'); }
  const connection = { version: 1, origin: `http://127.0.0.1:${server.address().port}`, roomId: 'commons', memberId: 'coordinator', token: f.keys.coordinator };
  const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const revision = git(['rev-parse','HEAD']), tree = git(['rev-parse','HEAD^{tree}']);
  const script = 'scripts/action-recovery-browser-check.mjs', name = 'Synthetic reproduction selection';
  const receiptPath = join(f.directory,'shard.json'), junitPath = join(f.directory,'junit.xml');
  writeFileSync(receiptPath, JSON.stringify({ revision, runId:'run',runAttempt:'1',index:1,total:6,planHash:'a'.repeat(64),status:1,signal:null,files:[script] }));
  writeFileSync(junitPath, `<testsuites><testsuite><testcase file="${script}" name="${name}"><failure message="failed"/></testcase></testsuite></testsuites>`);
  const options = { checkout:process.cwd(),repo:'Uuriko/project-room',revision,tree,runId:'run',runAttempt:'1',receipt:receiptPath,junit:junitPath,sourceRoot:process.cwd(),accountableMember:'producer' };
  const packet = buildBrowserFailureWork(options), packetBytes = Buffer.from(JSON.stringify(packet));
  const config = { ...connection, token:undefined, checkout:process.cwd(),sourceRoot:process.cwd(),failureId:packet.failures[0].id,recipientId:'producer' };
  const evidence = { receiptPath,junitPath }, plan = previewDevelopmentLoop(packetBytes,config,evidence);
  return { ...f,connection,packet,packetBytes,config,evidence,plan,client:new RoomAgentClient(connection) };
}
test('actual HTTP bridge retries unknown proposal and request receipts without duplicate work; journal replays saved answer', async t => {
  const f = await fixture(t); let loseWork=true,loseReply=true;
  const lossy = { workContext:(...a)=>f.client.workContext(...a),replyContext:(...a)=>f.client.replyContext(...a),
    workAction:async (...a)=>{const r=await f.client.workAction(...a);if(loseWork){loseWork=false;throw new Error('Lost work response');}return r;},
    replyAction:async (...a)=>{const r=await f.client.replyAction(...a);if(loseReply){loseReply=false;throw new Error('Lost request response');}return r;} };
  await assert.rejects(submitDevelopmentLoop(f.plan,f.connection,lossy),/Lost work/);
  await assert.rejects(submitDevelopmentLoop(f.plan,f.connection,lossy),/Lost request/);
  const result=await submitDevelopmentLoop(f.plan,f.connection,lossy);
  assert.equal(result.currentStateVerified,true);assert.equal(result.actionsPerformed.completed,false);
  const state=f.store.room('commons').state;
  assert.equal(Object.values(state.workItems).filter(w=>w.id===f.plan.proposal.workItemId).length,1);
  assert.equal(state.workItems[f.plan.proposal.workItemId].state,'proposed');
  assert.equal(Object.values(state.replyRequests).filter(r=>r.id===f.plan.requestMessageId).length,1);
  const db=openRequestJournal(join(f.directory,'journal.sqlite'));t.after(()=>db.close());let executions=0;
  const args={connection:{...f.connection,memberId:'producer',token:f.keys.producer},requestMessageId:f.plan.requestMessageId,db,execute:async()=>{executions++;return {body:'Reproduction evidence retained; not completion.'};}};
  await runRequestOnce(args);await runRequestOnce(args);assert.equal(executions,1);
  assert.equal(f.store.room('commons').state.workItems[f.plan.proposal.workItemId].state,'proposed');
});
test('preview refuses changed packet evidence and existing work with another accountable member', async t => {
  const f=await fixture(t);const altered=structuredClone(f.packet);altered.failures[0].testName='Invented test';
  assert.throws(()=>previewDevelopmentLoop(Buffer.from(JSON.stringify(altered)),f.config,f.evidence),/revalidated/);
  await f.client.workAction('room_propose_work',{...f.plan.proposal,accountableMemberId:'owner'});
  const linked=previewDevelopmentLoop(f.packetBytes,{...f.config,existingWorkItemId:f.plan.proposal.workItemId},f.evidence);
  await assert.rejects(submitDevelopmentLoop(linked,f.connection),/accountable/);
  assert.equal(Object.values(f.store.room('commons').state.replyRequests ?? {}).filter(r=>r.id===linked.requestMessageId).length,0);
});
test('evidence links exact test/source/stdout and leaves a different release revision unproven', async t => {
  const {plan}=await fixture(t), stdout=Buffer.from(`TAP version 13\nok 1 - ${plan.failure.testName}\n# pass 1\n# fail 0\n`);
  const receipt={version:1,kind:'browser-reproduction',packetId:plan.failure.id,exitCode:0,observedOutcome:'passed',packetSha256:plan.packetSha256,workItemId:plan.proposal.workItemId,requestMessageId:plan.requestMessageId,
    revision:plan.source.revision,tree:plan.source.tree,script:plan.failure.script,testName:plan.failure.testName,stdoutSha256:hash(stdout),stdoutBytes:stdout.length,outcome:'passed'};
  const release={schemaVersion:1,id:'a'.repeat(64),target:{repository:plan.source.repo,revision:'b'.repeat(40),tree:'c'.repeat(40)},attempts:[]};
  release.id=hash(JSON.stringify(release.target));
  const linked=linkDevelopmentEvidence(plan,Buffer.from(JSON.stringify(receipt)),stdout,Buffer.from(JSON.stringify(release)));
  assert.equal(linked.conclusions.fixed,'not-established');assert.match(linked.release.relation,/unproven/);
  for(const patch of [{testName:'other'},{revision:'d'.repeat(40)},{packetSha256:'0'.repeat(64)},{workItemId:'other'}])
    assert.throws(()=>linkDevelopmentEvidence(plan,Buffer.from(JSON.stringify({...receipt,...patch})),stdout),/binding/);
  assert.throws(()=>linkDevelopmentEvidence(plan,Buffer.from(JSON.stringify(receipt)),Buffer.from('wrong')),/output evidence/);
  const failed=Buffer.from(`not ok 1 - ${plan.failure.testName}\n# fail 1\n`);
  assert.throws(()=>linkDevelopmentEvidence(plan,Buffer.from(JSON.stringify({...receipt,exitCode:1,stdoutSha256:hash(failed),stdoutBytes:failed.length})),failed),/Contradictory/);
});
