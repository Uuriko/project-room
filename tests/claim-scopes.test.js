import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T, event } from '../src/events.js';
import { claimScope, conflictingClaim } from '../server/claim-scopes.mjs';
import { boardClaimId } from '../server/work-claim-mirror.mjs';
import { makeTestSigner } from '../scripts/helpers/signed-evidence.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

const command = (type, data) => ({ id: crypto.randomUUID(), type, data });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'room-scopes-'));
  const filename = join(directory, 'room.sqlite');
  let now = Date.now();
  const store = new RoomStore(filename, { now: () => now });
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey('commons', 'owner') };
  for (const id of ['a', 'b', 'viewer']) {
    store.command(keys.owner, 'commons', command(T.MEMBER_ADDED, { memberId: id, displayName: id, kind: 'agent', accountableHumanId: 'owner',
      permissions: id === 'viewer' ? [] : ['accept_work', 'complete_work', 'write_external'] }));
    keys[id] = store.issueAccessKey('commons', id);
  }
  // #953: new agent members default to t1_readonly; a and b need write access
  for (const id of ['a', 'b'])
    setTier(store.db, 'commons', id, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  const item = id => store.room('commons').state.workItems[id];
  const mutate = (actor, type, id, data = {}) => store.command(keys[actor], 'commons', command(type, { workItemId: id, expectedRevision: item(id).revision, ...data }));
  const propose = (id, actor = 'a', mode = 'write') => {
    store.command(keys.owner, 'commons', command(T.WORK_PROPOSED, { workItemId: id, title: id, definitionOfDone: 'Versioned result', accountableMemberId: actor, mode, independentVerificationRequired: false, ownerDecisionRequired: false }));
    mutate(actor, T.WORK_ACCEPTED, id);
  };
  const scope = (paths = ['src/**']) => ({ repository: 'test/repo', ref: 'draft', paths, expiresAt: new Date(now + 60000).toISOString() });
  const signEvidence = makeTestSigner(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, filename, keys, item, mutate, propose, scope, signEvidence, advance: ms => { now += ms; } };
}

