// Stranger journey over real HTTP: anonymous discovery -> identity mint ->
// read -> claim -> finish -> receipt + artifact verification.
//
// Guards the 2026-10-05 user-testing p2/p3 contract: the "find work without
// joining" path must surface unclaimed volunteer tasks (not a dead end), and
// tasks in submitted state must be excluded from recommendations while still
// listed for inspection. No existing test walks the full stranger loop with
// receipt byte verification in one flow (public-work-match-http covers match
// mechanics; public-work-claims covers claims; none covers discover->mint->
// claim->finish->receipt->artifact end to end).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
import { unpublishPublic } from '../server/legal-store.mjs';
import { escapeHtml } from '../server/html-escape.mjs';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function seedOffer(store, offerId, { title, criteria, roomId = 'commons', files = ['docs/JOURNEY.md'] }) {
  store.projectOffers.create(roomId, 'owner', { requestId: `journey-create-${offerId}`, offerId,
    reviewerMemberIds: ['owner'],
    terms: { kind: 'task', title, summary: 'Volunteer stranger-journey fixture', acceptanceCriteria: criteria,
      repositoryUrl: 'https://github.com/Example/Project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition(roomId, 'owner', offerId, 'publish', { requestId: `journey-publish-${offerId}`, expectedRevision: 1 });
  store.publicWorkClaims.enable(roomId, 'owner', offerId, { requestId: `journey-enable-${offerId}`,
    expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files });
}

async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom());
  seedOffer(store, 'journey:open', { title: 'Journey fixture open task', criteria: ['Return exact artifact bytes'] });
  seedOffer(store, 'journey:submitted', { title: 'Journey fixture finished task', criteria: ['Already delivered work'] });
  // Put journey:submitted into the terminal submitted state a real delivery leaves.
  const finisher = store.identities.create('Journey finisher');
  const read = store.publicWorkClaims.read('journey:submitted');
  const claimed = store.publicWorkClaims.act('journey:submitted', finisher.secret, 'claim',
    { requestId: 'journey-pre-claim', expectedTermsVersion: read.termsVersion, leaseHours: 1 });
  store.publicWorkClaims.act('journey:submitted', finisher.secret, 'finish',
    { requestId: 'journey-pre-finish', expectedTermsVersion: read.termsVersion, generation: claimed.task.claim.generation,
      artifactText: 'prior delivery', checksReported: ['prior checks'] });
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { secret, body } = {}) => {
    const response = await fetch(origin + path, { method,
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.arrayBuffer() };
  };
  return { store, origin, call };
}

test('anonymous discovery recommends unclaimed volunteer tasks and excludes submitted ones', async t => {
  const f = await fixture(t);
  const match = await f.call('POST', '/api/public-work/match', { body: { interests: ['docs'], limit: 5 } });
  assert.equal(match.status, 200);
  const ids = match.body.recommendations.map(r => r.task.taskId);
  assert.ok(ids.includes('journey:open'), 'unclaimed task is recommended');
  assert.ok(!ids.includes('journey:submitted'), 'submitted task is never recommended');
  assert.deepEqual(match.body.supportedRewards, ['volunteer']);
  const list = await f.call('GET', '/api/public-work/tasks?limit=20');
  assert.equal(list.status, 200);
  const states = Object.fromEntries(list.body.tasks.map(task => [task.taskId, task.claim.state]));
  assert.equal(states['journey:open'], 'unclaimed');
  assert.equal(states['journey:submitted'], 'submitted');
});

test('stranger journey: mint identity, read, claim, finish, verify receipt and artifact bytes', async t => {
  const f = await fixture(t);
  // 1. Stranger mints a global identity with no room membership.
  const minted = await f.call('POST', '/api/agent-identities', { body: { displayName: 'QA-stranger-journey' } });
  assert.equal(minted.status, 201);
  const secret = minted.body.secret;
  assert.ok(typeof secret === 'string' && secret.length > 0, 'mint returns a usable secret');
  // 2. Read the task terms before claiming.
  const taskPath = '/api/public-work/tasks/journey%3Aopen';
  const read = await f.call('GET', taskPath);
  assert.equal(read.status, 200);
  assert.equal(read.body.claim.state, 'unclaimed');
  // 3. Claim with the saved identity.
  const claim = await f.call('POST', taskPath + '/claim', { secret,
    body: { requestId: 'journey-claim', expectedTermsVersion: read.body.termsVersion, leaseHours: 1 } });
  assert.equal(claim.status, 200, JSON.stringify(claim.body).slice(0, 200));
  assert.equal(claim.body.action, 'claimed');
  const generation = claim.body.task.claim.generation;
  // 4. Do the work and submit the artifact.
  const artifactText = 'Stranger contribution: verified journey artifact.\n';
  const finish = await f.call('POST', taskPath + '/finish', { secret,
    body: { requestId: 'journey-finish', expectedTermsVersion: read.body.termsVersion, generation, artifactText, checksReported: ['ran the task checks'] } });
  assert.equal(finish.status, 200, JSON.stringify(finish.body).slice(0, 200));
  assert.equal(finish.body.action, 'submitted');
  const receipt = finish.body.receipt;
  assert.ok(receipt.receiptId.startsWith('pwr_'));
  assert.equal(receipt.artifact.sha256, sha256(artifactText));
  // 5. Verify the receipt and its bytes independently, anonymously.
  const fetched = await f.call('GET', '/api/public-work/receipts/' + receipt.receiptId);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.receiptId, receipt.receiptId);
  const artifact = await f.call('GET', '/api/public-work/receipts/' + receipt.receiptId + '/artifact');
  assert.equal(artifact.status, 200);
  const bytes = Buffer.from(artifact.body).toString('utf8');
  assert.equal(bytes, artifactText);
  assert.equal(sha256(bytes), fetched.body.artifact.sha256);
  // 6. The delivered task leaves the recommendation pool.
  const after = await f.call('POST', '/api/public-work/match', { body: { limit: 5 } });
  assert.equal(after.status, 200);
  assert.ok(!after.body.recommendations.some(r => r.task.taskId === 'journey:open'), 'submitted task leaves recommendations');
});


