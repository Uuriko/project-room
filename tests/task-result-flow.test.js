import test from 'node:test';
import assert from 'node:assert/strict';
import { workContinuity } from '../src/work-item-session.js';
import { contributionSteps } from '../src/work-selectors.js';
import { workProgress, resumeMarkdown } from '../src/work-packet.js';

const now = Date.parse('2026-09-24T02:00:00Z');
const item = { id: 'task', title: 'Finish the report', state: 'working', mode: 'read', revision: 2,
  accountableMemberId: 'worker', independentVerificationRequired: false, ownerDecisionRequired: false,
  status: 'active', attempt_count: 1, started_at: '2026-09-24T01:00:00Z', heartbeat_at: '2026-09-24T01:40:00Z' };

test('a missing worker update stays unknown and does not alter work or grant takeover', () => {
  const before = structuredClone(item);
  const continuity = workContinuity(item, now);
  assert.equal(continuity.state, 'unknown');
  assert.match(continuity.next, /Process state is unknown/);
  assert.deepEqual(item, before);
  assert.equal(workContinuity({ ...item, heartbeat_at: new Date(now).toISOString() }, now).needsAttention, false);
  assert.equal(workContinuity({ state: 'proposed' }, now), null);
});

test('explicit stop, failure and owner round limit remain distinct in saved context', () => {
  assert.equal(workContinuity({ ...item, stop_requested_at: new Date(now).toISOString() }, now).state, 'stopping');
  assert.equal(workContinuity({ ...item, status: 'failed' }, now).state, 'interrupted');
  const paused = { ...item, status: 'suspended', suspended_by: 'round_limit', heartbeat_at: new Date(now).toISOString() };
  assert.match(workContinuity(paused, now).next, /owner can resume/);
  assert.equal(workContinuity(paused, now + 3600000).state, "paused");
  assert.match(workContinuity(paused, now + 3600000).next, /owner can resume/);
  assert.match(resumeMarkdown(workProgress(paused, now)), /Run paused/);
  assert.equal(workContinuity({ ...item, status: 'done' }, now).needsAttention, false);
});

test('recovery attention is relevant, deduplicated, and disappears on fresh progress or completion', () => {
  const state = { room: { ownerId: 'owner' }, members: Object.fromEntries(['owner', 'worker', 'other'].map(id => [id, { id, active: true, permissions: [] }])),
    messages: [], workItems: { task: item } };
  assert.equal(contributionSteps(state, 'owner', now)[0].recovery, true);
  assert.equal(contributionSteps(state, 'worker', now).length, 1);
  assert.equal(contributionSteps(state, 'other', now).length, 0);
  state.workItems.task = { ...item, heartbeat_at: new Date(now).toISOString() };
  assert.equal(contributionSteps(state, 'owner', now).length, 0);
  state.workItems.task = { ...item, state: 'superseded', supersededBy: 'replacement' };
  assert.equal(contributionSteps(state, 'owner', now).length, 0);
});
