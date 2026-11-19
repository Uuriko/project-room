import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { readWorkItem } from '../server/work-repository.mjs';
import { callHostedStdioTool } from '../server/mcp-full-profile.mjs';
import { planSteps, submitPlan, validPlanArguments, planTool, PLAN_ITEMS_MAX } from '../client/work-plan.mjs';

const item = (key, extra = {}) => ({ key, title: `Task ${key}`, definitionOfDone: 'Exact result', accountableMemberId: 'agent',
  mode: 'read', independentVerificationRequired: false, ownerDecisionRequired: false, ...extra });

test('a plan orders prerequisites first and maps needs to plan-scoped workItemIds', () => {
  const steps = planSteps({ planId: 'ship', items: [item('review', { needs: ['fix', 'docs'] }), item('fix'), item('docs', { needs: ['fix'], dependsOn: ['outside'] })] });
  assert.deepEqual(steps.map(step => step.key), ['fix', 'docs', 'review']);
  assert.deepEqual(steps.map(step => [step.args.workItemId, step.args.requestId, step.args.dependsOn]), [
    ['ship-fix', 'plan.ship.fix', undefined],
    ['ship-docs', 'plan.ship.docs', ['outside', 'ship-fix']],
    ['ship-review', 'plan.ship.review', ['ship-docs', 'ship-fix']]
  ]);
  assert.ok(steps.every(step => step.name === 'room_propose_work' && !Object.hasOwn(step.args, 'needs') && !Object.hasOwn(step.args, 'key')));
});

test('a plan refuses duplicate keys, unknown or self needs, cycles and oversize input before anything is sent', () => {
  const cases = [
    [[item('a'), item('a')], /two items have the key "a"/],
    [[item('a', { needs: ['b'] })], /no item of this plan has/],
    [[item('a', { needs: ['a'] })], /needs itself/],
    [[item('a', { needs: ['c'] }), item('b', { needs: ['a'] }), item('c', { needs: ['b'] })], /wait for each other: a -> c -> b -> a/],
    [Array.from({ length: PLAN_ITEMS_MAX + 1 }, (_, at) => item(`k${at}`)), /1 to 20 items/]
  ];
  for (const [items, message] of cases) {
    assert.throws(() => planSteps({ planId: 'p', items }), error => error.code === 'invalid_work_plan' && message.test(error.message));
    assert.equal(validPlanArguments({ planId: 'p', items }), false);
  }
  assert.equal(validPlanArguments({ planId: 'p', items: [item('a', { title: '' })] }), false, 'each step must be a valid room_propose_work call');
  assert.equal(validPlanArguments({ planId: 'p', items: [item('a')] }), true);
  assert.deepEqual(planTool.inputSchema.required, ['planId', 'items']);
});

test('a refused item stops the plan and names the exact call that resumes it', async () => {
  const args = { planId: 'p', items: [item('a'), item('b', { needs: ['a'] }), item('c', { needs: ['b'] })] };
  const sent = [];
  const partial = await submitPlan(args, async step => {
    sent.push(step.key);
    if (step.key === 'b') throw Object.assign(new Error('nope'), { code: 'command_rejected' });
    return { status: 'recorded', requestId: step.args.requestId, sequence: sent.length, duplicate: false };
  });
  assert.deepEqual(sent, ['a', 'b']);
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.recorded.map(entry => entry.workItemId), ['p-a']);
  assert.deepEqual([partial.refused.key, partial.refused.code], ['b', 'command_rejected']);
  assert.deepEqual(partial.notAttempted, ['c']);
  assert.deepEqual(partial.next[0], { tool: 'room_propose_plan', arguments: args, when: partial.next[0].when });
});

// Native (current-format) room: every fresh room is one, and a proposed item is
// already a valid dependsOn target there.
function native(t) {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  store.initialize([...initialRoom()], { representation: 'normalized-current-v1' });
  const key = store.issueAccessKey('commons', 'owner');
  return { call: (name, args) => callHostedStdioTool(store, key, name, { roomId: 'commons', ...args }), work: id => readWorkItem(store.db, 'commons', id) };
}

test('hosted room_propose_plan records each item as an ordinary proposal, replays as duplicates and refuses a changed item', async t => {
  const f = native(t);
  const items = [item('review', { needs: ['fix'], accountableMemberId: 'owner' }), item('fix', { accountableMemberId: 'owner' })];
  const first = await f.call('room_propose_plan', { planId: 'ship', items });
  assert.equal(first.isError, false, JSON.stringify(first));
  assert.equal(first.value.status, 'recorded');
  assert.deepEqual(first.value.recorded.map(entry => [entry.workItemId, entry.duplicate]), [['ship-fix', false], ['ship-review', false]]);
  assert.equal(f.work('ship-fix').title, 'Task fix');
  assert.deepEqual(f.work('ship-review').dependsOn, ['ship-fix']);

  const again = await f.call('room_propose_plan', { planId: 'ship', items });
  assert.equal(again.value.status, 'recorded');
  assert.deepEqual(again.value.recorded.map(entry => entry.duplicate), [true, true]);

  const changed = await f.call('room_propose_plan', { planId: 'ship', items: [items[0], { ...items[1], title: 'Another fix' }] });
  assert.equal(changed.isError, true);
  assert.equal(changed.value.status, 'partial');
  assert.deepEqual([changed.value.refused.key, changed.value.refused.code], ['fix', 'idempotency_conflict']);
  assert.equal(f.work('ship-fix').title, 'Task fix', 'the recorded proposal is unchanged');
});

test('hosted room_propose_plan keeps the steer gate of room_propose_work for every item', async t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const outcome = await callHostedStdioTool(f.store, f.keys.producer, 'room_propose_plan', { roomId: 'commons', planId: 'mine', items: [item('a', { accountableMemberId: 'producer' })] })
    .catch(error => ({ thrown: error }));
  assert.ok(outcome.thrown?.code ?? outcome.value?.refused?.code, JSON.stringify(outcome));
  assert.equal(f.store.room('commons').state.workItems['mine-a'], undefined, 'nothing was proposed without steer');
});
