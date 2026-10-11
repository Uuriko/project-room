// R36-2 fail-first repro (WAVE-500 guild 6/10, room API & event log bug hunt).
//
// Bug: the shared-assistant coordinator is demoted to t1_readonly mid-run,
// the owner Stops (run -> cancel_requested), and then the host's 'cancelled'
// report is refused with 403 agent_readonly. The autonomy-tier contract
// (server/autonomy-tiers.mjs: T1_READONLY_ALLOWED_COMMANDS) says stops always
// land for t1 agents, but server/room-assistant.mjs refuses EVERY coordinator
// report via enforceAutonomyTierForAction, so the run sits at
// cancel_requested until the 120s stale fence and a second Stop.
//
// REPRO ONLY: the fix belongs to Codex's Stop lane. This file must stay a
// tests-only change — do not touch server/room-assistant.mjs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { RoomAssistant } from '../server/room-assistant.mjs';
import { demoteToReadonly } from '../server/autonomy-tiers.mjs';

function setup(t) {
  const f = createAcceptanceFixture({ dmConsent: true });
  t.after(() => { f.store.close(); });
  const assistant = new RoomAssistant(f.store);
  // In-process only: drives production apply() transitions without HTTP.
  const apply = (actor, input) =>
    assistant.apply('commons', { requestId: randomUUID(), ...input }, () => f.store.authenticate(f.keys[actor], 'commons')).result;
  const message = (actor, id, body = 'Shared input') =>
    f.store.command(f.keys[actor], 'commons', { id: randomUUID(), type: 'message.posted', data: { messageId: id, body } });
  return { f, apply, message };
}

// owner configures producer as coordinator, invokes, producer claims, then
// producer is demoted to t1_readonly mid-run. Returns the run after claim.
function startRunWithDemotedCoordinator(ctx) {
  const { f, apply, message } = ctx;
  apply('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
  message('owner', 'stop-target');
  const invoked = apply('owner', { action: 'invoke', runId: 'stoppable', sourceMessageId: 'stop-target' });
  const claimed = apply('producer', { action: 'claim', runId: 'stoppable', attemptId: 'host-1', expectedRevision: invoked.revision });
  assert.equal(claimed.status, 'working');
  demoteToReadonly(f.store.db, 'commons', 'producer', { updatedBy: 'owner', nowMs: f.store.now() });
  return claimed;
}

test('R36-2: owner Stop lands cancel_requested on a demoted coordinator run', async t => {
  const ctx = setup(t);
  const claimed = startRunWithDemotedCoordinator(ctx);
  const stopped = ctx.apply('owner', { action: 'cancel', runId: 'stoppable', expectedRevision: claimed.revision });
  assert.equal(stopped.status, 'cancel_requested', 'the owner stop request lands');
});

test('R36-2 FAIL-FIRST: demoted coordinator stop report lands per the tier contract', async t => {
  const ctx = setup(t);
  const claimed = startRunWithDemotedCoordinator(ctx);
  const stopped = ctx.apply('owner', { action: 'cancel', runId: 'stoppable', expectedRevision: claimed.revision });
  assert.equal(stopped.status, 'cancel_requested');
  // T1_READONLY_ALLOWED_COMMANDS includes SESSION_STOPPED: "stops always
  // land". The host's cancelled report is a stop report and must land, taking
  // the run to cancelled. Currently refused with 403 agent_readonly.
  const reported = ctx.apply('producer', {
    action: 'report', runId: 'stoppable', attemptId: 'host-1',
    expectedRevision: stopped.revision, state: 'cancelled', summary: 'Host acknowledges the stop.',
  });
  assert.equal(reported.status, 'cancelled', 'stop reports always land per the tier contract');
});

test('guard: non-stop reports from a demoted coordinator stay refused', async t => {
  const ctx = setup(t);
  const claimed = startRunWithDemotedCoordinator(ctx);
  // A plain status report is not a stop report; the tier fence must keep
  // refusing it so the eventual R36-2 carve-out stays narrow.
  assert.throws(
    () => ctx.apply('producer', {
      action: 'report', runId: 'stoppable', attemptId: 'host-1',
      expectedRevision: claimed.revision, state: 'working', summary: 'Still working.',
    }),
    err => err.status === 403 && err.code === 'agent_readonly',
    'non-stop reports remain 403 agent_readonly',
  );
});
