import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {readWorkItem} from '../server/work-repository.mjs';
import {textVersion} from '../server/text-results.mjs';
import {buildActivationPack, briefActivationPack, BRIEF_BYTES} from '../server/room-activation-pack.mjs';

function fixture(t, current = true) {
  const store = new RoomStore(':memory:'); t.after(() => store.close());
  store.initialize(initialRoom(), current ? {representation: 'normalized-current-v1'} : {});
  const keys = {owner: store.issueAccessKey('commons', 'owner')};
  const send = (type, data, who = 'owner') => store.command(keys[who], 'commons', {id: crypto.randomUUID(), type, data});
  for (const [memberId, kind, permissions] of [['worker', 'agent', ['accept_work', 'complete_work']], ['reviewer', 'agent', ['verify']], ['reader', 'agent', []]]) {
    send('member.added', {memberId, displayName: memberId, kind, permissions});
    keys[memberId] = store.issueAccessKey('commons', memberId);
  }
  const item = id => readWorkItem(store.db, 'commons', id);
  const propose = (id, extra = {}) => send('work.proposed', {workItemId: id, title: `Task ${id}`, definitionOfDone: 'Saved useful result', accountableMemberId: 'worker', mode: 'read', ...extra});
  const step = (type, id, data = {}, who = 'worker') => send(type, {workItemId: id, expectedRevision: item(id).revision, ...data}, who);
  const complete = id => {
    step('work.accepted', id); step('work.started', id);
    const body = 'Private result prose must not appear in activation';
    const post = send('message.posted', {messageId: 'result-'+id, workItemId: id, body}, 'worker');
    step('work.completed', id, {evidenceKind: 'room_text', evidenceMessageId: 'result-'+id, evidenceMessageEventId: post.event.id, evidenceVersion: textVersion(body), previousCompletionEventId: null, producerId: 'worker', summary: 'Saved', nextAction: 'Review'});
  };
  const brief = (who = 'worker') => briefActivationPack(buildActivationPack(store, 'commons', who), [], store.now(), who);
  const forbidHydration = () => { if (current) {store.room = () => {throw Error('whole-room hydration forbidden');};store.workClaims.list = () => {throw Error('legacy Board forbidden');};} };
  return {store, keys, send, propose, step, complete, item, brief, forbidHydration};
}

test('ongoing own work wins over unrelated pickup with only a selected GET and no writes', t => {
  const f = fixture(t); f.propose('00-unrelated', {accountableMemberId: 'owner'}); f.propose('zz-owned');
  f.step('work.accepted', 'zz-owned'); f.step('work.started', 'zz-owned'); f.forbidHydration();
  const before = f.store.headSequence('commons'), b = f.brief();
  assert.equal(b.yourWork[0].id, 'zz-owned'); assert.equal(b.yourWork[0].reason, 'in_progress');
  assert.equal(b.next.method, 'GET'); assert.match(b.next.endpoint, /work-context\?workItemId=zz-owned$/);
  assert.equal(b.yourWork[0].nextRead.tool, 'room_read_work');
  assert.equal(f.store.headSequence('commons'), before); assert.ok(Buffer.byteLength(JSON.stringify(b)) <= BRIEF_BYTES);
});

test('current exact review, authorized decision and failed-review correction use shared state', t => {
  const f = fixture(t); f.propose('review', {independentVerificationRequired: true, verifierMemberId: 'reviewer', ownerDecisionRequired: true, humanDecisionMakerId: 'owner'}); f.complete('review'); f.propose('00-unrelated', {accountableMemberId: 'reader'});
  const b = f.brief('reviewer'); assert.equal(b.yourWork[0].reason, 'verify'); assert.equal(b.yourWork[0].nextRead.arguments.includeResult, true); assert.match(b.next.endpoint, /workItemId=review$/);
  assert.ok(!f.brief('reader').yourWork.some(item => item.id === 'review')); assert.deepEqual(f.brief('owner').yourWork, []);
  const r = f.item('review').receipt;
  f.step('verification.recorded', 'review', {result: 'fail', completionEventId: r.eventId, evidenceVersion: r.evidenceVersion, summary: 'Needs correction'}, 'reviewer');
  assert.equal(f.brief().yourWork[0].reason, 'revise');
  f.step('work.blocker_resolved', 'review', {resolution: 'Corrected'});
  // Replacement evidence retires the old review. Re-read exact result instead of carrying its verdict.
  const body = 'Corrected exact result'; const post = f.send('message.posted', {messageId: 'replacement', workItemId: 'review', body}, 'worker');
  f.step('work.completed', 'review', {evidenceKind: 'room_text', evidenceMessageId: 'replacement', evidenceMessageEventId: post.event.id, evidenceVersion: textVersion(body), previousCompletionEventId: r.eventId, producerId: 'worker', summary: 'Corrected', nextAction: 'Review'}, 'worker');
  assert.equal(f.brief('reviewer').yourWork[0].reason, 'verify');
  const current = f.item('review').receipt;
  f.step('verification.recorded', 'review', {result: 'pass', completionEventId: current.eventId, evidenceVersion: current.evidenceVersion, summary: 'Exact version checked'}, 'reviewer');
  assert.equal(f.brief('owner').yourWork[0].reason, 'decide');
  assert.deepEqual(f.brief('reviewer').yourWork, []);
});

