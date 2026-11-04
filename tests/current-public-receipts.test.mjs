// Native (normalized-current-v1) public receipts: the opt-in toggle is a
// qualified current-room command, a verified + published work item
// projects to public_receipts, and opting out removes the rows in the
// toggle's own transaction. Fixture follows tests/current-public-work
// .test.mjs (normalized room, whole-room hydration forbidden) with the
// completion flow from tests/current-work-review.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event, hasConfirmedIndependentPass } from '../src/events.js';
import { textVersion } from '../server/text-results.mjs';
import { auditRecovery } from '../server/recovery.mjs';
import {
  loadPublicRoom, collectPublicReceipts, roomPageReceipts, roomProofRows,
  proofLevelOf, publicWorkItemReceiptId,
} from '../server/public-read-model.mjs';
import { publicRoomView } from '../server/public-rooms.mjs';
import { recordedReceiptsSetting } from '../server/public-visibility.mjs';

const ROOM = 'native-receipts-room';

function fixture(t, store) {
  const events = initialRoom(ROOM);
  for (const id of ['worker', 'verifier']) {
    events.push(event({ roomId: ROOM, actorId: 'owner', type: 'member.added',
      data: { memberId: id, displayName: id, kind: 'agent', permissions: ['accept_work', 'complete_work', 'verify', 'decide'] } }));
  }
  store.initialize(events, { representation: 'normalized-current-v1' });
  const keys = Object.fromEntries(['owner', 'worker', 'verifier'].map(id => [id, store.issueAccessKey(ROOM, id)]));
  const cmd = (who, id, type, data) => store.command(keys[who], ROOM, { id, type, data });
  const item = (id = 'task') => JSON.parse(store.db.prepare('SELECT body FROM work_entities WHERE room_id=? AND work_id=?').get(ROOM, id).body);
  store.room = () => { throw Error('Whole room hydration forbidden'); };
  return { store, keys, cmd, item };
}

function memoryFixture(t) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  return fixture(t, store);
}

function propose(f, id = 'task', extra = {}) {
  f.cmd('owner', 'propose-' + id, 'work.proposed', { workItemId: id, title: 'Native outcome ' + id,
    definitionOfDone: 'Saved result independently checked', accountableMemberId: 'worker',
    verifierMemberId: 'verifier', humanDecisionMakerId: 'owner',
    independentVerificationRequired: true, ownerDecisionRequired: true, mode: 'read', ...extra });
}

// accept -> post evidence -> complete -> verify (pass) -> owner decision.
function completeVerifyDecide(f, id = 'task') {
  f.cmd('worker', 'accept-' + id, 'work.accepted', { workItemId: id, expectedRevision: f.item(id).revision });
  const body = 'Saved complete result ' + id;
  const post = f.cmd('worker', 'result-' + id, 'message.posted', { messageId: 'result-' + id, body, workItemId: id });
  const version = textVersion(body);
  const completion = f.cmd('worker', 'complete-' + id, 'work.completed', { workItemId: id,
    expectedRevision: f.item(id).revision, evidenceKind: 'room_text', evidenceMessageId: 'result-' + id,
    evidenceMessageEventId: post.event.id, evidenceVersion: version, producerId: 'worker',
    previousCompletionEventId: null, summary: 'Saved', nextAction: 'Independent review' });
  f.cmd('owner', 'rationale-' + id, 'message.posted', { messageId: 'rationale-' + id, body: 'I reviewed the exact result' });
  f.cmd('verifier', 'verify-' + id, 'verification.recorded', { workItemId: id,
    expectedRevision: f.item(id).revision, result: 'pass', completionEventId: completion.event.id,
    evidenceVersion: version, summary: 'Exact result checked' });
  f.cmd('owner', 'decide-' + id, 'owner.decision_recorded', { workItemId: id,
    expectedRevision: f.item(id).revision, decision: 'approved', completionEventId: completion.event.id,
    evidenceVersion: version, reason: 'Accepted', sourceMessageId: 'rationale-' + id });
  return completion;
}

const rows = (store, roomId = ROOM) =>
  store.db.prepare('SELECT id, source FROM public_receipts WHERE origin_room_id=? ORDER BY id').all(roomId);
const mirror = (store, roomId = ROOM) =>
  store.db.prepare('SELECT enabled FROM room_public_receipts_setting WHERE room_id=?').get(roomId);

test('1. toggle admitted: owner room.public_receipts_set succeeds in a native room; mirror records it', t => {
  const f = memoryFixture(t);
  // A non-owner toggle is still refused by the reducer.
  assert.throws(() => f.cmd('worker', 'toggle-by-worker', 'room.public_receipts_set', { enabled: true }), /owner/i);
  assert.equal(mirror(f.store), undefined);
  f.cmd('owner', 'page-on', 'room.public_page_set', { enabled: true });
  // At the pre-fix head this command 409s current_room_context_unavailable.
  f.cmd('owner', 'toggle-on', 'room.public_receipts_set', { enabled: true });
  assert.equal(mirror(f.store)?.enabled, 1);
  assert.equal(loadPublicRoom(f.store, ROOM).receiptsEnabled, true);
});

