import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Setup and raw observation are the only fixture routes. Every contribution,
// decision and follow-up traverses the production HTTP/MCP bridge in workerd.
const fixture = `
import entry, { ProjectRoom } from './room.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
export class SuccessorTestRoom extends ProjectRoom {
 async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/__successor/setup' && request.method === 'POST') {
   this.store.initialize(initialRoom());
   this.store.initialize(initialRoom('other'));
   const terms = {kind:'task',title:'Return a checked volunteer artifact',summary:'Public fixture instructions',acceptanceCriteria:['Preserve exact UTF-8 bytes'],exclusions:['No money operations'],repositoryUrl:'https://github.com/example/project',reward:{kind:'unpaid'},approvalPolicy:{mode:'human'}};
   for (const offerId of ['worker:parent','worker:overlap']) {
    this.store.projectOffers.create('commons','owner',{requestId:'create-'+offerId,offerId,reviewerMemberIds:['owner'],terms});
    this.store.projectOffers.transition('commons','owner',offerId,'publish',{requestId:'publish-'+offerId,expectedRevision:1});
    this.store.publicWorkClaims.enable('commons','owner',offerId,{requestId:'enable-'+offerId,expectedRevision:2,expectedTermsVersion:1,repositoryRef:'main',files:['result.txt']});
   }
   const ownerKey=this.store.issueAccessKey('commons','owner');
   this.store.command(ownerKey,'commons',{id:'add-fixture-guest',type:'member.added',data:{memberId:'guest-agent-successor',displayName:'Scoped guest fixture',kind:'agent',permissions:[]}});
   return Response.json({terms,ownerKey,otherKey:this.store.issueAccessKey('other','owner'),guestKey:this.store.issueAccessKey('commons','guest-agent-successor'),producer:this.store.identities.create('Outside original producer'),otherProducer:this.store.identities.create('Outside successor producer')});
  }
  if (path === '/__successor/state') {
   const names=this.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'public_work_%' OR name IN ('project_offers','project_offer_requests','identity_links','bounty_journal','work_claims')) ORDER BY name").all().map(row=>row.name);
   return Response.json({members:Object.keys(this.store.room('commons').state.members),rows:Object.fromEntries(names.map(name=>[name,this.store.db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]))});
  }
  return super.fetch(request);
 }
}
export default entry;
`;

