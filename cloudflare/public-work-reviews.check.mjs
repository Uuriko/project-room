import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Dedicated local-only provisioning/observation fixture. The real store,
// public-claim kernel, review policy and SQLite transactions perform all writes.
const fixture=`
import entry,{ProjectRoom} from './room.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
export class ReviewTestRoom extends ProjectRoom {
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(!path.startsWith('/__review/'))return super.fetch(request);
  const input=request.method==='POST'?await request.json():{};
  try{
   if(path==='/__review/setup'){
    this.store.initialize(initialRoom());
    const state=structuredClone(this.store.room('commons').state);
    state.members.reviewer={id:'reviewer',revision:1,kind:'agent',active:true,displayName:'Reviewer',permissions:['read','verify']};
    this.store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state),'commons');
    const offerId='worker-review';
    this.store.projectOffers.create('commons','owner',{requestId:'create',offerId,reviewerMemberIds:['owner','reviewer'],terms:{kind:'task',title:'Review persisted artifact',summary:'Synthetic review',acceptanceCriteria:['Keep exact bytes'],repositoryUrl:'https://github.com/example/project',reward:{kind:'unpaid'},approvalPolicy:{mode:'human_with_agent_review'}}});
    this.store.projectOffers.transition('commons','owner',offerId,'publish',{requestId:'publish',expectedRevision:1});
    this.store.publicWorkClaims.enable('commons','owner',offerId,{requestId:'enable',expectedRevision:2,expectedTermsVersion:1,repositoryRef:'main',files:['result.txt']});
    const producer=this.store.identities.create('Outside review producer');
    this.store.publicWorkClaims.act(offerId,producer.secret,'claim',{requestId:'claim',expectedTermsVersion:1});
    const receipt=this.store.publicWorkClaims.act(offerId,producer.secret,'finish',{requestId:'finish',expectedTermsVersion:1,generation:1,artifactText:'Synthetic UTF-8 result ✓',checksReported:['Producer-reported check']}).receipt;
    return Response.json({receipt,producer});
   }
   if(path==='/__review/verify')return Response.json(this.store.publicWorkReviews.verify('commons','reviewer',input.receiptId,input.body));
   if(path==='/__review/decide')return Response.json(this.store.publicWorkReviews.decide('commons','owner',input.receiptId,input.body));
   if(path==='/__review/withdraw')return Response.json(this.store.projectOffers.transition('commons','owner','worker-review','withdraw',{requestId:'withdraw',expectedRevision:2}));
   if(path==='/__review/contributor')return Response.json(this.store.publicWorkReviews.contributorReview(input.secret,input.receiptId));
   if(path==='/__review/state')return Response.json({results:this.store.publicWorkReviews.results('commons','owner'),
    records:this.store.db.prepare('SELECT * FROM public_work_reviews ORDER BY receipt_id').all(),
    journal:this.store.db.prepare('SELECT * FROM public_work_review_requests ORDER BY request_id').all(),
    submitted:this.store.db.prepare('SELECT * FROM public_work_receipts ORDER BY receipt_id').all(),
    kernel:this.store.db.prepare('SELECT * FROM work_claims ORDER BY room_id,claim_id').all(),
    balances:this.store.db.prepare('SELECT * FROM bounty_journal ORDER BY seq').all(),
    permit:this.store.db.prepare('SELECT enabled FROM public_work_claim_writer_permit').get().enabled,
    members:Object.keys(this.store.room('commons').state.members)});
   return new Response('Missing',{status:404});
  }catch(error){return Response.json({error:{message:error.message,code:error.code??null}},{status:error.status??500});}
 }
}
export default entry;
`;

test('actual Worker review verification/acceptance and exact journals survive disposal without altering submitted bytes, claims, grants or credits',async()=>{
 const bundled=await build({stdin:{contents:fixture,resolveDir:fileURLToPath(new URL('.',import.meta.url)),sourcefile:'review-local-fixture.mjs'},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*','cloudflare:*']});
 const persistence=await mkdtemp(join(tmpdir(),'public-review-worker-'));
 const origin='https://room.example.test';
 const config={modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOM:{className:'ReviewTestRoom',useSQLite:true}},bindings:{ROOM_ORIGIN:origin},durableObjectsPersist:persistence};
 let worker=new Miniflare(config);
 const call=(path,input)=>worker.dispatchFetch(origin+'/__review/'+path,{method:input?'POST':'GET',headers:{Host:'room.example.test',...(input?{'Content-Type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})});
 const json=async(response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response.json();};
 const reopen=async()=>{await worker.dispose();worker=new Miniflare(config);};
 try{
  const {receipt,producer}=await json(await call('setup'));
  const before=await json(await call('state'));
  const tuple={taskId:receipt.taskId,expectedTermsVersion:receipt.termsVersion,generation:receipt.generation,artifactSha256:receipt.artifact.sha256};
  const verification={...tuple,requestId:'worker-review-pass',expectedReviewRevision:0,verdict:'PASS',reason:'Private verifier reasoning'};
  const verified=await json(await call('verify',{receiptId:receipt.receiptId,body:verification}));
  await reopen();
  assert.deepEqual(await json(await call('verify',{receiptId:receipt.receiptId,body:verification})),verified);
  await json(await call('withdraw',{}));
  const decision={...tuple,requestId:'worker-review-accept',expectedReviewRevision:1,decision:'accepted',reason:'Reviewed exact contribution'};
  const accepted=await json(await call('decide',{receiptId:receipt.receiptId,body:decision}));
  assert.equal(accepted.review.state,'accepted');
  const persisted=await json(await call('state'));
  assert.equal(persisted.results.results[0].offer.status,'withdrawn');
  assert.deepEqual(persisted.submitted,before.submitted);assert.deepEqual(persisted.kernel,before.kernel);assert.deepEqual(persisted.balances,before.balances);
  assert.deepEqual(persisted.members,before.members);assert.equal(persisted.permit,0);assert.ok(!persisted.members.includes(producer.identityId));
  await reopen();assert.deepEqual(await json(await call('state')),persisted);
  assert.deepEqual(await json(await call('decide',{receiptId:receipt.receiptId,body:decision})),accepted);
  const contributor=await json(await call('contributor',{receiptId:receipt.receiptId,secret:producer.secret}));
  assert.equal(contributor.review.state,'accepted');assert.equal(JSON.stringify(contributor).includes('Private verifier reasoning'),false);
  assert.equal((await worker.dispatchFetch(origin+'/api/public-work/receipts/'+receipt.receiptId)).status,200);
  const denied=await json(await call('decide',{receiptId:receipt.receiptId,body:{...decision,requestId:'late-reject',expectedReviewRevision:2,decision:'rejected'}}),409);
  assert.equal(denied.error.code,'review_final');assert.deepEqual(await json(await call('state')),persisted);
 }finally{await worker.dispose();await rm(persistence,{recursive:true,force:true});}
});