test('2. verified outcome projects: exactly one wir_ row, served on every public face', t => {
  const f = memoryFixture(t);
  f.cmd('owner', 'page-on', 'room.public_page_set', { enabled: true });
  f.cmd('owner', 'toggle-on', 'room.public_receipts_set', { enabled: true });
  propose(f);
  completeVerifyDecide(f);
  f.cmd('owner', 'publish', 'work.public_set', { workItemId: 'task', enabled: true });
  const projected = rows(f.store);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].source, 'work-item');
  assert.match(projected[0].id, /^wir_[a-f0-9]{32}$/);
  assert.equal(projected[0].id, publicWorkItemReceiptId(ROOM, 'task'));
  const id = projected[0].id;
  assert.ok(roomPageReceipts(f.store, ROOM, true).some(r => r.id === id), 'room page receipts serve the row');
  const proof = roomProofRows(f.store, ROOM);
  assert.ok(proof.some(r => r.id === id), 'proof rows serve the row');
  assert.equal(proofLevelOf(proof.find(r => r.id === id)), 'room-recorded-completion');
  assert.ok(collectPublicReceipts(f.store).some(r => r.id === id), 'global feed serves the row');
  assert.ok(publicRoomView(f.store, ROOM).document.receipts.some(r => r.id === id), 'room view serves the row');
});

test('3. consent negatives: each missing leg yields zero rows', t => {
  // (a) verified + room setting on, but no work.public_set intent.
  {
    const f = memoryFixture(t);
    f.cmd('owner', 'toggle-on', 'room.public_receipts_set', { enabled: true });
    propose(f); completeVerifyDecide(f);
    assert.equal(f.item().state, 'completed');
    assert.equal(hasConfirmedIndependentPass(f.item()), true);
    assert.deepEqual(rows(f.store), [], 'verified but unpublished intent projects nothing');
  }
  // (b) published + room setting on, but verification absent:
  // hasConfirmedIndependentPass is false on the completed item itself.
  {
    const f = memoryFixture(t);
    f.cmd('owner', 'toggle-on', 'room.public_receipts_set', { enabled: true });
    propose(f);
    f.cmd('worker', 'accept', 'work.accepted', { workItemId: 'task', expectedRevision: f.item().revision });
    const body = 'Saved complete result task';
    const post = f.cmd('worker', 'result', 'message.posted', { messageId: 'result', body, workItemId: 'task' });
    f.cmd('worker', 'complete', 'work.completed', { workItemId: 'task', expectedRevision: f.item().revision,
      evidenceKind: 'room_text', evidenceMessageId: 'result', evidenceMessageEventId: post.event.id,
      evidenceVersion: textVersion(body), producerId: 'worker', previousCompletionEventId: null,
      summary: 'Saved', nextAction: 'Independent review' });
    f.cmd('owner', 'publish', 'work.public_set', { workItemId: 'task', enabled: true });
    assert.equal(f.item().state, 'completed');
    assert.equal(hasConfirmedIndependentPass(f.item()), false);
    assert.deepEqual(rows(f.store), [], 'published but unverified projects nothing');
  }
  // (c) published + verified, but the room setting was never recorded.
  {
    const f = memoryFixture(t);
    propose(f); completeVerifyDecide(f);
    f.cmd('owner', 'publish', 'work.public_set', { workItemId: 'task', enabled: true });
    assert.equal(mirror(f.store), undefined);
    assert.deepEqual(rows(f.store), [], 'no recorded room setting projects nothing');
  }
  // (d) setting recorded, item completed + verified before any publish
  // intent: nothing projects at completion time.
  {
    const f = memoryFixture(t);
    f.cmd('owner', 'toggle-on', 'room.public_receipts_set', { enabled: true });
    propose(f); completeVerifyDecide(f);
    assert.deepEqual(rows(f.store), [], 'completion before publish intent projects nothing');
  }
});