test('the same project prompt routes outsiders to fresh work and the lease admits only one worker', async t => {
  const f = await fixture(t);
  f.store.initialize(initialRoom('other'));
  f.store.initialize(initialRoom('private-without-public-work'));
  seedOffer(f.store, 'another-room', {roomId:'other', title:'Foreign task', criteria:['Do not pick this']});
  seedOffer(f.store, 'next-in-commons', {title:'Next task', criteria:['Return one result'], files:['docs/NEXT.md']});
  const prompt = await fetch(f.origin + '/join.txt?room=commons').then(r => r.text());
  const pastePage = await fetch(f.origin + '/docs/agents/paste?room=commons');
  assert.equal(pastePage.status, 200);
  assert.equal(pastePage.headers.get('cache-control'), 'no-store');
  const pasteHtml = await pastePage.text();
  assert.match(pasteHtml, /<h1>Contribute to commons<\/h1>/);
  assert.equal(pasteHtml.match(/data-copy-prompt=/g)?.length, 1);
  assert.equal(pasteHtml.match(/<textarea id="agent-paste-prompt-1"[^>]*>([\s\S]*?)<\/textarea>/)?.[1], escapeHtml(prompt));
  assert.equal((await fetch(f.origin + '/docs/agents/paste?room=commons&room=other')).status, 400);
  const list = prompt.match(/GET (\S+public-work\/tasks\?\S+)/)[1];
  assert.equal(list, f.origin + '/api/public-work/tasks?roomId=commons&view=pickup');
  assert.match(prompt, /After your first useful submission, attempt to connect/);
  assert.match(prompt, /public_work_my_review with that receipt ID or GET \/api\/public-work\/receipts\/RECEIPT_ID\/review with the same saved identity/);
  assert.match(prompt, /Repeat the claim and submit loop one task at a time/);
  assert.equal((await fetch(f.origin + '/join.txt?room=commons&room=other')).status, 400);
  const pickup = async () => {
    const response = await fetch(list);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body.error));
    return body;
  };
  const first = await pickup(), [basis] = first.tasks;
  assert.equal(basis.taskId, 'journey:open');
  assert.equal(basis.summary, 'Volunteer stranger-journey fixture');
  assert.deepEqual(basis.acceptanceCriteria, ['Return exact artifact bytes']);
  assert.equal(first.nextCursor, basis.taskId);
  for (const room of ['private-without-public-work','missing']) {
    const result = await f.call('GET', `/api/public-work/tasks?roomId=${room}`);
    assert.deepEqual(result.body, {tasks:[],claimableCount:0,nextCursor:null});
    const pickup = await f.call('GET', `/api/public-work/tasks?roomId=${room}&view=pickup`);
    assert.deepEqual(pickup.body, {...result.body, nextAction:{kind:'no_eligible_public_task'}});
  }
  const [a,b] = await Promise.all(['Outside one','Outside two'].map(displayName =>
    f.call('POST','/api/agent-identities',{body:{displayName}}).then(r => r.body.secret)));
  const path = '/api/public-work/tasks/journey%3Aopen';
  assert.deepEqual(first.nextAction, {kind:'claim',method:'POST',path:path+'/claim',
    body:{expectedTermsVersion:basis.termsVersion},requires:['saved_identity','stable_request_id']});
  const input = {requestId:'race-claim',...first.nextAction.body};
  const claims = await Promise.all([a,b].map(secret => f.call(first.nextAction.method,first.nextAction.path,{secret,body:input})));
  assert.deepEqual(claims.map(r => r.status).sort(), [200,409]);
  const winner = claims.findIndex(r => r.status === 200), secret = [a,b][winner], otherSecret = [a,b][1-winner];
  assert.equal(claims[1-winner].body.error.code, 'public_work_claim_conflict');
  seedOffer(f.store, 'overlapping-paths', {title:'Overlapping task', criteria:['Same path, do not collide']});
  const alternative = await pickup();
  assert.equal(alternative.tasks[0].taskId, 'next-in-commons');
  assert.equal(alternative.claimableCount, 1);
  const body = {requestId:'race-finish',expectedTermsVersion:basis.termsVersion,generation:claims[winner].body.task.claim.generation,
    artifactText:'One admitted contribution',checksReported:[]};
  const finish = await f.call('POST',path+'/finish',{secret,body});
  assert.equal(finish.status,200);
  const recovered = await f.call('POST',path+'/finish',{secret,body});
  assert.equal(recovered.body.receipt.receiptId,finish.body.receipt.receiptId);
  const nextPath = '/api/public-work/tasks/next-in-commons', nextBasis = alternative.tasks[0];
  const nextClaim = await f.call(alternative.nextAction.method,alternative.nextAction.path,{secret:otherSecret,
    body:{requestId:'next-claim',...alternative.nextAction.body}});
  assert.equal(nextClaim.status,200);
  const nextFinish = await f.call('POST',nextPath+'/finish',{secret:otherSecret,body:{requestId:'next-finish',
    expectedTermsVersion:nextBasis.termsVersion,generation:nextClaim.body.task.claim.generation,
    artifactText:'The other outside agent finished the separate task',checksReported:[]}});
  assert.equal(nextFinish.status,200);
  assert.notEqual(nextFinish.body.receipt.receiptId,finish.body.receipt.receiptId);
  const overlap = await pickup();
  assert.equal(overlap.tasks[0].taskId,'overlapping-paths');
  const overlapClaim = await f.call('POST',overlap.nextAction.path,{secret,body:{requestId:'overlap-claim',...overlap.nextAction.body}});
  assert.equal(overlapClaim.status,200);
  assert.deepEqual((await pickup()).tasks, []);
  const fallback = prompt.match(/GET (\S+public-work\/tasks\?roomId=commons&limit=5)/)[1];
  const history = await fetch(fallback).then(r => r.json());
  assert.equal(history.claimableCount,0);
  assert.deepEqual(history.tasks.map(task=>task.taskId), ['journey:open','journey:submitted','next-in-commons','overlapping-paths']);
  assert.ok(history.tasks.every(task=>task.repositoryUrl==='https://github.com/example/project'));
  assert.match(prompt,/This is a proposal in chat, not a claim or a published issue/);
  assert.equal(await fetch(f.origin + '/join.txt?room=commons').then(r => r.text()), prompt);
});



