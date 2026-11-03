import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {waitForAttention} from '../server/attention-wait.mjs';
import {linkWithProof} from './helpers/link-with-proof.mjs';

function fixture(t) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const events = initialRoom();
  for (const id of ['worker', 'other']) events.push(event({roomId: 'commons', actorId: 'owner', type: 'member.added', data: {memberId: id, displayName: id, kind: 'agent', permissions: []}}));
  store.initialize(events, {representation: 'normalized-current-v1'});
  const owner = store.issueAccessKey('commons', 'owner'), worker = store.issueAccessKey('commons', 'worker');
  store.room = () => { throw Error('Whole-room reads forbidden'); };
  const post = (id, data, token = owner) => store.command(token, 'commons', {id, type: 'message.posted', data: {messageId: id, body: 'Useful message', ...data}});
  return {store, owner, worker, post, after: store.headSequence('commons')};
}

test('wait returns addressed mentions, replies, DMs and formal pointers without bodies or acknowledgements', async t => {
  for (const kind of ['mention', 'reply', 'dm', 'formal']) {
    const f = fixture(t);
    let after = f.after;
    if (kind === 'reply') { f.post('question', {}, f.worker); after = f.store.headSequence('commons'); }
    const promise = waitForAttention(f.store, f.worker, 'commons', {after, timeoutSec: 1});
    f.post('answer', kind === 'mention' ? {body: '@worker inspect this'} : kind === 'reply' ? {replyToId: 'question'} : {toMemberId: 'worker', ...(kind === 'formal' ? {requestKind: 'reply'} : {})});
    const result = await promise;
    assert.equal(result.status, 'ready');
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, kind === 'formal' ? 'reply_request' : kind === 'dm' ? 'direct_message' : kind);
    assert.equal(result.items[0].messageId, 'answer');
    assert.equal(result.items[0].body, undefined);
    assert.equal(result.acknowledges, false);
    assert.equal(result.globalAttentionComplete, false);
    assert.ok(f.store.agentInbox(f.worker, 'commons', {after}).directMessages.length + f.store.agentInbox(f.worker, 'commons', {after}).directMentions.length + f.store.agentInbox(f.worker, 'commons', {after}).replies.length);
  }
});

test('private messages to others never wake as attention and cancellation releases the pending slot', async t => {
  const f = fixture(t), cancel = new AbortController();
  const promise = waitForAttention(f.store, f.worker, 'commons', {after: f.after, timeoutSec: 1, signal: cancel.signal});
  f.post('hidden', {toMemberId: 'other', body: 'PRIVATE-SECRET'});
  await Promise.resolve();
  cancel.abort();
  await assert.rejects(promise, e => e.name === 'AbortError');
  const result = await waitForAttention(f.store, f.worker, 'commons', {after: f.after, timeoutSec: 0});
  assert.equal(result.status, 'timeout');
  assert.equal(JSON.stringify(result).includes('PRIVATE-SECRET'), false);
  assert.deepEqual(result.items, []);
});

test('backlogs return real catch-up continuations instead of waiting past unexamined rows', async t => {
  const f = fixture(t);
  for (let i = 0; i < 24; i++) f.post('public-' + i, {});
  f.post('late', {toMemberId: 'worker'});
  let after = f.after, ready = false;
  for (let calls = 0; calls < 10; calls++) {
    const result = await waitForAttention(f.store, f.worker, 'commons', {after, timeoutSec: 0});
    assert.ok(result.after > after);
    after = result.after;
    if (result.status === 'ready') { assert.equal(result.items[0].messageId, 'late'); ready = true; break; }
    assert.equal(result.status, 'catch_up_required');
    assert.equal(result.sourceComplete, false);
    assert.equal(result.nextRead.arguments.after, after);
  }
  assert.equal(ready, true);
});

test('timeout checks current credentials, and committed delivery never observes a rolled-back post', async t => {
  const f = fixture(t);
  const waiting = waitForAttention(f.store, f.worker, 'commons', {after: f.after, timeoutSec: 1});
  assert.throws(() => f.store.transaction(() => { f.post('rollback', {toMemberId: 'worker'}); throw Error('Injected rollback'); }), /Injected/);
  f.store.issueAccessKey('commons', 'worker');
  await assert.rejects(waiting, e => e.status === 401);
  const worker = f.store.issueAccessKey('commons', 'worker');
  const result = await waitForAttention(f.store, worker, 'commons', {after: f.after, timeoutSec: 0});
  assert.equal(result.status, 'timeout');
  assert.equal(result.after, f.after);
});

test('invalid arguments and legacy capability refuse before registering a wait', t => {
  const f = fixture(t);
  for (const args of [{after: -1}, {after: 0, timeoutSec: 121}, {after: 0, timeoutSec: '1'}]) assert.throws(() => waitForAttention(f.store, f.worker, 'commons', args), e => e.status === 422);
  assert.throws(() => waitForAttention(f.store, 'wrong', 'commons', {after: 0}), e => e.status === 401);
  f.store.initialize(initialRoom('legacy'));
  const owner = f.store.issueAccessKey('legacy', 'owner');
  assert.throws(() => waitForAttention(f.store, owner, 'legacy', {after: 0}), e => e.code === 'attention_wait_unavailable');
});

