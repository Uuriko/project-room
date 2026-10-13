// F1: open-questions radar — unanswered "?" messages surface, answered ones don't.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOpenQuestions, openQuestionRetention } from '../server/open-questions.mjs';
import { closeKeepSet } from '../server/messages-store.mjs';
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
// mulberry32 is 32-bit safe (an LCG multiply overflows 2^53 and degenerates). The
// seed is logged and can be replayed with OPEN_QUESTIONS_FUZZ_SEED.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('closeKeepSet keeps what every viewer needs (randomized, with DMs, replies, deletions, pins and a tail)', () => {
  const seed = Number(process.env.OPEN_QUESTIONS_FUZZ_SEED) || 20261013;
  const rounds = Number(process.env.OPEN_QUESTIONS_FUZZ_ROUNDS) || 3000;
  console.log(`# open-questions fuzz seed ${seed}, ${rounds} rounds`);
  const random = mulberry32(seed);
  const rand = n => Math.floor(random() * n);
  const authors = ['a', 'b', 'c', 'd'];
  const seen = { messages: 0, questions: 0, publicReplies: 0, dms: 0, closedQuestions: 0, archivedSome: 0 };
  for (let round = 0; round < rounds; round++) {
    const messages = [];
    const size = 6 + rand(30);
    for (let i = 0; i < size; i++) {
      const authorId = authors[rand(4)];
      const message = { id: `m${i}`, authorId, body: rand(2) ? `q${i}?` : `s${i}`, createdAt: new Date(1e12 + i * 1000).toISOString() };
      if (i > 0 && rand(3) === 0) message.replyToId = `m${rand(i)}`;
      if (rand(5) === 0) message.toMemberId = authors[(authors.indexOf(authorId) + 1 + rand(3)) % 4];
      if (rand(12) === 0) message.deletedAt = message.createdAt;
      messages.push(message);
    }
    seen.messages += messages.length;
    seen.questions += messages.filter(m => m.body.includes('?')).length;
    seen.publicReplies += messages.filter(m => m.replyToId && !m.toMemberId).length;
    seen.dms += messages.filter(m => m.toMemberId).length;
    // What the archive keeps before closing: pins and the newest few.
    const keep = new Set([`m${rand(size)}`, `m${rand(size)}`]);
    for (const message of messages.slice(-(1 + rand(4)))) keep.add(message.id);
    closeKeepSet(messages, keep);
    const remaining = messages.filter(message => keep.has(message.id));
    if (remaining.length < messages.length) seen.archivedSome += 1;
    for (const viewerId of [null, ...authors]) {
      const before = findOpenQuestions({ messages, viewerId }).map(row => row.messageId);
      seen.closedQuestions += messages.filter(m => m.body.includes('?')).length - before.length;
      assert.deepEqual(findOpenQuestions({ messages: remaining, viewerId }).map(row => row.messageId), before,
        `seed ${seed} round ${round} viewer ${viewerId}`);
    }
  }
  // The generator really produces the cases the property is about.
  assert.ok(seen.questions > seen.messages * 0.3, `questions generated: ${JSON.stringify(seen)}`);
  assert.ok(seen.publicReplies > seen.messages * 0.15, `public replies generated: ${JSON.stringify(seen)}`);
  assert.ok(seen.dms > seen.messages * 0.1 && seen.dms < seen.messages * 0.3, `DMs are a minority: ${JSON.stringify(seen)}`);
  assert.ok(seen.closedQuestions > rounds, `answered questions generated: ${JSON.stringify(seen)}`);
  assert.ok(seen.archivedSome > rounds * 0.3, `rounds that really archive something: ${JSON.stringify(seen)}`);
});

test('closeKeepSet keeps a direct reply whose timestamp is older than its question', () => {
  const messages = [
    msg('q', 'a', 'ready?', { createdAt: '2026-09-23T20:05:00.000Z' }),
    msg('skew', 'b', 'yes', { replyToId: 'q', createdAt: '2026-09-23T20:01:00.000Z' }),
    msg('pad', 'c', 'noise', { createdAt: '2026-09-23T20:06:00.000Z' }),
  ];
  const keep = closeKeepSet(messages, new Set(['q']));
  assert.ok(keep.has('skew'), 'a direct reply closes the question whatever its clock says');
  const remaining = messages.filter(message => keep.has(message.id));
  assert.deepEqual(ids(findOpenQuestions({ messages: remaining, viewerId: null })), ids(findOpenQuestions({ messages, viewerId: null })));
});