test('the first read-only contribution can use a room’s explicitly published project before any task exists', async t => {
  const f = await fixture(t);
  for (const id of ['new-project', 'other-project']) f.store.initialize(initialRoom(id));
  const create = (roomId, offerId, repositoryUrl, kind = 'project') => f.store.projectOffers.create(roomId, 'owner', {
    requestId: 'create-'+offerId, offerId, reviewerMemberIds: ['owner'],
    terms: { kind, title: 'Project brief', summary: 'Scope is deliberately absent from the prompt', acceptanceCriteria: ['Verify one claim'],
      repositoryUrl, reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } }
  });
  const publish = (roomId, offerId) => f.store.projectOffers.transition(roomId, 'owner', offerId, 'publish', { requestId: 'publish-'+offerId, expectedRevision: 1 });
  create('new-project', 'draft-project', 'https://github.com/example/draft');
  create('new-project', 'bare-task', 'https://github.com/example/task', 'task');
  publish('new-project', 'bare-task');
  create('other-project', 'foreign-project', 'https://github.com/example/foreign');
  publish('other-project', 'foreign-project');
  const read = () => fetch(f.origin+'/join.txt?room=new-project');
  const readBrowser = async room => {
    const response = await fetch(f.origin + '/docs/agents/paste?room=' + room);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return (await response.text()).match(/<textarea id="agent-paste-prompt-1"[^>]*>([\s\S]*?)<\/textarea>/)?.[1];
  };
  const before = await (await read()).text();
  const browserBefore = await readBrowser('new-project');
  assert.equal(browserBefore, escapeHtml(before));
  const unknown = await readBrowser('unknown-room');
  assert.equal(unknown.replaceAll('unknown-room', 'new-project'), browserBefore);
  assert.doesNotMatch(before, /github\.com|Published project repository/);
  assert.match(before, /public-work\/tasks\?roomId=new-project&limit=5/);
  create('new-project', 'public-project', 'https://github.com/example/published');
  publish('new-project', 'public-project');
  assert.deepEqual((await f.call('GET', '/api/public-work/tasks?roomId=new-project')).body.tasks, []);
  const response = await read();
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const prompt = await response.text();
  assert.equal(await readBrowser('new-project'), escapeHtml(prompt));
  assert.match(prompt, /Published project repository for read-only discovery: https:\/\/github\.com\/example\/published/);
  assert.doesNotMatch(prompt, /example\/(draft|foreign|task)|deliberately absent/);
  assert.doesNotMatch(prompt, /public-work\/tasks\?roomId=new-project&limit=5/);
  assert.match(prompt, /view=pickup/);
  const empty = await f.call('GET','/api/public-work/tasks?roomId=new-project&view=pickup');
  const { investigation, ...action } = empty.body.nextAction;
  assert.deepEqual(action, {kind:'inspect_published_repository', repositoryUrl:'https://github.com/example/published',
    project:{id:'public-project',version:1,path:'/api/project-offers/public-project',title:'Project brief',
      summary:'Scope is deliberately absent from the prompt',acceptanceCriteria:['Verify one claim'],
      repositoryUrl:'https://github.com/example/published'}});
  assert.match(investigation, /source revision or URL, check performed, and observed result/);
  const published = await f.call('GET', action.project.path);
  assert.equal(published.status, 200);
  assert.equal(published.body.version, action.project.version);
  assert.match(prompt, /public reads without credentials/);
  unpublishPublic(f.store.db, { kind: 'room', id: 'new-project', byAccount: 'operator', now: Date.now() });
  assert.equal(await (await read()).text(), before);
  assert.equal(await readBrowser('new-project'), browserBefore);
  assert.deepEqual((await f.call('GET','/api/public-work/tasks?roomId=new-project&view=pickup')).body.nextAction,
    {kind:'no_eligible_public_task'});
});

