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
  const list = prompt.match(/GET (\S+public-work\/tasks\?\S+)/)[1];
  assert.equal(list, f.origin + '/api/public-work/tasks?roomId=commons&claimable=1&limit=5');
  assert.match(prompt, /After your first useful submission, attempt to connect/);
  assert.match(prompt, /Repeat the claim and submit loop one task at a time/);
  assert.equal((await fetch(f.origin + '/join.txt?room=commons&room=other')).status, 400);
  const browse = async () => {
    const response = await fetch(list);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body.error));
    return body.tasks.map(task => task.taskId);
  };
  assert.deepEqual(await browse(), ['journey:open', 'next-in-commons']);
  for (const room of ['private-without-public-work','missing']) {
    const result = await f.call('GET', `/api/public-work/tasks?roomId=${room}`);
    assert.deepEqual(result.body, {tasks:[],claimableCount:0,nextCursor:null});
  }
  const [a,b] = await Promise.all(['Outside one','Outside two'].map(displayName =>
    f.call('POST','/api/agent-identities',{body:{displayName}}).then(r => r.body.secret)));
  const path = '/api/public-work/tasks/journey%3Aopen';
  const basis = (await f.call('GET',path)).body;
  const input = {requestId:'race-claim',expectedTermsVersion:basis.termsVersion};
  const claims = await Promise.all([a,b].map(secret => f.call('POST',path+'/claim',{secret,body:input})));
  assert.deepEqual(claims.map(r => r.status).sort(), [200,409]);
  const winner = claims.findIndex(r => r.status === 200), secret = [a,b][winner];
  assert.equal(claims[1-winner].body.error.code, 'public_work_claim_conflict');
  const body = {requestId:'race-finish',expectedTermsVersion:basis.termsVersion,generation:claims[winner].body.task.claim.generation,
    artifactText:'One admitted contribution',checksReported:[]};
  const finish = await f.call('POST',path+'/finish',{secret,body});
  assert.equal(finish.status,200);
  const recovered = await f.call('POST',path+'/finish',{secret,body});
  assert.equal(recovered.body.receipt.receiptId,finish.body.receipt.receiptId);
  assert.deepEqual(await browse(), ['next-in-commons']);
  const nextPath = '/api/public-work/tasks/next-in-commons';
  const nextBasis = (await f.call('GET',nextPath)).body;
  const nextClaim = await f.call('POST',nextPath+'/claim',{secret,body:{requestId:'next-claim',expectedTermsVersion:nextBasis.termsVersion}});
  assert.equal(nextClaim.status,200);
  const nextFinish = await f.call('POST',nextPath+'/finish',{secret,body:{requestId:'next-finish',
    expectedTermsVersion:nextBasis.termsVersion,generation:nextClaim.body.task.claim.generation,
    artifactText:'The same outside agent finished the next task',checksReported:[]}});
  assert.equal(nextFinish.status,200);
  assert.notEqual(nextFinish.body.receipt.receiptId,finish.body.receipt.receiptId);
  assert.deepEqual(await browse(), []);
  const fallback = prompt.match(/GET (\S+public-work\/tasks\?roomId=commons&limit=5)/)[1];
  const history = await fetch(fallback).then(r => r.json());
  assert.equal(history.claimableCount,0);
  assert.deepEqual(history.tasks.map(task=>task.taskId), ['journey:open','journey:submitted','next-in-commons']);
  assert.ok(history.tasks.every(task=>task.repositoryUrl==='https://github.com/example/project'));
  assert.match(prompt,/This is a proposal in chat, not a claim or a published issue/);
  assert.equal(await fetch(f.origin + '/join.txt?room=commons').then(r => r.text()), prompt);
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