test('4. opt-out removes rows in the toggle transaction; re-opt-in re-projects only on the next qualifying transition', t => {
  const f = memoryFixture(t);
  f.cmd('owner', 'page-on', 'room.public_page_set', { enabled: true });
  f.cmd('owner', 'toggle-on', 'room.public_receipts_set', { enabled: true });
  propose(f); completeVerifyDecide(f);
  f.cmd('owner', 'publish', 'work.public_set', { workItemId: 'task', enabled: true });
  const id = publicWorkItemReceiptId(ROOM, 'task');
  assert.equal(rows(f.store).length, 1);
  f.cmd('owner', 'toggle-off', 'room.public_receipts_set', { enabled: false });
  assert.deepEqual(rows(f.store), [], 'opt-out deletes the rows in its own transaction');
  assert.equal(mirror(f.store)?.enabled, 0);
  assert.deepEqual(roomPageReceipts(f.store, ROOM, true), [], 'room page serves nothing');
  assert.deepEqual(roomProofRows(f.store, ROOM), [], 'proof page serves nothing');
  assert.ok(!collectPublicReceipts(f.store).some(r => r.id === id), 'global feed serves nothing');
  assert.deepEqual(publicRoomView(f.store, ROOM).document.receipts, [], 'room view serves nothing');
  // The recorded setting reads back as a recorded 0 through the native leg.
  assert.deepEqual(recordedReceiptsSetting(f.store.db, ROOM), { status: 'recorded', enabled: 0 });
  // Back on: the mirror flips level-triggered, but rows are
  // edge-triggered — nothing re-projects retroactively...
  f.cmd('owner', 'toggle-on-again', 'room.public_receipts_set', { enabled: true });
  assert.equal(mirror(f.store)?.enabled, 1);
  assert.deepEqual(rows(f.store), [], 're-opt-in alone re-projects nothing');
  // ...until the item's next qualifying transition (a fresh verification).
  const item = f.item();
  f.cmd('verifier', 'verify-again', 'verification.recorded', { workItemId: 'task',
    expectedRevision: item.revision, result: 'pass', completionEventId: item.receipt.eventId,
    evidenceVersion: item.receipt.evidenceVersion, summary: 'Exact result re-checked' });
  assert.equal(rows(f.store).length, 1, 'the next qualifying transition re-projects');
});

test('5. guard narrowed: with receipts ON, ordinary commands and toggle-off all succeed', t => {
  const f = memoryFixture(t);
  f.cmd('owner', 'toggle-on', 'room.public_receipts_set', { enabled: true });
  // At the pre-fix head each of these 409s once the setting is on
  // (the line-603 one-way trap behind the missing qualification).
  f.cmd('owner', 'chat', 'message.posted', { messageId: 'chat', body: 'Receipts are on' });
  propose(f, 'second');
  f.cmd('owner', 'publish-second', 'work.public_set', { workItemId: 'second', enabled: true });
  f.cmd('owner', 'toggle-off', 'room.public_receipts_set', { enabled: false });
  assert.equal(mirror(f.store)?.enabled, 0);
  // And with receipts OFF the same commands behave as at head.
  f.cmd('owner', 'chat-2', 'message.posted', { messageId: 'chat-2', body: 'Receipts are off' });
});

test('6. durability: mirror and rows survive close + reopen; recovery audit is clean', t => {
  const dir = mkdtempSync(join(tmpdir(), 'native-public-receipts-'));
  const path = join(dir, 'db.sqlite');
  let store = new RoomStore(path);
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const f = fixture(t, store);
  f.cmd('owner', 'toggle-on', 'room.public_receipts_set', { enabled: true });
  propose(f); completeVerifyDecide(f);
  f.cmd('owner', 'publish', 'work.public_set', { workItemId: 'task', enabled: true });
  const beforeRows = rows(store);
  assert.equal(beforeRows.length, 1);
  store.close();
  store = new RoomStore(path);
  store.room = () => { throw Error('Whole room hydration forbidden'); };
  assert.deepEqual(rows(store), beforeRows);
  assert.equal(mirror(store)?.enabled, 1);
  assert.doesNotThrow(() => auditRecovery(store));
});

test('7. adversarial: publish intent revoked after projection removes the row; archive purges it', t => {
  // Intent revoked after projection: the very transition that revokes
  // must un-serve the receipt — no stale public row survives consent
  // being withdrawn.
  {
    const f = memoryFixture(t);
    f.cmd('owner', 'toggle-on', 'room.public_receipts_set', { enabled: true });
    propose(f); completeVerifyDecide(f);
    f.cmd('owner', 'publish', 'work.public_set', { workItemId: 'task', enabled: true });
    assert.equal(rows(f.store).length, 1);
    f.cmd('owner', 'unpublish', 'work.public_set', { workItemId: 'task', enabled: false });
    assert.deepEqual(rows(f.store), [], 'revoked intent removes the row in the same transaction');
    assert.ok(!collectPublicReceipts(f.store).some(r => r.id === publicWorkItemReceiptId(ROOM, 'task')));
  }
  // Archiving the room purges its projected rows.
  {
    const f = memoryFixture(t);
    f.cmd('owner', 'toggle-on', 'room.public_receipts_set', { enabled: true });
    propose(f); completeVerifyDecide(f);
    f.cmd('owner', 'publish', 'work.public_set', { workItemId: 'task', enabled: true });
    assert.equal(rows(f.store).length, 1);
    f.cmd('owner', 'archive', 'room.archived', {});
    assert.deepEqual(rows(f.store), [], 'archive purges the room rows');
  }
});
