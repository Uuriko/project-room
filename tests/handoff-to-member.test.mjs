import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../server/store.mjs';
import {initialRoom} from '../server/bootstrap.mjs';
import {event} from '../src/events.js';
import {nextWorkStep} from '../src/workflow.js';
import {auditRecovery} from '../server/recovery.mjs';
import {readCurrentWorkListing} from '../server/current-work-list.mjs';
import {buildWorkCommand, validWorkArguments} from '../client/work-actions.mjs';

// A handoff may name who should pick the work up, so agent-to-agent handoffs
// stop landing on the Room owner's needs-me. Without the field, unchanged.
function fixture(t, representation) {
  const s = new RoomStore(':memory:'); t.after(() => s.close());
  const es = initialRoom();
  for (const id of ['worker', 'taker']) es.push(event({roomId: 'commons', actorId: 'owner', type: 'member.added', data: {memberId: id, displayName: id, kind: 'agent', permissions: ['accept_work', 'complete_work']}}));
  s.initialize(es, representation ? {representation} : undefined);
  const keys = Object.fromEntries(['owner', 'worker', 'taker'].map(id => [id, s.issueAccessKey('commons', id)]));
  const cmd = (who, id, type, data) => s.command(keys[who], 'commons', {id, type, data});
  for (const task of ['task', 'plain']) {
    cmd('owner', 'propose-' + task, 'work.proposed', {workItemId: task, title: 'Task ' + task, definitionOfDone: 'Saved result', accountableMemberId: 'worker', mode: 'read'});
    cmd('worker', 'accept-' + task, 'work.accepted', {workItemId: task, expectedRevision: 0});
  }
  const item = id => JSON.parse(s.db.prepare('SELECT body FROM work_entities WHERE work_id=?').get(id)?.body ?? 'null') ?? s.state('commons').workItems[id];
  return {s, keys, cmd, item};
}
const handoff = extra => ({workItemId: 'task', doneSummary: 'Stage one saved', nextAction: 'Finish it', limitReason: 'Out of scope for me', ...extra});

for (const representation of [null, 'normalized-current-v1']) test(`handoff toMemberId routes triage to that member (${representation ?? 'legacy'})`, t => {
  const {s, keys, cmd, item} = fixture(t, representation);
  for (const [bad, pattern] of [['worker', /another room member/], ['nobody', /member/i]])
    assert.throws(() => cmd('worker', 'bad-' + bad, 'work.handoff_recorded', handoff({toMemberId: bad})), pattern);
  cmd('worker', 'to-taker', 'work.handoff_recorded', handoff({toMemberId: 'taker'}));
  cmd('worker', 'to-owner', 'work.handoff_recorded', handoff({workItemId: 'plain'}));
  assert.equal(item('task').handoff.triageMemberId, 'taker');
  assert.equal(item('plain').handoff.triageMemberId, 'owner', 'no field keeps the owner');
  const step = nextWorkStep(item('task'), Date.now(), 'owner');
  assert.deepEqual([step.action, step.memberId], ['triaged_handoff', 'taker']);
  if (representation) {
    const needs = key => readCurrentWorkListing(s, key, 'commons', {focus: 'needs_me'}).work.map(row => row.id);
    assert.ok(needs(keys.taker).includes('task'), 'recipient sees the handoff');
    assert.equal(needs(keys.owner).includes('task'), false, 'owner does not');
    assert.ok(needs(keys.owner).includes('plain'));
  }
  assert.doesNotThrow(() => auditRecovery(s));
});

test('room_handoff carries toMemberId into the command and validates its shape', () => {
  const args = {requestId: 'handoff-1', workItemId: 'task', doneSummary: 'd', nextAction: 'n', limitReason: 'r', toMemberId: 'taker'};
  assert.equal(validWorkArguments('room_handoff', args), true);
  assert.equal(validWorkArguments('room_handoff', {...args, toMemberId: 'bad id'}), false);
  assert.equal(buildWorkCommand('room_handoff', args).data.toMemberId, 'taker');
});
