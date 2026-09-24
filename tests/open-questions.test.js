// F1: open-questions radar — unanswered "?" messages surface, answered ones don't.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOpenQuestions } from '../server/open-questions.mjs';
import { listOpenQuestions } from '../server/open-questions.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { setTier } from '../server/autonomy-tiers.mjs';

const msg = (id, authorId, body, extra = {}) => ({
  id, authorId, body, createdAt: '2026-09-23T20:00:00.000Z', ...extra,
});
const ids = rows => rows.map(r => r.messageId);

test('a lone question is open', () => {
  const rows = findOpenQuestions({ messages: [msg('m1', 'a', 'How do we ship this?')] });
  assert.deepEqual(ids(rows), ['m1']);
  assert.equal(rows[0].authorId, 'a');
  assert.equal(rows[0].threadRootId, 'm1');
  assert.ok(rows[0].excerpt.includes('How do we ship'));
});

test('statements without a question mark are not questions', () => {
  const rows = findOpenQuestions({ messages: [msg('m1', 'a', 'Shipping today.')] });
  assert.deepEqual(ids(rows), []);
});

test('a direct reply from a different author closes the question', () => {
  const rows = findOpenQuestions({ messages: [
    msg('m1', 'a', 'How do we ship this?'),
    msg('m2', 'b', 'With the usual flow.', { replyToId: 'm1' }),
  ]});
  assert.deepEqual(ids(rows), []);
});

test('a later same-thread message from a different author closes the question', () => {
  const rows = findOpenQuestions({ messages: [
    msg('m1', 'a', 'How do we ship this?'),
    msg('m2', 'b', 'Good point, let me check.', { replyToId: 'm1', createdAt: '2026-09-23T20:01:00.000Z' }),
  ]});
  assert.deepEqual(ids(rows), []);
});

test("the asker's own follow-up does not close the question", () => {
  const rows = findOpenQuestions({ messages: [
    msg('m1', 'a', 'How do we ship this?'),
    msg('m2', 'a', 'Still stuck here, posting an update.', { replyToId: 'm1', createdAt: '2026-09-23T20:05:00.000Z' }),
  ]});
  assert.deepEqual(ids(rows), ['m1']);
});

test('a deleted question is excluded', () => {
  const rows = findOpenQuestions({ messages: [
    msg('m1', 'a', 'How do we ship this?', { deletedAt: '2026-09-23T20:02:00.000Z' }),
  ]});
  assert.deepEqual(ids(rows), []);
});

test('a deleted reply does not close the question', () => {
  const rows = findOpenQuestions({ messages: [
    msg('m1', 'a', 'How do we ship this?'),
    msg('m2', 'b', 'With the usual flow.', { replyToId: 'm1', deletedAt: '2026-09-23T20:02:00.000Z' }),
  ]});
  assert.deepEqual(ids(rows), ['m1']);
});

test('an earlier same-thread message from another author does not close the question', () => {
  const rows = findOpenQuestions({ messages: [
    msg('m0', 'b', 'Starting the deploy thread.', { createdAt: '2026-09-23T19:59:00.000Z' }),
    msg('m1', 'a', 'Wait — how do we ship this?', { replyToId: 'm0', createdAt: '2026-09-23T20:00:00.000Z' }),
  ]});
  assert.deepEqual(ids(rows), ['m1']);
  assert.equal(rows[0].threadRootId, 'm0');
});

test('DM scoping: other members\u2019 DMs stay invisible to the viewer', () => {
  const messages = [
    msg('m1', 'a', 'Public question here?'),
    msg('m2', 'b', 'Private question?', { toMemberId: 'c' }),
    msg('m3', 'c', 'Question for you, viewer?', { toMemberId: 'viewer' }),
  ];
  assert.deepEqual(ids(findOpenQuestions({ messages, viewerId: 'viewer' })), ['m1', 'm3']);
  assert.deepEqual(ids(findOpenQuestions({ messages, viewerId: 'nobody' })), ['m1']);
});

test('newest questions sort first', () => {
  const rows = findOpenQuestions({ messages: [
    msg('m1', 'a', 'First?', { createdAt: '2026-09-23T20:00:00.000Z' }),
    msg('m2', 'b', 'Second?', { createdAt: '2026-09-23T20:10:00.000Z' }),
  ]});
  assert.deepEqual(ids(rows), ['m2', 'm1']);
});

const command = (type, data) => ({ id: crypto.randomUUID(), type, data });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'room-openq-'));
  const filename = join(directory, 'room.sqlite');
  const store = new RoomStore(filename, { now: () => Date.now() });
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey('commons', 'owner') };
  for (const id of ['agent-a', 'agent-b']) {
    store.command(keys.owner, 'commons', command(T.MEMBER_ADDED, {
      memberId: id, displayName: id, kind: 'agent', accountableHumanId: 'owner',
      permissions: ['accept_work', 'complete_work'],
    }));
    keys[id] = store.issueAccessKey('commons', id);
  }
  // #953: new agent members default to t1_readonly; agents need write access for message.posted
  for (const id of ['agent-a', 'agent-b'])
    setTier(store.db, 'commons', id, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { store, keys };
}

test('listOpenQuestions serves the radar over HTTP-shaped reads', t => {
  const { store, keys } = fixture(t);
  store.command(keys['agent-a'], 'commons', command(T.MESSAGE_POSTED, { messageId: 'q1', body: 'How do we ship this?' }));
  store.command(keys['agent-b'], 'commons', command(T.MESSAGE_POSTED, { messageId: 'q2', body: 'And when?' }));
  store.command(keys['agent-b'], 'commons', command(T.MESSAGE_POSTED, { messageId: 'r1', body: 'Today.', replyToId: 'q1' }));
  const out = listOpenQuestions(store, keys['agent-b'], 'commons', {});
  assert.equal(out.roomId, 'commons');
  assert.equal(out.viewerId, 'agent-b');
  assert.deepEqual(out.openQuestions.map(q => q.messageId), ['q2']);
});

test('listOpenQuestions rejects a bad limit', t => {
  const { store, keys } = fixture(t);
  for (const limit of [0, 101]) {
    try {
      listOpenQuestions(store, keys.owner, 'commons', { limit });
      assert.fail(`limit ${limit} should throw`);
    } catch (error) {
      assert.equal(error.code, 'invalid_open_questions_limit');
    }
  }
});