test('actual Worker revision follow-up is one durable child with fresh claims and immutable parent receipt', { timeout: 60000 }, async () => {
  const bundled = await build({stdin:{contents:fixture,resolveDir:fileURLToPath(new URL('.',import.meta.url)),sourcefile:'successor-fixture.mjs'},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
  const persistence = await mkdtemp(join(tmpdir(),'public-successor-worker-'));
  const origin = 'https://room.example.test';
  const config = {modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'SuccessorTestRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:origin},durableObjectsPersist:persistence};
  let worker = new Miniflare(config);
  const api = (path,data,secret) => worker.dispatchFetch(new URL(path,origin),{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...(secret?{Authorization:'Bearer '+secret}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
  const json = async (response,status=200) => {assert.equal(response.status,status,await response.clone().text());return response.json();};
  const call = (name,args,secret) => api('/room/mcp',{jsonrpc:'2.0',id:'successor-mcp',method:'tools/call',params:{name,arguments:args}},secret);
  const value = async response => {const reply=await json(response);assert.equal(reply.error,undefined,JSON.stringify(reply));assert.notEqual(reply.result.isError,true,JSON.stringify(reply));return reply.result.structuredContent;};
  const state = async () => json(await api('/__successor/state'));
  const reopen = async () => {await worker.dispose();worker=new Miniflare(config);};
  try {
    const setup = await json(await api('/__successor/setup',{}));
    const before = await state();
    const claimed = await value(await call('public_work_claim',{taskId:'worker:parent',requestId:'parent-claim',expectedTermsVersion:1},setup.producer.secret));
    const artifactText = 'Original immutable UTF-8 artifact ✓';
    const finished = await value(await call('public_work_finish',{taskId:'worker:parent',requestId:'parent-finish',expectedTermsVersion:1,generation:claimed.task.claim.generation,artifactText,checksReported:['Caller-reported original check']},setup.producer.secret));
    const receipt = finished.receipt;
    const path = '/api/rooms/commons/public-work/receipts/'+receipt.receiptId;
    const tuple = {taskId:receipt.taskId,expectedTermsVersion:receipt.termsVersion,generation:receipt.generation,artifactSha256:receipt.artifact.sha256};
    const revised = await json(await api(path+'/decide',{...tuple,requestId:'request-revision',expectedReviewRevision:0,decision:'revision_requested',reason:'Improve the result; this feedback is shared only with the contributor'},setup.ownerKey));
    assert.equal(revised.review.state,'revision_requested');
    const parentState = await state();
    const payload = {...tuple,requestId:'create-follow-up',expectedReviewRevision:revised.review.revision,successorTaskId:'worker:follow-up',terms:{...setup.terms,title:'Explicit volunteer follow-up',summary:'Owner-chosen public instructions'},repositoryRef:'main',files:['result.txt']};
    const followPath = path+'/follow-up';
    for (const [data,secret,status] of [[{...payload,expectedReviewRevision:2},setup.ownerKey,409],[{...payload,artifactSha256:'0'.repeat(64)},setup.ownerKey,409],[payload,setup.guestKey,403],[payload,setup.otherKey,403],[{...payload,unknown:true},setup.ownerKey,422]]) {
      await json(await api(followPath,data,secret),status);
      assert.deepEqual(await state(),parentState,'refused follow-up must not write offers, claims or journals');
    }
    const concurrent = await Promise.all([api(followPath,payload,setup.ownerKey),api(followPath,payload,setup.ownerKey)]);
    const created = await json(concurrent[0]);
    assert.deepEqual(await json(concurrent[1]),created,'concurrent exact retries must return one created child');
    assert.equal(created.followUp.taskId,payload.successorTaskId);
    assert.equal(created.followUp.available,true);
    assert.equal(created.task.claim.state,'unclaimed');
    assert.equal(JSON.stringify(created.task).includes('this feedback is shared only'),false);
    await reopen();
    assert.deepEqual(await json(await api(followPath,payload,setup.ownerKey)),created);
    const afterCreate = await state();
    await json(await api(followPath,{...payload,requestId:'different-follow-up',successorTaskId:'worker:duplicate-child'},setup.ownerKey),409);
    assert.deepEqual(await state(),afterCreate);
    assert.equal(afterCreate.rows.public_work_successors.length,1);
    assert.equal(afterCreate.rows.public_work_successor_requests.length,1);
    const overlap = await value(await call('public_work_claim',{taskId:'worker:overlap',requestId:'hold-overlap',expectedTermsVersion:1},setup.producer.secret));
    const blocked = await json(await call('public_work_claim',{taskId:created.task.taskId,requestId:'blocked-child',expectedTermsVersion:1},setup.otherProducer.secret));
    assert.equal(blocked.result.isError,true);assert.equal(blocked.result.structuredContent.status,409);
    await value(await call('public_work_release',{taskId:'worker:overlap',requestId:'release-overlap',expectedTermsVersion:1,generation:overlap.task.claim.generation},setup.producer.secret));
    const child = await value(await call('public_work_claim',{taskId:created.task.taskId,requestId:'claim-child',expectedTermsVersion:1},setup.otherProducer.secret));
    assert.equal(child.task.claim.identityId,setup.otherProducer.identityId,'public follow-up may be claimed by a different saved identity');
    const childFinished = await value(await call('public_work_finish',{taskId:created.task.taskId,requestId:'finish-child',expectedTermsVersion:1,generation:child.task.claim.generation,artifactText:'Explicit new artifact 🐈',checksReported:[]},setup.otherProducer.secret));
    assert.notEqual(childFinished.receipt.receiptId,receipt.receiptId);
    const childFeedback = await value(await call('public_work_my_review',{receiptId:childFinished.receipt.receiptId},setup.otherProducer.secret));
    assert.equal(childFeedback.review.state,'pending','parent decision and PASS must not become child review');
    const originalFeedback = await value(await call('public_work_my_review',{receiptId:receipt.receiptId},setup.producer.secret));
    assert.equal(originalFeedback.review.state,'revision_requested');assert.equal(originalFeedback.followUp.taskId,created.task.taskId);
    const response = await api('/api/public-work/receipts/'+receipt.receiptId+'/artifact');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.toString('utf8'),artifactText);assert.equal(createHash('sha256').update(bytes).digest('hex'),receipt.artifact.sha256);
    await json(await api('/api/rooms/commons/project-offers/worker%3Aparent/withdraw',{requestId:'withdraw-parent',expectedRevision:2},setup.ownerKey));
    await json(await api('/api/rooms/commons/project-offers/'+encodeURIComponent(created.task.taskId)+'/withdraw',{requestId:'withdraw-child',expectedRevision:2},setup.ownerKey));
    const unavailable = await value(await call('public_work_my_review',{receiptId:receipt.receiptId},setup.producer.secret));
    assert.equal(unavailable.followUp.available,false,'fresh feedback must reflect a withdrawn child without deleting its receipt');
    const final = await state();
    assert.deepEqual(final.rows.public_work_receipts.find(row=>row.receipt_id===receipt.receiptId),parentState.rows.public_work_receipts.find(row=>row.receipt_id===receipt.receiptId));
    assert.deepEqual(final.rows.public_work_reviews.find(row=>row.receipt_id===receipt.receiptId),parentState.rows.public_work_reviews.find(row=>row.receipt_id===receipt.receiptId));
    assert.deepEqual(final.rows.identity_links,before.rows.identity_links);assert.deepEqual(final.rows.bounty_journal,before.rows.bounty_journal);assert.deepEqual(final.members,before.members);
    await reopen();assert.deepEqual(await state(),final);
    assert.deepEqual(await json(await api(followPath,payload,setup.ownerKey)),created);
  } finally {await worker.dispose();await rm(persistence,{recursive:true,force:true});}
});