test('dry pickup finds public evidence while respecting cursors, publication and receipt visibility', async t => {
  const f = await fixture(t);
  f.store.projectOffers.create('commons', 'owner', { requestId:'project-create', offerId:'submission-project',
    reviewerMemberIds:['owner'], terms:{ kind:'project', title:'Evidence review', summary:'Investigate a public result',
      acceptanceCriteria:['Reproduce a check'], submissionUrl:'https://example.com/submit',
      reward:{kind:'unpaid'}, approvalPolicy:{mode:'human'} } });
  f.store.projectOffers.transition('commons','owner','submission-project','publish',{requestId:'project-publish',expectedRevision:1});
  const pickup = async (suffix = '') => (await f.call('GET','/api/public-work/tasks?roomId=commons&view=pickup'+suffix)).body;
  const exhausted = await pickup('&after=journey%3Aopen');
  assert.deepEqual(exhausted,{tasks:[],claimableCount:1,nextCursor:null,nextAction:{kind:'pickup_page_exhausted'}});

  const identity = f.store.identities.create('Hold open task');
  f.store.publicWorkClaims.act('journey:open', identity.secret, 'claim', {requestId:'hold',expectedTermsVersion:1});
  const { nextAction } = await pickup();
  assert.equal(nextAction.kind, 'inspect_published_project');
  assert.equal(nextAction.project.submissionUrl,'https://example.com/submit');
  assert.equal(nextAction.repositoryUrl, undefined);
  const receiptId = f.store.publicWorkClaims.read('journey:submitted').claim.submittedReceiptId;
  assert.deepEqual(nextAction.evidenceLead, {taskId:'journey:submitted',title:'Journey fixture finished task',
    receiptId,taskPath:'/api/public-work/tasks/journey%3Asubmitted',receiptPath:'/api/public-work/receipts/'+receiptId});
  for (const path of [nextAction.evidenceLead.taskPath,nextAction.evidenceLead.receiptPath])
    assert.equal((await f.call('GET',path)).status, 200);
  assert.match(nextAction.investigation,/task criteria with its receipt and artifact/);

  f.store.roomDirectory.setReceiptsVisibility('commons','owner',false);
  assert.equal((await pickup()).nextAction.evidenceLead,undefined);
  f.store.roomDirectory.setReceiptsVisibility('commons','owner',true);
  assert.equal((await pickup()).nextAction.evidenceLead.receiptId,receiptId);
  const ownerKey = f.store.issueAccessKey('commons','owner');
  const setRecordedSharing = enabled => f.store.command(ownerKey,'commons',{
    id:'record-sharing-'+enabled, type:'room.public_receipts_set', data:{enabled} });
  setRecordedSharing(false);
  assert.equal((await pickup()).nextAction.evidenceLead,undefined);
  setRecordedSharing(true);
  assert.equal((await pickup()).nextAction.evidenceLead.receiptId,receiptId);
  const submitted = f.store.publicWorkClaims.act('journey:open', identity.secret, 'finish',
    {requestId:'finish-hold',expectedTermsVersion:1,generation:1,artifactText:'New result',checksReported:[]}).receipt;
  assert.equal((await pickup()).nextAction.evidenceLead.receiptId,submitted.receiptId);
  unpublishPublic(f.store.db,{kind:'receipt',id:submitted.receiptId,byAccount:'operator',now:Date.now()});
  assert.equal((await pickup()).nextAction.evidenceLead.receiptId,receiptId);
  const offer = f.store.projectOffers.read('journey:submitted');
  f.store.projectOffers.transition('commons','owner',offer.id,'withdraw',{requestId:'withdraw-submitted',expectedRevision:offer.revision});
  assert.equal((await pickup()).nextAction.evidenceLead,undefined);
});

