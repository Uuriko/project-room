// Fail-first characterization of server/room-guide.mjs step() staging.
// Locks the three stages (seed welcome, close starter on choice, assign the
// first agent and wake it) plus idempotency, so the elegance restructure of
// step() cannot silently change behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { seedStarter } from '../server/starter-room.mjs';
import { runGuideStep, ROOM_GUIDE_ID } from '../server/room-guide.mjs';

function setup(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); });
  seedStarter(f.store, 'commons', { ownerMemberId: 'owner', intent: 'bug' });
  return f;
}

test('guide stages: seeded welcome, choice closes starter, first agent assigned and woken, then idle', t => {
  const f = setup(t);
  const { store } = f;

  // seedStarter already ran the welcome stage through runGuideStep.
  const welcome = store.room('commons').state.messages.find(m => m.id === 'gw-commons');
  assert.ok(welcome, 'welcome message seeded');
  assert.equal(welcome.authorId, ROOM_GUIDE_ID);
  const starter = store.workClaims.get('commons', 'starter-receipt');
  assert.equal(starter.state, 'claimed');
  assert.equal(starter.owner, ROOM_GUIDE_ID);

  // No choice named yet: the step stays idle.
  assert.equal(runGuideStep(store, 'commons', store.now()), null);

  // A human picks a choice by naming it; the installed command hook runs the
  // guide step, which must close the starter in one stage.
  store.command(f.keys.owner, 'commons', {
    id: randomUUID(), type: 'message.posted', data: { messageId: 'pick-agree', body: 'agent-pair-agree' }
  });
  const closed = store.workClaims.get('commons', 'starter-receipt');
  assert.equal(closed.state, 'done');
  assert.equal(closed.deliveryMode, 'result');
  const doneEntry = [...(closed.history ?? [])].reverse().find(e => e.action === 'state:done');
  assert.equal(doneEntry?.note, 'choice:agent-pair-agree Agree the change');

  // The fixture already has an agent member (producer), so the next stage
  // claim, told so in-room, and woken.
  const before = store.room('commons').state.messages.length;
  assert.equal(runGuideStep(store, 'commons', store.now()), 'agent_joined');
  const assigned = store.workClaims.get('commons', 'agent-pair-agree');
  assert.equal(assigned.owner, 'producer');
  assert.equal(assigned.state, 'claimed');
  const assign = store.room('commons').state.messages.find(m => m.authorId === ROOM_GUIDE_ID && m.body.includes('is yours'));
  assert.ok(assign, 'assignment message posted');
  assert.equal(assign.body, '@Test producer Agree the change is yours.');
  const wake = store.db.prepare('SELECT 1 FROM agent_wake_signals WHERE agent_id=? AND room_id=? AND message_id=?')
    .get('producer', 'commons', assign.id);
  assert.ok(wake, 'claim wake enqueued for the assigned agent');

  // Idempotent: the assignment message id is stable, so a repeat step is a no-op.
  assert.equal(runGuideStep(store, 'commons', store.now()), null);
  assert.equal(store.room('commons').state.messages.length, before + 1);
});

test('guide step is a no-op without starter seeding', t => {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); });
  // The commons fixture room has no starter seed.
  assert.equal(runGuideStep(f.store, 'commons', f.store.now()), null);
});
