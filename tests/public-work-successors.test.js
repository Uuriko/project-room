import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkSuccessors, publicWorkSuccessorsSchema } from '../server/public-work-successors.mjs';
import { GUEST_AGENT_MEMBER_PREFIX } from '../server/guest-agent-links.mjs';
const code = value => error => error.code === value;
function fixture(t, { mixed = false, linked = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'public-follow-up-')), file = join(dir, 'room.sqlite');
  let store = new RoomStore(file);
  const install = () => { store.db.exec(publicWorkSuccessorsSchema); store.publicWorkSuccessors = new PublicWorkSuccessors(store); store.publicWorkSuccessors.verifySchema(); };
  install(); store.initialize(initialRoom()); store.initialize(initialRoom('other'));
  const alter = fn => { const state = structuredClone(store.room('commons').state); fn(state); store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons'); };
  alter(state => { state.members.reviewer = { id: 'reviewer', revision: 1, kind: 'agent', active: true, permissions: ['read','verify'] }; });
  if (linked) store.command(store.issueAccessKey('commons','owner'),'commons',{id:'linked',type:'work.proposed',data:{workItemId:'linked-work',title:'Linked',definitionOfDone:'Exact result',accountableMemberId:'owner',verifierMemberId:'reviewer',independentVerificationRequired:true,ownerDecisionRequired:true,humanDecisionMakerId:'owner',mode:'write'}});
  const terms = { kind:'task',title:'Initial task',summary:'Public initial scope',acceptanceCriteria:['Correct result'],repositoryUrl:'https://github.com/example/project',reward:{kind:'unpaid'},approvalPolicy:{mode:mixed?'human_with_agent_review':'human'} };
  store.projectOffers.create('commons','owner',{requestId:'create',offerId:'parent',terms,reviewerMemberIds:mixed?['owner','reviewer']:['owner'],...(linked?{workItemId:'linked-work'}:{})});
  store.projectOffers.transition('commons','owner','parent','publish',{requestId:'publish',expectedRevision:1});
  store.publicWorkClaims.enable('commons','owner','parent',{requestId:'enable',expectedRevision:2,expectedTermsVersion:1,repositoryRef:'main',files:['result.txt']});
  const producer=store.identities.create('Original producer'),other=store.identities.create('Another contributor');
  store.publicWorkClaims.act('parent',producer.secret,'claim',{requestId:'claim',expectedTermsVersion:1});
  const receipt=store.publicWorkClaims.act('parent',producer.secret,'finish',{requestId:'finish',expectedTermsVersion:1,generation:1,artifactText:'Original bytes 🐈',checksReported:[]}).receipt;
  const tuple={taskId:'parent',expectedTermsVersion:1,generation:1,artifactSha256:receipt.artifact.sha256,reason:'Private owner feedback does not become public task text'};
  if(mixed) store.publicWorkReviews.verify('commons','reviewer',receipt.receiptId,{...tuple,requestId:'verify',expectedReviewRevision:0,verdict:'PASS'});
  const revised=store.publicWorkReviews.decide('commons','owner',receipt.receiptId,{...tuple,requestId:'revision',expectedReviewRevision:mixed?1:0,decision:'revision_requested'});
  const input={requestId:'follow-up',expectedReviewRevision:revised.review.revision,taskId:'parent',expectedTermsVersion:1,generation:1,artifactSha256:receipt.artifact.sha256,successorTaskId:'child',terms:{...terms,title:'Improve the result',summary:'Explicit owner-authored public instructions'},repositoryRef:'main',files:['result.txt']};
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {get store(){return store;}, file, receipt, producer, other, input, tuple, alter, create:(inputOverride=input,actor='owner',room='commons')=>store.publicWorkSuccessors.create(room,actor,receipt.receiptId,inputOverride),reopen(){store.close();store=new RoomStore(file);install();}};
}
function original(f) {return {receipt:f.store.db.prepare('SELECT * FROM public_work_receipts WHERE receipt_id=?').get(f.receipt.receiptId),review:f.store.db.prepare('SELECT * FROM public_work_reviews WHERE receipt_id=?').get(f.receipt.receiptId),requests:f.store.db.prepare('SELECT * FROM public_work_review_requests ORDER BY rowid').all().filter(row=>JSON.parse(row.input_json).receiptId===f.receipt.receiptId),credits:f.store.db.prepare('SELECT * FROM bounty_journal ORDER BY seq').all()};}
function allRows(f) {return Object.fromEntries(['project_offers','project_offer_requests','public_work_tasks','public_work_requests','work_claims','public_work_successors','public_work_successor_requests'].map(name=>[name,f.store.db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));}

test('explicit follow-up preserves parent/PASS/credits and uses the same public claim and fresh review authority', t => {
  const f=fixture(t,{mixed:true,linked:true}),before=original(f),out=f.create();
  assert.deepEqual(out.followUp,{taskId:'child',termsVersion:1,available:true});assert.equal(out.task.claim.state,'unclaimed');assert.equal(out.task.namespaceId,f.store.publicWorkClaims.read('parent').namespaceId);
  const child=f.store.projectOffers.ownerList('commons','owner').offers.find(x=>x.id==='child');assert.deepEqual(child.reviewerMemberIds,['owner','reviewer']);assert.equal(child.workItemId,'linked-work');assert.equal(child.summary,f.input.terms.summary);
  assert.doesNotMatch(JSON.stringify(f.store.publicWorkClaims.read('child')),/Private owner feedback/);
  assert.deepEqual(f.store.publicWorkReviews.inspect('commons','owner',f.receipt.receiptId).followUp,out.followUp);
  assert.deepEqual(f.store.publicWorkReviews.contributorReview(f.producer.secret,f.receipt.receiptId).followUp,out.followUp);
  assert.throws(()=>f.store.publicWorkReviews.contributorReview(f.other.secret,f.receipt.receiptId),code('review_not_found'));
  const claim=f.store.publicWorkClaims.act('child',f.other.secret,'claim',{requestId:'child-claim',expectedTermsVersion:1});assert.equal(claim.task.claim.identityId,f.other.identityId);
  assert.throws(()=>f.store.publicWorkClaims.act('child',f.producer.secret,'claim',{requestId:'competitor',expectedTermsVersion:1}),code('public_work_claim_conflict'));
  const receipt=f.store.publicWorkClaims.act('child',f.other.secret,'finish',{requestId:'child-finish',expectedTermsVersion:1,generation:claim.task.claim.generation,artifactText:'Revised bytes',checksReported:[]}).receipt;
  assert.notEqual(receipt.receiptId,f.receipt.receiptId);assert.equal(f.store.publicWorkReviews.inspect('commons','owner',receipt.receiptId).review.state,'pending');
  const childReview={taskId:'child',expectedTermsVersion:1,generation:receipt.generation,artifactSha256:receipt.artifact.sha256,reason:'Independent review of revised result'};
  assert.throws(()=>f.store.publicWorkReviews.decide('commons','owner',receipt.receiptId,{...childReview,requestId:'early-accept',expectedReviewRevision:0,decision:'accepted'}),code('review_pass_required'));
  f.store.publicWorkReviews.verify('commons','reviewer',receipt.receiptId,{...childReview,requestId:'child-pass',expectedReviewRevision:0,verdict:'PASS'});
  assert.equal(f.store.publicWorkReviews.decide('commons','owner',receipt.receiptId,{...childReview,requestId:'child-accept',expectedReviewRevision:1,decision:'accepted'}).review.state,'accepted');
  assert.deepEqual(original(f),before);assert.equal(f.store.db.prepare('SELECT count(*) n FROM identity_links WHERE identity_id=?').get(f.other.identityId).n,0);assert.equal(f.store.db.prepare('SELECT enabled FROM public_work_claim_writer_permit').get().enabled,0);
});

test('restart and exact retry retain one child despite later withdrawal/review change; changed input refuses', t => {
  const f=fixture(t),out=f.create(),before=allRows(f);f.reopen();assert.deepEqual(f.create(),out);assert.deepEqual(allRows(f),before);
  f.store.projectOffers.transition('commons','owner','parent','withdraw',{requestId:'withdraw-parent',expectedRevision:2});
  f.store.publicWorkReviews.decide('commons','owner',f.receipt.receiptId,{...f.tuple,requestId:'accept-old',expectedReviewRevision:1,decision:'accepted'});
  assert.deepEqual(f.create(),out);assert.throws(()=>f.create({...f.input,terms:{...f.input.terms,title:'Changed'}}),code('request_id_reused'));
  f.store.projectOffers.transition('commons','owner','child','withdraw',{requestId:'withdraw-child',expectedRevision:2});assert.equal(f.store.publicWorkSuccessors.link(f.receipt.receiptId).available,false);assert.equal(f.store.publicWorkReviews.contributorReview(f.producer.secret,f.receipt.receiptId).followUp.available,false);
  assert.deepEqual(f.create(),out,'replay is the original receipt, not a fresh availability assertion');
  f.alter(s=>{s.members.owner.active=false;});assert.throws(()=>f.create(),code('owner_only'));
});

test('first creation refuses non-owner, guest owner, stale binding, changed mode/repository, and unavailable linked reviewers', t => {
  const f=fixture(t,{mixed:true}),before=allRows(f);
  assert.throws(()=>f.create(f.input,'reviewer'),code('owner_only'));assert.throws(()=>f.create(f.input,'owner','other'),code('review_not_found'));
  for(const change of [{expectedReviewRevision:99},{taskId:'wrong'},{expectedTermsVersion:2},{generation:2},{artifactSha256:'0'.repeat(64)}])assert.throws(()=>f.create({...f.input,...change}),error=>['stale_review','stale_review_receipt'].includes(error.code));
  for(const terms of [{...f.input.terms,reward:{kind:'cash',unit:'USD',amountMinor:'100'}},{...f.input.terms,approvalPolicy:{mode:'human'}},{...f.input.terms,repositoryUrl:'https://github.com/other/project'}])assert.throws(()=>f.create({...f.input,terms}),code('invalid_follow_up'));
  f.alter(s=>{s.members.reviewer.active=false;});assert.throws(()=>f.create(),code('invalid_project_offer'));assert.deepEqual(allRows(f),before);
  f.alter(s=>{s.members.reviewer.active=true;const id=GUEST_AGENT_MEMBER_PREFIX+'pretend';s.members[id]={...s.members.owner,id};s.room.ownerId=id;});assert.throws(()=>f.create(f.input,GUEST_AGENT_MEMBER_PREFIX+'pretend'),code('owner_only'));
});

test('second writer gets one-child conflict and exact retries cannot alias another input', t => {
  const f=fixture(t),out=f.create();const peer=new RoomStore(f.file);peer.publicWorkSuccessors=new PublicWorkSuccessors(peer);
  try{assert.deepEqual(peer.publicWorkSuccessors.create('commons','owner',f.receipt.receiptId,f.input),out);assert.throws(()=>peer.publicWorkSuccessors.create('commons','owner',f.receipt.receiptId,{...f.input,requestId:'second',successorTaskId:'child2'}),code('follow_up_exists'));assert.equal(peer.db.prepare('SELECT count(*) n FROM public_work_successors').get().n,1);}finally{peer.close();}
});

test('nested enable failure and outer journal failure roll back every child-side effect and leave exact retry usable', t => {
  const f=fixture(t),before=allRows(f),parent=original(f);
  assert.throws(()=>f.create({...f.input,files:['../escape']}),code('invalid_public_work'));assert.deepEqual(allRows(f),before);assert.deepEqual(original(f),parent);
  f.store.db.exec("CREATE TRIGGER unavailable_successor_journal BEFORE INSERT ON public_work_successor_requests BEGIN SELECT RAISE(ABORT,'journal unavailable'); END;");assert.throws(()=>f.create(),/journal unavailable/);assert.deepEqual(allRows(f),before);assert.deepEqual(original(f),parent);assert.equal(f.store.db.prepare('SELECT enabled FROM public_work_claim_writer_permit').get().enabled,0);
  f.store.db.exec('DROP TRIGGER unavailable_successor_journal');assert.equal(f.create().task.taskId,'child');
});

test('publication and current linked-work policy remain required, never silently discarded', t => {
  const f=fixture(t,{mixed:true,linked:true}),before=allRows(f);f.alter(s=>{delete s.workItems['linked-work'];});assert.throws(()=>f.create(),code('review_policy_changed'));assert.deepEqual(allRows(f),before);
  const g=fixture(t);g.store.projectOffers.transition('commons','owner','parent','withdraw',{requestId:'withdraw',expectedRevision:2});assert.throws(()=>g.create(),code('follow_up_unavailable'));
});

test('constructor has no DDL; historical all-absent readonly review remains usable and malformed/partial schema refuses', t => {
  const f=fixture(t);f.store.db.exec('DROP TABLE public_work_successors;DROP TABLE public_work_successor_requests;');
  const readonly=new RoomStore(f.file,{readOnly:true});try{readonly.publicWorkSuccessors=new PublicWorkSuccessors(readonly);assert.equal(readonly.publicWorkSuccessors.verifySchema({allowAbsent:true}),false);assert.equal(readonly.publicWorkSuccessors.link(f.receipt.receiptId),null);assert.equal(readonly.publicWorkReviews.contributorReview(f.producer.secret,f.receipt.receiptId).review.state,'revision_requested');assert.equal(readonly.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'public_work_successor%'").get().n,0);}finally{readonly.close();}
  f.store.db.exec('CREATE TABLE public_work_successors(parent_receipt_id TEXT PRIMARY KEY)');assert.throws(()=>f.store.publicWorkSuccessors.verifySchema({allowAbsent:true}),/operator reconciliation/);assert.throws(()=>f.store.publicWorkSuccessors.link(f.receipt.receiptId),/operator reconciliation/);
});