test('a member and an outside agent contend for the same published lease', async t => {
  const f = await fixture(t);
  const owner = f.store.issueAccessKey('commons','owner');
  const mint = async displayName => {
    const result = await f.call('POST','/api/agent-identities',{body:{displayName}});
    assert.equal(result.status,201);
    return result.body;
  };
  const [member,outside] = await Promise.all([mint('Existing member'),mint('First contribution')]);
  linkWithProof(f.store,owner,'commons',member,{permissions:[]});
  assert.ok(f.store.authenticate(member.secret,'commons').member.id);
  const prompt = await fetch(f.origin+'/join.txt?room=commons').then(r => r.text());
  assert.match(prompt,/If no eligible Room work is ready, check the published tasks below/);
  assert.match(prompt,/both admitted and outside agents use the same public claim/);
  const listPath = '/api/public-work/tasks?roomId=commons&claimable=1';
  const lists = await Promise.all([member,outside].map(({secret}) => f.call('GET',listPath,{secret})));
  assert.deepEqual(lists[0].body.tasks,lists[1].body.tasks);
  const task = lists[0].body.tasks[0];
  assert.equal(task.taskId,'journey:open');
  const path = '/api/public-work/tasks/'+encodeURIComponent(task.taskId);
  const claimBody = {requestId:'shared-claim',expectedTermsVersion:task.termsVersion};
  const outcomes = await Promise.all([member,outside].map(({secret}) => f.call('POST',path+'/claim',{secret,body:claimBody})));
  assert.deepEqual(outcomes.map(o => o.status).sort(),[200,409]);
  const winner = outcomes.findIndex(o => o.status===200), holder = [member,outside][winner];
  const loser = [member,outside][1-winner];
  const finishBody = {requestId:'shared-finish',expectedTermsVersion:task.termsVersion,generation:outcomes[winner].body.task.claim.generation,
    artifactText:'Evidence from the sole claim holder',checksReported:[]};
  assert.equal((await f.call('POST',path+'/finish',{secret:loser.secret,body:finishBody})).status,403);
  const finished = await f.call('POST',path+'/finish',{secret:holder.secret,body:finishBody});
  assert.equal(finished.status,200);
  assert.equal(finished.body.receipt.artifact.sha256,sha256(finishBody.artifactText));
});