test('pending resources are capped across members and released after cancellation', async t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const events = initialRoom();
  for (let i = 0; i < 33; i++) events.push(event({roomId: 'commons', actorId: 'owner', type: 'member.added', data: {memberId: 'w' + i, displayName: 'Worker ' + i, kind: 'agent', permissions: []}}));
  store.initialize(events, {representation: 'normalized-current-v1'});
  const after = store.headSequence('commons'), controllers = [], results = [], keys = [];
  try {
    for (let i = 0; i < 32; i++) {
      const controller = new AbortController();
      controllers.push(controller);
      keys.push(store.issueAccessKey('commons', 'w' + i));
      results.push(assert.rejects(waitForAttention(store, keys[i], 'commons', {after, timeoutSec: 10, signal: controller.signal}), e => e.name === 'AbortError' || e.code === 'attention_wait_superseded'));
    }
    const extra = store.issueAccessKey('commons', 'w32');
    assert.throws(() => waitForAttention(store, extra, 'commons', {after}), e => e.status === 429);
    const replacementCancel=new AbortController();
    const replacement=assert.rejects(waitForAttention(store,keys[0],'commons',{after,timeoutSec:10,signal:replacementCancel.signal}),e=>e.name==='AbortError');
    await results[0];
    controllers[0].abort(); // The old controller cannot release the new generation's quota.
    assert.throws(() => waitForAttention(store, extra, 'commons', {after}), e => e.status === 429);
    replacementCancel.abort();await replacement;
    assert.equal((await waitForAttention(store, extra, 'commons', {after, timeoutSec: 0})).status, 'timeout');
  } finally { for (const controller of controllers) controller.abort(); await Promise.all(results); }
});

test('unrelated hot-room appends exhaust a finite probe allowance without hiding the cursor', async t => {
  const f = fixture(t), waiting = waitForAttention(f.store, f.worker, 'commons', {after: f.after, timeoutSec: 2});
  for (let i = 0; i < 3; i++) { f.post('unrelated-' + i, {}); await new Promise(resolve => setImmediate(resolve)); }
  const result = await waiting;
  assert.equal(result.status, 'catch_up_required');
  assert.equal(result.after, f.store.headSequence('commons'));
  assert.equal(result.sourceComplete, true);
  assert.deepEqual(result.items, []);
});

test('pending wait refuses a legitimate holder-proof relink to another member and releases its original slot', async t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  store.initialize(initialRoom(), {representation: 'normalized-current-v1'});
  const owner = store.issueAccessKey('commons', 'owner'), identity = store.identities.create('Existing holder');
  linkWithProof(store, owner, 'commons', identity, {memberId: 'before-seat', permissions: []});
  const after = store.headSequence('commons');
  const waiting = waitForAttention(store, identity.secret, 'commons', {after, timeoutSec: 1});
  const refusal = assert.rejects(waiting, error => error.status === 409 && error.code === 'attention_wait_binding_changed');
  // All changes use real owner authority and fresh single-use holder proofs.
  // They commit in the same turn, before the waiting request resumes.
  store.identities.unlink(owner, 'commons', identity.identityId);
  linkWithProof(store, owner, 'commons', identity, {memberId: 'after-seat', permissions: []});
  store.command(owner, 'commons', {id: 'after-seat-message', type: 'message.posted', data: {messageId: 'after-seat-message', toMemberId: 'after-seat', body: 'Attention for the newly selected member'}});
  assert.equal(store.authenticate(identity.secret, 'commons').member.id, 'after-seat');
  await refusal;
  const current = await waitForAttention(store, identity.secret, 'commons', {after, timeoutSec: 0});
  assert.equal(current.memberId, 'after-seat');
  assert.deepEqual(current.items.map(item => item.messageId), ['after-seat-message']);
  // Returning to the original seat proves its old resource key was reclaimed.
  store.identities.unlink(owner, 'commons', identity.identityId);
  linkWithProof(store, owner, 'commons', identity, {memberId: 'before-seat', permissions: []});
  const original = await waitForAttention(store, identity.secret, 'commons', {after: store.headSequence('commons'), timeoutSec: 0});
  assert.equal(original.memberId, 'before-seat');
  assert.equal(original.status, 'timeout');
});

test('same-member retry supersedes its generation and stale callbacks cannot affect the replacement', async t => {
  const f = fixture(t), cancel = new AbortController(), callbacks=[];
  const subscribe=f.store.onEventAppended.bind(f.store);
  f.store.onEventAppended=callback=>{callbacks.push(callback);return subscribe(callback);};
  const old=waitForAttention(f.store,f.worker,'commons',{after:f.after,timeoutSec:1,signal:cancel.signal});
  const superseded=assert.rejects(old,e=>e.status===409&&e.code==='attention_wait_superseded');
  const replacement=waitForAttention(f.store,f.worker,'commons',{after:f.after,timeoutSec:2});
  await superseded;
  callbacks[0]('commons'); // A writer captured this old listener before it was removed.
  cancel.abort();
  f.post('replacement-question',{toMemberId:'worker',body:'Please answer this question'});
  const result=await replacement;
  assert.equal(result.status,'ready');
  assert.deepEqual(result.items.map(item=>item.messageId),['replacement-question']);
  assert.equal(result.memberId,'worker');
});

test('superseding immediately before the old deadline preserves the new timeout', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture(t);
  const old=waitForAttention(f.store,f.worker,'commons',{after:f.after,timeoutSec:1});
  const superseded=assert.rejects(old,e=>e.code==='attention_wait_superseded');
  t.mock.timers.tick(999);
  const replacement=waitForAttention(f.store,f.worker,'commons',{after:f.after,timeoutSec:2});
  await superseded;
  t.mock.timers.tick(1);await Promise.resolve();
  f.post('new-generation',{toMemberId:'worker'});
  assert.equal((await replacement).status,'ready');
});
