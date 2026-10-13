// F1: open-questions radar — unanswered "?" messages surface, answered ones don't.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOpenQuestions, openQuestionRetention } from '../server/open-questions.mjs';
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

// Derivation must depend only on the viewer's readable projection, including
// when response candidates share a thread rather than a direct parent.
for (const relation of ['direct', 'shared-thread']) {
  const root = msg('root', 'a', 'Planning thread.', { createdAt: '2026-09-23T19:59:00.000Z' });
  const question = msg('question', 'a', 'What is next?', { replyToId: root.id });
  const response = msg('response', 'b', 'Next step recorded.', {
    replyToId: relation === 'direct' ? question.id : root.id,
    toMemberId: 'a', createdAt: '2026-09-23T20:01:00.000Z',
  });

  test(`${relation}: the question view is invariant to unreadable projection entries`, () => {
    for (const viewerId of ['viewer', null]) {
      for (const entry of [response,
        { ...response, body: 'Updated next step.', editedAt: '2026-09-23T20:02:00.000Z' },
        { ...response, deletedAt: '2026-09-23T20:02:00.000Z' }]) {
        const rows = findOpenQuestions({ messages: [root, question, entry], viewerId });
        assert.deepEqual(ids(rows), ['question']);
        assert.equal(rows[0].threadRootId, 'root');
      }
    }
  });

  test(`${relation}: readable answers retain participant and public behavior`, () => {
    for (const viewerId of ['a', 'b']) {
      assert.deepEqual(ids(findOpenQuestions({ messages: [root, question, response], viewerId })), []);
    }
    assert.deepEqual(ids(findOpenQuestions({
      messages: [root, question, { ...response, toMemberId: null }], viewerId: 'viewer',
    })), []);
    // A visible candidate must also be readable by the question's author.
    assert.deepEqual(ids(findOpenQuestions({
      messages: [root, question, { ...response, toMemberId: 'viewer' }], viewerId: 'viewer',
    })), ['question']);
    assert.deepEqual(ids(findOpenQuestions({
      messages: [root, question, { ...response, deletedAt: '2026-09-23T20:02:00.000Z' }], viewerId: 'a',
    })), ['question']);
  });
}

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

// Archive retention: whatever an archive drops, no viewer's open-questions list changes.
test('openQuestionRetention keeps what every viewer needs (randomized, with DMs, replies and deletions)', () => {
  let seed = 7;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const authors = ['a', 'b', 'c', 'd'];
  for (let round = 0; round < 1500; round++) {
    const messages = [];
    const size = 6 + rand(30);
    for (let i = 0; i < size; i++) {
      const authorId = authors[rand(4)];
      const message = { id: `m${i}`, authorId, body: rand(2) ? `q${i}?` : `s${i}`, createdAt: new Date(1e12 + i * 1000).toISOString() };
      if (i > 0 && rand(3) === 0) message.replyToId = `m${rand(i)}`;
      if (rand(4) === 0) message.toMemberId = authors[(authors.indexOf(authorId) + 1 + rand(3)) % 4];
      if (rand(10) === 0) message.deletedAt = message.createdAt;
      messages.push(message);
    }
    const pinned = new Set([`m${rand(size)}`, `m${rand(size)}`]);
    const keep = openQuestionRetention(messages, pinned);
    for (const id of pinned) keep.add(id);
    // The archive also keeps every reply ancestor of a kept message and the newest few.
    for (const message of messages.slice(-3)) keep.add(message.id);
    const byId = new Map(messages.map(message => [message.id, message]));
    for (const id of [...keep]) for (let parent = byId.get(byId.get(id)?.replyToId); parent && !keep.has(parent.id); parent = byId.get(parent.replyToId)) keep.add(parent.id);
    const remaining = messages.filter(message => keep.has(message.id));
    for (const viewerId of [null, ...authors]) {
      assert.deepEqual(findOpenQuestions({ messages: remaining, viewerId }).map(row => row.messageId),
        findOpenQuestions({ messages, viewerId }).map(row => row.messageId), `round ${round} viewer ${viewerId}`);
    }
  }
});

test('openQuestionRetention is not quadratic in a large room', () => {
  const messages = [];
  for (let i = 0; i < 20000; i++) {
    messages.push({ id: `m${i}`, authorId: `u${i % 50}`, body: i % 10 === 0 ? `q${i}?` : `s${i}`, createdAt: new Date(1e12 + i * 1000).toISOString(), ...(i > 3 && i % 3 === 0 ? { replyToId: `m${i - 3}` } : {}) });
  }
  const started = Date.now();
  openQuestionRetention(messages);
  assert.ok(Date.now() - started < 3000, 'one pass over 20k messages and 2k questions');
});

test('openQuestionRetention keeps a thread answer that is not a direct reply, and a DM answer to the asker', () => {
  const messages = [
    msg('q', 'a', 'ship it?', { createdAt: '2026-09-23T20:00:00.000Z' }),
    msg('r1', 'a', 'any thoughts', { replyToId: 'q', createdAt: '2026-09-23T20:01:00.000Z' }),
    msg('r2', 'b', 'yes', { replyToId: 'r1', createdAt: '2026-09-23T20:02:00.000Z' }),
    msg('pq', 'a', 'who has the key?', { createdAt: '2026-09-23T20:03:00.000Z' }),
    msg('dm', 'b', 'I do', { replyToId: 'pq', toMemberId: 'a', createdAt: '2026-09-23T20:04:00.000Z' }),
    msg('noise', 'c', 'unrelated', { createdAt: '2026-09-23T20:05:00.000Z' }),
  ];
  const keep = openQuestionRetention(messages, new Set(['q']));
  assert.ok(keep.has('q') && keep.has('r2'), 'the pinned question keeps the later answer in its thread');
  assert.ok(keep.has('pq') && keep.has('dm'), 'a public question closed only by a DM to its asker stays open for the public, so both stay');
  assert.ok(!keep.has('noise'));
});
