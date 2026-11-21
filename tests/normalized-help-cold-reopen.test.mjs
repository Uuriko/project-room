import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { operatorNormalization } from '../server/operator-normalization.mjs';
import { RoomStore } from '../server/store.mjs';
import { closeWork } from '../server/work-claims.mjs';

test('normalized cold reopen audits retained help invitation and offer history', t => {
  const fixture = createAcceptanceFixture();
  const roomId = 'commons';
  const workItemId = 'test-handoff';
  let store = fixture.store;
  t.after(() => {
    store?.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  });
  const send = (actor, id, type, data) => store.command(fixture.keys[actor], roomId, { id, type, data });
  send('producer', 'accept-for-help', 'work.accepted', { workItemId, expectedRevision: 0 });
  const help = send('producer', 'open-help', 'work.help_updated', { workItemId, expectedRevision: 1,
    expectedHelpRevision: 0, status: 'open', scope: 'Find a small follow-up',
    expiresAt: new Date(Date.now() + 600_000).toISOString() });
  send('guest', 'offer-for-help', 'work.help_offer_opened', { workItemId, expectedRevision: 1,
    expectedHelpRevision: 1, helpEventId: help.event.id, offerId: 'offer', plan: 'Check the fixture' });
  const mirror = store.workClaims.get(roomId, workItemId);
  store.workClaims.set(roomId, closeWork(mirror, 'owner', { authority: true, reason: 'Preserve test mirror history' }));
  const args = { roomId, discardLegacyAssignments: false, adoptAbsentInlineProofs: true };
  const plan = operatorNormalization(store, args);
  const adopted = operatorNormalization(store, { ...args, planHash: plan.planHash,
    reason: 'Rehearse restart with real help events', requestId: 'keep-help' }, true);
  assert.deepEqual(adopted.legacyDiscarded, {});
  store.close();
  store = null;
  store = new RoomStore(join(fixture.directory, 'room.sqlite'));
  assert.deepEqual(store.verifyHelpHistory().checked, [roomId]);
  assert.equal(store.workClaims.get(roomId, workItemId).state, 'closed');
});
