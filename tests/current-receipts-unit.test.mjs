import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {textVersion} from '../server/text-results.mjs';
import {currentReceiptClaims, currentReceiptClaim, currentRoomReceiptState} from '../server/current-receipts.mjs';

function room(t, representation) {
  const s = new RoomStore(':memory:'); t.after(() => s.close());
  const es = initialRoom();
  es.push(event({roomId: 'commons', actorId: 'owner', type: 'member.added', data: {memberId: 'worker', displayName: 'worker', kind: 'agent', permissions: ['accept_work', 'complete_work']}}));
  s.initialize(es, representation ? {representation} : undefined);
  const keys = {owner: s.issueAccessKey('commons', 'owner'), worker: s.issueAccessKey('commons', 'worker')};
  const cmd = (who, id, type, data) => s.command(keys[who], 'commons', {id, type, data});
  const rev = id => JSON.parse(s.db.prepare('SELECT body FROM work_entities WHERE work_id=?').get(id).body).revision;
  for (const id of ['done', 'open']) {
    cmd('owner', 'p-' + id, 'work.proposed', {workItemId: id, title: 'Task ' + id, definitionOfDone: 'Saved', accountableMemberId: 'worker', mode: 'read'});
    cmd('worker', 'a-' + id, 'work.accepted', {workItemId: id, expectedRevision: 0});
  }
  cmd('worker', 's-done', 'work.started', {workItemId: 'done', expectedRevision: rev('done')});
  const body = 'Result text', post = cmd('worker', 'result', 'message.posted', {messageId: 'result', body, workItemId: 'done'});
  cmd('worker', 'c-done', 'work.completed', {workItemId: 'done', expectedRevision: rev('done'), evidenceKind: 'room_text', evidenceMessageId: 'result',
    evidenceMessageEventId: post.event.id, evidenceVersion: textVersion(body), previousCompletionEventId: null, producerId: 'worker', summary: 'Saved', nextAction: 'Review'});
  return s;
}

test('native receipts list only completed work in current rooms and resolve one by id', t => {
  const s = room(t, 'normalized-current-v1');
  const claims = currentReceiptClaims(s, 'commons');
  assert.ok(Array.isArray(claims));
  assert.equal(claims.length, 1, JSON.stringify(claims));
  const [receipt] = claims;
  assert.deepEqual(currentReceiptClaim(s, 'commons', receipt.id), receipt);
  assert.equal(currentReceiptClaim(s, 'commons', 'no-such-claim'), undefined);
  assert.ok(currentRoomReceiptState(s, 'commons').room, 'bounded room metadata for the twin check');
});

test('legacy rooms are left to the Board registry (null)', t => {
  const s = room(t, null);
  assert.equal(currentReceiptClaims(s, 'commons'), null);
  assert.equal(currentReceiptClaim(s, 'commons', 'anything'), null);
  assert.equal(currentRoomReceiptState(s, 'commons'), null);
});