test('admission preserves the original outside lease and does not require a second claim', async t => {
  const f = await fixture(t);
  const minted = await f.call('POST','/api/agent-identities',{body:{displayName:'Joining contributor'}});
  assert.equal(minted.status,201);
  const {secret} = minted.body;
  const path = '/api/public-work/tasks/journey%3Aopen';
  const task = (await f.call('GET',path)).body;
  const body = {requestId:'claim-before-admission',expectedTermsVersion:task.termsVersion};
  const before = await f.call('POST',path+'/claim',{secret,body});
  assert.equal(before.status,200);
  const owner = f.store.issueAccessKey('commons','owner');
  linkWithProof(f.store,owner,'commons',minted.body,{permissions:[]});
  assert.ok(f.store.authenticate(secret,'commons').member.id);
  const recovered = await f.call('POST',path+'/claim',{secret,body});
  assert.equal(recovered.status,200);
  assert.equal(recovered.body.task.claim.generation,before.body.task.claim.generation);
  assert.equal(recovered.body.task.claim.identityId,before.body.task.claim.identityId);
  const finish = await f.call('POST',path+'/finish',{secret,body:{requestId:'finish-after-admission',
    expectedTermsVersion:task.termsVersion,generation:before.body.task.claim.generation,artifactText:'Same contributor, same lease',checksReported:[]}});
  assert.equal(finish.status,200);
  assert.equal(finish.body.receipt.artifact.sha256,sha256('Same contributor, same lease'));
});
