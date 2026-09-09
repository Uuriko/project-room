import test from 'node:test';
import assert from 'node:assert/strict';
import { searchWork } from '../src/work-selectors.js';

const item = (id, fields = {}) => ({ id, title: 'Prepare an agenda', definitionOfDone: 'Name the participants',
  state: 'proposed', accountableMemberId: 'owner', verifierMemberId: 'reviewer', humanDecisionMakerId: 'decider',
  updatedAt: '2026-09-08T00:00:00.000Z', receipt: null, ...fields });
const room = (...items) => ({ members: { owner: { displayName: 'Maya' }, reviewer: { displayName: 'Rae' }, decider: { displayName: 'Alex' } },
  workItems: Object.fromEntries(items.map(work => [work.id, work])) });

test('work search matches current fields literally without mutating the supplied room', () => {
  const state = room(item('work:one', { title: 'Café 🚀 [agenda]', receipt: { summary: 'Two speakers', nextAction: 'Bring a notebook' } }));
  const before = JSON.stringify(state);
  for (const query of ['  CAFÉ  ', '🚀', '[agenda]', 'work:one', 'participants', 'speakers', 'notebook', 'maya', 'RAE', 'Alex']) {
    assert.equal(searchWork(state, query).total, 1, query);
  }
  for (const query of ['.*', 'missing', '  ']) assert.equal(searchWork(state, query).total, 0);
  assert.equal(JSON.stringify(state), before);
  assert.equal(searchWork(state, 'agenda').work[0].excerpt, 'Two speakers', 'a title hit previews the current reported result when present');
  assert.equal(searchWork(room(), 'agenda').total, 0);
});

test('work search preserves resolved work and sorts open first, then update and exact ID', () => {
  const state = room(item('z'), item('a'), item('recent', { updatedAt: '2026-09-08T12:00:00.000Z' }),
    item('done', { state: 'completed', independentVerificationRequired: false, ownerDecisionRequired: false,
      receipt: { eventId: 'completion', evidenceVersion: 'v1' }, updatedAt: '2026-09-08T14:00:00.000Z' }),
    item('old', { state: 'superseded', supersededBy: 'a', updatedAt: '2026-09-08T13:00:00.000Z' }));
  assert.deepEqual(searchWork(state, 'agenda').work.map(hit => hit.item.id), ['recent', 'a', 'z', 'done', 'old']);
  assert.equal(searchWork(state, 'done').work[0].item.id, 'done');
});

test('work search caps results and query while preserving total and useful Unicode excerpts', () => {
  const state = room(...Array.from({ length: 31 }, (_, index) => item(String(index).padStart(2, '0'))));
  assert.equal(searchWork(state, 'agenda').work.length, 25);
  assert.equal(searchWork(state, 'agenda').total, 31);
  assert.equal(searchWork(state, 'agenda', 2).work.length, 2);
  for (const limit of [0, -1, 26, 1.5, '2']) assert.throws(() => searchWork(state, '', limit), RangeError);
  const long = room(item('long', { title: 'x'.repeat(200), definitionOfDone: '🚀'.repeat(300) + 'needle' + '🚀'.repeat(300) }));
  assert.equal(searchWork(long, 'x'.repeat(220)).total, 1);
  const excerpt = searchWork(long, 'needle').work[0].excerpt;
  assert.ok(excerpt.includes('needle')); assert.ok(excerpt.startsWith('…')); assert.ok(excerpt.endsWith('…'));
  assert.ok([...excerpt].length <= 242); assert.ok(excerpt.isWellFormed());
  const expanded = room(item('folded', { definitionOfDone: 'İ'.repeat(300) + 'needle' }));
  assert.ok(searchWork(expanded, 'needle').work[0].excerpt.includes('needle'), 'case-fold expansion does not displace the matching excerpt');
});

test('work search does not index unrelated history, private data or external evidence fields', () => {
  const state = room(item('one', { receipt: { summary: 'Current result', evidenceUrl: 'https://example.test/link-only', evidenceVersion: 'hash-only' },
    verification: { summary: 'check-only' }, decision: { reason: 'decision-only' }, claim: { repository: 'repo-only' } }));
  state.eventLog = [{ body: 'history-only' }]; state.reminders = [{ note: 'reminder-only' }]; state.accessKey = 'secret-only';
  for (const query of ['link-only', 'hash-only', 'check-only', 'decision-only', 'repo-only', 'history-only', 'reminder-only', 'secret-only']) {
    assert.equal(searchWork(state, query).total, 0);
  }
  assert.equal(searchWork(state, 'Current result').total, 1);
  state.workItems.one.receipt = { summary: 'New result' };
  assert.equal(searchWork(state, 'Current result').total, 0);
  assert.equal(searchWork(state, 'New result').total, 1);
});