test('projection claims follow the board writer profile and do not grant write_external', t => {
  const f = fixture(t);
  const add = (id, permissions) => {
    f.store.command(f.keys.owner, 'commons', command(T.MEMBER_ADDED, {
      memberId: id, displayName: id, kind: 'agent', accountableHumanId: 'owner', permissions,
    }));
    setTier(f.store.db, 'commons', id, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
    return f.store.issueAccessKey('commons', id);
  };
  const externalKey = add('external-only', ['accept_work', 'write_external']);
  const contributeKey = add('contributor', ['accept_work', 'complete_work']);
  const send = (key, type, data) => f.store.command(key, 'commons', command(type, data));
  const propose = (id, actor, key) => {
    send(f.keys.owner, T.WORK_PROPOSED, {
      workItemId: id, title: id, definitionOfDone: 'Versioned result', accountableMemberId: actor, mode: 'write',
      independentVerificationRequired: false, ownerDecisionRequired: false,
    });
    send(key, T.WORK_ACCEPTED, { workItemId: id, expectedRevision: 0 });
  };
  propose('ext', 'external-only', externalKey);
  assert.throws(
    () => send(externalKey, T.CLAIM_ACQUIRED, { workItemId: 'ext', expectedRevision: 1, ...f.scope(['docs/ext.md']) }),
    { status: 403, code: 'work_claims_not_permitted' });
  assert.equal(f.item('ext').claim ?? null, null);
  propose('board', 'contributor', contributeKey);
  send(contributeKey, T.CLAIM_ACQUIRED, { workItemId: 'board', expectedRevision: 1, ...f.scope(['docs/board.md']) });
  assert.equal(f.item('board').claim.status, 'active');
  assert.equal(f.item('board').claim.holderId, 'contributor');
  assert.equal(f.store.room('commons').state.members.contributor.permissions.includes('write_external'), false);
  assert.throws(
    () => send(externalKey, T.CLAIM_RELEASED, { workItemId: 'board', expectedRevision: f.item('board').revision }),
    { status: 403, code: 'work_claims_not_permitted' });
  assert.equal(f.item('board').claim.status, 'active');
  f.advance(1000);
  const posted = send(contributeKey, T.MESSAGE_POSTED, { messageId: 'board-progress', body: 'Still on docs/board.md' });
  send(contributeKey, T.CLAIM_RENEWED, {
    workItemId: 'board', expectedRevision: f.item('board').revision, progressMessageId: 'board-progress',
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });
  assert.equal(f.item('board').claim.renewals, 1);
  assert.equal(posted.event.type, T.MESSAGE_POSTED);
  send(contributeKey, T.CLAIM_RELEASED, { workItemId: 'board', expectedRevision: f.item('board').revision });
  assert.equal(f.item('board').claim.status, 'released');
});

test('separate work claims serialize across database connections with no rejected event or receipt', t => {
  const f = fixture(t);
  f.propose('first'); f.propose('second', 'b');
  const other = new RoomStore(f.filename);
  t.after(() => other.close());
  f.mutate('a', T.CLAIM_ACQUIRED, 'first', f.scope());
  const before = f.store.snapshot(f.keys.owner, 'commons');
  const rejected = command(T.CLAIM_ACQUIRED, { workItemId: 'second', expectedRevision: 1, ...f.scope(['src/app.js']) });
  assert.throws(() => other.command(f.keys.b, 'commons', rejected), { code: 'claim_conflict', status: 409 });
  assert.deepEqual(f.store.snapshot(f.keys.owner, 'commons'), before);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM commands WHERE id=?').get(rejected.id).n, 0);
  f.mutate('a', T.CLAIM_RELEASED, 'first');
  assert.equal(other.command(f.keys.b, 'commons', rejected).duplicate, false);
});

test('same holder conflicts too; unrelated targets, refs and rooms remain independent', t => {
  const f = fixture(t);
  f.propose('first'); f.propose('same-holder'); f.propose('separate');
  f.mutate('a', T.CLAIM_ACQUIRED, 'first', f.scope());
  assert.throws(() => f.mutate('a', T.CLAIM_ACQUIRED, 'same-holder', f.scope()), { code: 'claim_conflict' });
  f.mutate('a', T.CLAIM_ACQUIRED, 'separate', f.scope(['tests/**']));
  f.mutate('a', T.CLAIM_ACQUIRED, 'same-holder', { ...f.scope(), ref: 'isolated-draft' });
  f.propose('read', 'b', 'read'); f.mutate('b', T.WORK_STARTED, 'read');
  f.store.initialize(initialRoom('other-room'));
  const key = f.store.issueAccessKey('other-room', 'owner');
  const send = (type, data) => f.store.command(key, 'other-room', command(type, data));
  send(T.WORK_PROPOSED, { workItemId: 'private', title: 'Private work', definitionOfDone: 'Separate room', accountableMemberId: 'owner', mode: 'write', independentVerificationRequired: false, ownerDecisionRequired: false });
  send(T.WORK_ACCEPTED, { workItemId: 'private', expectedRevision: 0 });
  send(T.CLAIM_ACQUIRED, { workItemId: 'private', expectedRevision: 1, ...f.scope() });
});

test('path matching is segment-aware and only supports explicit paths or trailing subtrees', () => {
  const claim = paths => ({ repository: 'test/repo', ref: 'draft', status: 'active', paths, expiresAt: new Date(2000).toISOString() });
  const conflict = (left, right) => conflictingClaim({ a: { id: 'a', claim: claim(left) } }, { id: 'b', claim: claim(right) }, 1000);
  for (const [left, right] of [[['src/**'], ['src/app.js']], [['src/app.js'], ['src/**']], [['**'], ['index.html']], [['./src/app.js'], ['src/app.js']], [['src/**'], ['src']]]) assert.ok(conflict(left, right));
  for (const [left, right] of [[['src/**'], ['src-other/app.js']], [['src/a.js'], ['src/b.js']], [['a/**'], ['b/**']]]) assert.equal(conflict(left, right), null);
  for (const value of ['', '/src/app.js', '../src/app.js', 'src/../app.js', 'src/*.js', 'src//app.js', 'src\\app.js', 7]) assert.throws(() => claimScope(claim([value])), { code: 'invalid_claim_scope' });
  assert.ok(conflict(['legacy/*.js'], ['other.js']), 'ambiguous active historical scope conservatively needs review');
});

test('release is revision-checked; only the holder or manager can free a reservation', t => {
  const f = fixture(t); f.propose('work');
  f.mutate('a', T.CLAIM_ACQUIRED, 'work', f.scope());
  assert.throws(() => f.mutate('b', T.CLAIM_RELEASED, 'work'), /holder or claim manager/);
  assert.throws(() => f.store.command(f.keys.a, 'commons', command(T.CLAIM_RELEASED, { workItemId: 'work', expectedRevision: 1 })), /Stale/);
  f.mutate('owner', T.CLAIM_RELEASED, 'work');
  assert.equal(f.item('work').claim.status, 'released');
  assert.equal(f.item('work').state, 'accepted', 'release does not invent pause, completion or external stop');
});

test('blocked and completed work retains scope until release; expiry and supersession free it', t => {
  const f = fixture(t); f.propose('first'); f.propose('second', 'b');
  f.mutate('a', T.CLAIM_ACQUIRED, 'first', f.scope());
  f.mutate('a', T.WORK_BLOCKED, 'first', { reason: 'Need a decision', nextAction: 'Clarify scope' });
  assert.throws(() => f.mutate('b', T.CLAIM_ACQUIRED, 'second', f.scope()), { code: 'claim_conflict' });
  f.mutate('a', T.WORK_BLOCKER_RESOLVED, 'first', { resolution: 'Clarified' });
  f.mutate('a', T.WORK_COMPLETED, 'first', { summary: 'Draft', evidenceUrl: 'https://example.invalid/draft', evidenceVersion: 'v1', producerId: 'a', nextAction: 'Review', signedEvidence: f.signEvidence() });
  assert.throws(() => f.mutate('b', T.CLAIM_ACQUIRED, 'second', f.scope()), { code: 'claim_conflict' });
  f.advance(60001);
  f.mutate('b', T.CLAIM_ACQUIRED, 'second', f.scope());
  f.propose('replacement');
  f.mutate('owner', T.WORK_SUPERSEDED, 'second', { supersededByWorkItemId: 'replacement', reason: 'New agreed scope' });
  f.mutate('a', T.CLAIM_ACQUIRED, 'replacement', f.scope());
  f.store.command(f.keys.b, 'commons', command(T.MESSAGE_POSTED, { workItemId: 'second', body: 'Late artifact: https://example.invalid/late. Proposal only.' }));
  assert.equal(f.item('second').state, 'superseded');
});

test('an identical claim retry returns its original committed result after release and reassignment', t => {
  const f = fixture(t); f.propose('first'); f.propose('second', 'b');
  const c = command(T.CLAIM_ACQUIRED, { workItemId: 'first', expectedRevision: 1, ...f.scope() });
  const original = f.store.command(f.keys.a, 'commons', c);
  f.mutate('a', T.CLAIM_RELEASED, 'first');
  f.mutate('b', T.CLAIM_ACQUIRED, 'second', f.scope());
  const retry = f.store.command(f.keys.a, 'commons', c);
  assert.equal(retry.duplicate, true); assert.equal(retry.event.id, original.event.id);
  assert.equal(f.item('first').claim.status, 'released', 'retry does not restore authority');
});

test('projection acquire, heartbeat, handoff, and supersede show up on the work-claims board', t => {
  const f = fixture(t);
  f.propose('lane');
  f.mutate('a', T.CLAIM_ACQUIRED, 'lane', {
    ...f.scope(['src/app.js']),
    pullRequests: ['https://github.com/Uuriko/project-room/pull/4'],
    blocks: [{ path: 'src/app.js', block: 'header' }]
  });
  const acquired = f.store.workClaims.get('commons', 'lane');
  assert.equal(acquired.state, 'claimed');
  assert.equal(acquired.owner, 'a');
  assert.equal(acquired.repo, 'test/repo');
  assert.equal(acquired.branch, 'draft');
  assert.deepEqual(acquired.fileBlocks, { 'src/app.js': 'header' });
  assert.equal(acquired.pullRequests[0].url, 'https://github.com/Uuriko/project-room/pull/4');
  const before = Date.parse(acquired.leaseExpiresAt);
  f.advance(1000);
  f.mutate('a', T.CLAIM_RENEWED, 'lane', { expiresAt: new Date(Date.now() + 120000).toISOString() });
  const renewed = f.store.workClaims.get('commons', 'lane');
  assert.ok(Date.parse(renewed.leaseExpiresAt) > before);
  f.mutate('a', T.WORK_HANDOFF_RECORDED, 'lane', {
    doneSummary: 'Header is drafted', nextAction: 'Review the header', limitReason: 'Context is full'
  });
  const handed = f.store.workClaims.get('commons', 'lane');
  assert.equal(handed.chain.at(-1).kind, 'handoff');
  assert.equal(handed.chain.at(-1).targetId, boardClaimId('lane-next'));
  const successor = f.store.workClaims.get('commons', 'lane-next');
  assert.deepEqual(successor.dependsOn, ['lane']);
  assert.equal(successor.title, 'Review the header');
  f.store.command(f.keys.owner, 'commons', command(T.WORK_PROPOSED, {
    workItemId: 'lane-b', title: 'Replacement', definitionOfDone: 'Versioned result',
    accountableMemberId: 'owner', mode: 'write', independentVerificationRequired: false, ownerDecisionRequired: false
  }));
  f.store.command(f.keys.owner, 'commons', command(T.WORK_SUPERSEDED, {
    workItemId: 'lane', expectedRevision: f.item('lane').revision, supersededByWorkItemId: 'lane-b', reason: 'Direction changed'
  }));
  const superseded = f.store.workClaims.get('commons', 'lane');
  assert.equal(superseded.supersededBy, 'lane-b');
  assert.equal(superseded.chain.at(-1).kind, 'supersede');
  assert.deepEqual(f.store.workClaims.get('commons', 'lane-b').dependsOn, ['lane']);
});

test('historical overlapping reservations still initialize, replay and reopen unchanged', t => {
  const f = fixture(t);
  const roomId = 'legacy';
  const events = initialRoom(roomId);
  for (const id of ['first', 'second']) {
    const add = (type, data) => events.push(event({ type, actorId: 'owner', roomId, data }));
    add(T.WORK_PROPOSED, { workItemId: id, title: id, definitionOfDone: 'Historical draft', accountableMemberId: 'owner', mode: 'write', independentVerificationRequired: false, ownerDecisionRequired: false });
    add(T.WORK_ACCEPTED, { workItemId: id, expectedRevision: 0 });
    add(T.CLAIM_ACQUIRED, { workItemId: id, expectedRevision: 1, ...f.scope() });
  }
  f.store.initialize(events);
  const before = f.store.room(roomId).state;
  const rebuilt = f.store.rebuildProjection(roomId);
  assert.deepEqual(rebuilt.state, before);
  assert.equal(rebuilt.sequence, f.store.room(roomId).sequence);
  assert.deepEqual(f.store.room(roomId).state, before);
  const reopened = new RoomStore(f.filename);
  try { assert.deepEqual(reopened.room(roomId).state, before); } finally { reopened.close(); }
});
