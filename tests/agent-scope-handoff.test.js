import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { startAssistedAgentExercise } from '../scripts/assisted-agent-exercise.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { EVENT_TYPES as T } from '../src/events.js';
import { nextWorkStep } from '../src/workflow.js';
import { needsAttention, workInvolvingMe } from '../server/return-selectors.mjs';

const command = (type, data) => ({ id: randomUUID(), type, data });
const digest = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;

test('two real HTTP clients coordinate a fictional scope, preserve late proposals, and agree on catch-up facts', async t => {
  // This automated scenario is not evidence of independent AI reasoning. The
  // same fixture can separately host actual agent participants without scripting
  // their claims, notes, review or decisions.
  const fixture = await startAssistedAgentExercise();
  t.after(fixture.close);
  const agents = Object.values(fixture.credentialFiles).map(path => {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    const config = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(config.fixture, 'project-room-assisted-agents-v1');
    return { config, client: new RoomAgentClient(config) };
  });
  assert.equal(agents.length, 2);
  assert.ok(agents[0].config.token !== agents[1].config.token, 'Participants have distinct credentials');
  assert.notEqual(agents[0].config.workItemId, agents[1].config.workItemId);
  const current = async agent => (await agent.client.snapshot()).state.workItems[agent.config.workItemId];
  const mutate = async (agent, type, data = {}) => agent.client.command(command(type, {
    workItemId: agent.config.workItemId, expectedRevision: (await current(agent)).revision, ...data
  }));
  for (const agent of agents) {
    const orientation = await agent.client.orient();
    assert.equal(orientation.member.id, agent.config.memberId);
    assert.equal(orientation.scope.kind, 'room', 'Membership is not assignment-private');
    assert.equal(orientation.scope.externalExecution, false);
    assert.deepEqual(orientation.scope.permissions, ['accept_work', 'complete_work', 'write_external']);
    const work = orientation.work.find(item => item.id === agent.config.workItemId);
    assert.equal(work.mode, 'write');
    assert.equal(work.claim, null);
    assert.equal(work.next.memberId, agent.config.memberId);
    assert.equal(work.next.action, 'accept');
  }
  await Promise.all(agents.map(agent => mutate(agent, T.WORK_ACCEPTED)));
  const beforeRace = await agents[0].client.snapshot();
  await assert.rejects(agents[0].client.command(command(T.CLAIM_ACQUIRED, {
    workItemId: agents[0].config.workItemId, expectedRevision: 1,
    ...agents[0].config.scope, paths: ['notes/*.md']
  })), error => error.status === 422 && error.code === 'invalid_claim_scope');
  const afterInvalidScope = await agents[0].client.snapshot();
  assert.equal(afterInvalidScope.sequence, beforeRace.sequence, 'HTTP scope validation saves no event');
  assert.equal(afterInvalidScope.cursor, beforeRace.cursor, 'Rejected scope does not acknowledge activity');
  assert.deepEqual(afterInvalidScope.state, beforeRace.state, 'Rejected scope preserves revisions, claims and event history');
  const claims = agents.map(agent => command(T.CLAIM_ACQUIRED, {
    workItemId: agent.config.workItemId, expectedRevision: 1, ...agent.config.scope
  }));
  const attempts = await Promise.all(agents.map((agent, index) => agent.client.command(claims[index])
    .then(receipt => ({ receipt }), error => ({ status: error.status, code: error.code }))));
  assert.equal(attempts.filter(attempt => attempt.receipt).length, 1);
  assert.equal(attempts.filter(attempt => attempt.status === 409 && attempt.code === 'claim_conflict').length, 1);
  const winnerIndex = attempts.findIndex(attempt => attempt.receipt);
  const loserIndex = 1 - winnerIndex;
  const winner = agents[winnerIndex], loser = agents[loserIndex];
  const raced = await winner.client.snapshot();
  assert.equal(raced.sequence, beforeRace.sequence + 1, 'Rejected claim saves no event');
  assert.equal((await current(loser)).revision, 1);
  assert.equal((await current(loser)).claim, null);
  const orientedWinner = (await winner.client.orient()).work.find(item => item.id === winner.config.workItemId);
  assert.deepEqual(orientedWinner.claim, raced.state.workItems[winner.config.workItemId].claim);

  await mutate(winner, T.WORK_STARTED);
  const beforeRelease = await current(winner);
  await mutate(winner, T.CLAIM_RELEASED);
  const acquired = await loser.client.command(claims[loserIndex]);
  assert.equal(acquired.duplicate, false, 'An earlier rejected command has no saved success');
  assert.equal(acquired.event.actorId, loser.config.memberId);
  const oldRetry = await winner.client.command(claims[winnerIndex]);
  assert.equal(oldRetry.duplicate, true);
  assert.equal(oldRetry.event.id, attempts[winnerIndex].receipt.event.id);
  assert.equal((await current(winner)).claim.status, 'released', 'Retry cannot restore the old reservation');

  const lateNote = 'Late proposal only: preserve the previous note for the current holder to consider. No accepted result or external action is claimed.';
  await winner.client.command(command(T.MESSAGE_POSTED, { workItemId: winner.config.workItemId, body: lateNote }));
  const lateReceipt = { summary: lateNote, producerId: winner.config.memberId,
    evidenceUrl: 'https://example.invalid/assisted-agent-exercise/late-note', evidenceVersion: digest(lateNote), nextAction: 'Proposal only' };
  await assert.rejects(winner.client.command(command(T.WORK_COMPLETED, {
    workItemId: winner.config.workItemId, expectedRevision: beforeRelease.revision, ...lateReceipt
  })), error => error.status === 409 && error.code === 'command_rejected');
  await assert.rejects(mutate(winner, T.WORK_COMPLETED, lateReceipt),
    error => error.status === 422 && error.code === 'command_rejected');
  const previous = await current(winner);
  assert.equal(previous.state, 'working');
  assert.equal(previous.receipt, null);
  assert.equal(previous.decision, null);

  await mutate(loser, T.WORK_STARTED);
  const text = 'Synthetic handoff note: the second claimant acquired the released scope. The old note remains a proposal; a person still decides whether to accept this result.';
  await mutate(loser, T.WORK_COMPLETED, { summary: text, producerId: loser.config.memberId,
    evidenceUrl: 'https://example.invalid/assisted-agent-exercise/recorded-note', evidenceVersion: digest(text),
    nextAction: 'Local operator reviews the receipt. The fixture URL is not a hosted artifact.' });
  const completed = await current(loser);
  assert.equal(completed.receipt.reportedById, loser.config.memberId);
  assert.equal(completed.receipt.evidenceVersion, digest(text));
  assert.equal(completed.verification, null);
  assert.equal(completed.decision, null);
  assert.equal(nextWorkStep(completed).action, 'decide');
  assert.equal(nextWorkStep(completed).memberId, 'owner');
  await mutate(loser, T.CLAIM_RELEASED);

  for (const agent of agents) {
    const snapshot = await agent.client.snapshot();
    const brief = await agent.client.returnBrief({ limit: 100 });
    const orientation = await agent.client.orient();
    assert.equal(brief.current.evaluatedThrough, snapshot.sequence);
    assert.equal(brief.history.evaluatedThrough, snapshot.sequence);
    assert.equal(brief.history.cursor, snapshot.cursor);
    assert.equal(brief.history.hasMore, false);
    assert.deepEqual(brief.current.needsAttention, needsAttention({ workItems: snapshot.state.workItems, memberId: agent.config.memberId }));
    assert.deepEqual(brief.current.workInvolvingMe, workInvolvingMe({ workItems: snapshot.state.workItems, memberId: agent.config.memberId }));
    assert.ok(brief.history.items.some(row => row.event.type === T.MESSAGE_POSTED && row.event.data.body === lateNote));
    assert.equal(brief.history.items.some(row => row.event.type === T.OWNER_DECISION_RECORDED), false);
    assert.equal(orientation.evaluatedThrough, snapshot.sequence);
    for (const work of orientation.work) {
      const item = snapshot.state.workItems[work.id];
      assert.equal(work.revision, item.revision);
      assert.equal(work.mode, item.mode);
      assert.deepEqual(work.claim, item.claim);
      assert.deepEqual(work.next, nextWorkStep(item));
      assert.equal(work.decision, null);
    }
    const afterReading = await agent.client.snapshot();
    assert.equal(afterReading.sequence, snapshot.sequence, 'Reading and orientation do not create events');
    assert.equal(afterReading.cursor, snapshot.cursor, 'Catch-up reads do not acknowledge');
  }
  await fixture.close();
  assert.ok(Object.values(fixture.credentialFiles).every(path => !existsSync(path)), 'Stopping removes participant credentials');
  assert.ok(Object.values(fixture.credentialFiles).every(path => !existsSync(dirname(path))), 'Stopping removes only the disposable fixture directory');
});