test('closeKeepSet keeps the answer of a question that is only kept as a reply ancestor', () => {
  // q (asked), ans (answers q), k (a follow-up reply to q). k stays (newest), so its
  // ancestor q stays, and q must bring ans along or it reopens.
  const messages = [
    msg('q', 'a', 'ready?', { createdAt: '2026-09-23T20:00:00.000Z' }),
    msg('ans', 'b', 'yes', { replyToId: 'q', createdAt: '2026-09-23T20:01:00.000Z' }),
    msg('k', 'a', 'thanks', { replyToId: 'q', createdAt: '2026-09-23T20:02:00.000Z' }),
    msg('pad', 'c', 'noise', { createdAt: '2026-09-23T20:03:00.000Z' }),
  ];
  const keep = closeKeepSet(messages, new Set(['k']));
  assert.ok(keep.has('q') && keep.has('ans'), 'the ancestor question keeps its answer');
  assert.ok(!keep.has('pad'));
  const remaining = messages.filter(message => keep.has(message.id));
  for (const viewerId of [null, 'a', 'b']) {
    assert.deepEqual(ids(findOpenQuestions({ messages: remaining, viewerId })), ids(findOpenQuestions({ messages, viewerId })));
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

test('openQuestionRetention does not scan every DM per open question', () => {
  const messages = [];
  for (let i = 0; i < 5000; i++) messages.push({ id: `q${i}`, authorId: 'u0', body: `open ${i}?`, createdAt: new Date(1e12 + i * 1000).toISOString(), replyToId: 'root' });
  messages.unshift({ id: 'root', authorId: 'u0', body: 'thread', createdAt: new Date(1e12 - 1000).toISOString() });
  for (let i = 0; i < 10000; i++) messages.push({ id: `d${i}`, authorId: `u${i % 997}`, toMemberId: `u${(i % 3) ? (i * 7) % 997 + 40 : 0}`, body: `dm ${i}`, replyToId: 'root', createdAt: new Date(1e12 + 6e6 + i * 1000).toISOString() });
  const started = Date.now();
  openQuestionRetention(messages);
  assert.ok(Date.now() - started < 1000, `5k open questions over 10k DMs took ${Date.now() - started} ms`);
});

test('closeKeepSet keeps open questions even when nothing else is seeded', () => {
  const messages = [
    msg('open', 'a', 'who owns this?', { createdAt: '2026-09-23T20:00:00.000Z' }),
    msg('closed', 'a', 'is it up?', { createdAt: '2026-09-23T20:01:00.000Z' }),
    msg('ans', 'b', 'yes', { replyToId: 'closed', createdAt: '2026-09-23T20:02:00.000Z' }),
    msg('note', 'c', 'unrelated', { createdAt: '2026-09-23T20:03:00.000Z' }),
  ];
  const keep = closeKeepSet(messages, new Set());
  assert.ok(keep.has('open'), 'an open question stays with an empty seed');
  assert.ok(!keep.has('closed') && !keep.has('ans') && !keep.has('note'), 'an answered question and unrelated messages can go');
});

test('closeKeepSet follows a long chain of closing DMs in one pass', () => {
  // Each rung is a DM question whose closer is the next rung's DM: one kept id leads to the next.
  const rungs = 4000;
  const messages = [msg('root', 'z', 'thread', { createdAt: new Date(1e12 - 1000).toISOString() })];
  for (let i = 0; i < rungs; i++) {
    messages.push(msg(`d${i}`, `a${i + 1}`, `rung ${i}?`, { replyToId: 'root', toMemberId: `a${i}`, createdAt: new Date(1e12 + i * 2000).toISOString() }));
    messages.push(msg(`e${i}`, `a${i}`, `ack ${i}`, { replyToId: 'root', toMemberId: `a${i + 1}`, createdAt: new Date(1e12 + i * 2000 + 1000).toISOString() }));
  }
  const started = Date.now();
  const keep = closeKeepSet(messages, new Set(['d0']));
  const took = Date.now() - started;
  assert.equal(keep.size, 2 * rungs + 1, 'the whole ladder and its thread root stay');
  assert.ok(took < 1000, `a ${rungs}-rung ladder took ${took} ms (the per-round version took about 49 s)`);
});