test('incomplete empty addressed window never recommends unrelated pickup and gives exhaustive existing read', t => {
  const f = fixture(t); for (let i=0;i<5;i++) {f.propose('a'+i); f.complete('a'+i);} f.propose('zz-owned'); f.propose('00-unrelated', {accountableMemberId:'owner'}); f.forbidHydration();
  const b = f.brief(); assert.deepEqual(b.yourWork, []); assert.equal(b.yourWorkCoverage.complete, false);
  assert.equal(b.next.method, 'GET'); assert.equal(b.next.endpoint, '/api/rooms/commons/work-list?focus=all');
  assert.equal(b.yourWorkCoverage.nextRead.tool, 'room_list_work');
  let cursor, found = false, pages = 0;
  do {const page = f.store.currentWorkListing(f.keys.worker,'commons',{focus:'all',...(cursor?{cursor}:{})});found ||= page.work.some(w=>w.id==='zz-owned');cursor=page.page.nextCursor;pages++;}while(cursor);
  assert.equal(found,true); assert.ok(pages>1);
});

test('stable bounded obligations retain IDs/reads under byte pressure; no private result or source prose', t => {
  const f = fixture(t); for(let i=0;i<5;i++)f.propose('task-'+i,{title:'長'.repeat(800)}); f.forbidHydration();
  const b = f.brief(); assert.ok(b.yourWork.length>0); assert.ok(b.yourWork.length<=3);
  assert.ok(Buffer.byteLength(JSON.stringify(b))<=BRIEF_BYTES); assert.equal(b.yourWorkCoverage.complete,false);
  assert.deepEqual(b.yourWork.map(w=>w.id),f.brief().yourWork.map(w=>w.id));
  assert.equal(b.next.method,'GET'); assert.doesNotMatch(JSON.stringify(b),/Private result prose|Saved useful result/);
});

test('no obligations keeps bounded pickup as a read, not a claim or grant', t => {
  const f=fixture(t);f.propose('other',{accountableMemberId:'owner'});f.forbidHydration();
  const b=f.brief('reader');assert.deepEqual(b.yourWork,[]);assert.equal(b.yourWorkCoverage.complete,true);assert.equal(b.next.method,'GET');
  assert.doesNotMatch(b.next.endpoint,/\/claim/);assert.match(b.next.endpoint,/work-context/);
});

test('legacy assigned work also takes priority without importing Board into native path', t => {
  const f=fixture(t,false);f.propose('a-unrelated',{accountableMemberId:'owner'});f.propose('z-own');f.step('work.accepted','z-own');f.step('work.started','z-own');
  assert.equal(f.brief().yourWork[0].id,'z-own');assert.equal(f.brief().next.method,'GET');
});

test('read-only and unauthorized decision members get reads, never decision authority; private tasks stay private', t => {
  const f=fixture(t);
  f.send('member.added',{memberId:'human-reader',displayName:'Read only human',kind:'human',permissions:[]});
  f.propose('decision',{ownerDecisionRequired:true,humanDecisionMakerId:'human-reader'});f.complete('decision');
  const b=f.brief('human-reader');assert.equal(b.yourWork[0].reason,'permission_required');assert.equal(b.next.method,'GET');
  assert.deepEqual(f.brief('reader').yourWork,[]);
  f.propose('private',{title:'PRIVATE-TASK-TITLE',accountableMemberId:'owner'});
  f.send('message.posted',{messageId:'private-request',toMemberId:'reviewer',workItemId:'private',requestKind:'reply',body:'PRIVATE-REQUEST-BODY'});
  const before=f.store.headSequence('commons');f.forbidHydration();
  const outsider=f.brief('reader');assert.doesNotMatch(JSON.stringify(outsider),/PRIVATE-TASK-TITLE|PRIVATE-REQUEST-BODY|Private result prose/);
  assert.equal(f.store.headSequence('commons'),before);
  assert.throws(()=>f.store.command(f.keys.reader,'commons',{id:crypto.randomUUID(),type:'owner.decision_recorded',data:{workItemId:'decision',expectedRevision:f.item('decision').revision,decision:'approved',completionEventId:f.item('decision').receipt.eventId,evidenceVersion:f.item('decision').receipt.evidenceVersion,reason:'Unauthorized'}}));
  assert.equal(f.store.headSequence('commons'),before);
});

test('max-length obligation identifiers retain exact selected read and context-only purpose within budget',t=>{
  const f=fixture(t);const id='w'.repeat(128);f.propose(id,{title:'協調'.repeat(400)});
  f.send('room.charter_updated',{expectedRevision:0,purpose:'Context, not a grant',outputs:null,boundaries:null,escalation:null});
  const b=f.brief();assert.equal(b.yourWork[0].id,id);assert.equal(b.yourWork[0].nextRead.arguments.workItemId,id);
  assert.equal(b.purposeSource.authority,'context_only');assert.equal(b.purpose,'Context, not a grant');assert.ok(Buffer.byteLength(JSON.stringify(b))<=BRIEF_BYTES);
});

for (const current of [true, false]) test(`formal incoming requests precede pickup and survive ordinary reply and disappear after cancellation (${current?'native':'legacy'})`, t => {
  const f=fixture(t,current);f.propose('unrelated',{accountableMemberId:'owner'});
  f.send('message.posted',{messageId:'request',toMemberId:'worker',requestKind:'reply',body:'SECRET REQUEST BODY'});
  f.forbidHydration();const b=f.brief();
  assert.equal(b.yourWork[0]?.reason,'reply_requested');assert.equal(b.yourWork[0].nextRead.tool,'room_read_request');
  assert.match(b.next.endpoint,/reply-context\?requestMessageId=request$/);assert.doesNotMatch(JSON.stringify(b),/SECRET REQUEST BODY/);
  assert.ok(!f.brief('reader').yourWork.some(x=>x.id==='request'));
  f.send('message.posted',{messageId:'reply',replyToId:'request',body:'Answer'},'worker');
  assert.ok(f.brief().yourWork.some(x=>x.id==='request'));
  f.send('reply_request.cancelled',{requestMessageId:'request',expectedRequestRevision:0,reason:'Resolved'});
  assert.ok(!f.brief().yourWork.some(x=>x.id==='request'));
});

test('request overflow exposes both recovery enumerations and preserves all returned cursors', t => {
  const f=fixture(t); for(let i=0;i<7;i++)f.send('message.posted',{messageId:`req-${i}`,toMemberId:'worker',requestKind:'reply',body:'Private'});
  f.propose('ongoing');f.step('work.accepted','ongoing');f.step('work.started','ongoing');f.forbidHydration();
  const before=f.store.headSequence('commons'),b=f.brief();assert.equal(b.yourWorkCoverage.complete,false);
  assert.equal(b.yourWorkCoverage.requestRead.arguments.focus,'needs_me');assert.equal(b.yourWorkCoverage.nextRead.arguments.focus,'all');
  const ids=[];let args=b.yourWorkCoverage.requestRead.arguments,pages=0;
  do {const page=f.store.currentWorkListing(f.keys.worker,'commons',args);ids.push(...page.replyRequests.map(x=>x.id));args=page.page.nextRead?.arguments;pages++;} while(args);
  assert.equal(new Set(ids).size,7);assert.ok(pages>1);assert.equal(f.store.headSequence('commons'),before);
  assert.ok(Buffer.byteLength(JSON.stringify(b))<=BRIEF_BYTES);
});

test('prerequisite-bearing start is an observation check, not a readiness claim', t=>{
  const f=fixture(t);f.propose('prereq',{accountableMemberId:'owner'});f.propose('dependent',{dependsOn:['prereq']});
  f.step('work.accepted','dependent');f.forbidHydration();
  assert.equal(f.brief().yourWork[0].reason,'check_prerequisites');assert.equal(f.brief().yourWork[0].nextRead.tool,'room_read_work');
});
