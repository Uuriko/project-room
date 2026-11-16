import test from 'node:test';
import assert from 'node:assert/strict';
import { privateWorkFixture } from './helpers/private-work-fixture.mjs';
import { makeTestSigner } from '../scripts/helpers/signed-evidence.mjs';
import { RoomAgentClient } from '../client/room-agent.mjs';

for (const representation of ['legacy', 'normalized-current-v1']) {
  test(`${representation}: signed external evidence version is private text, including after review`, async t => {
    const f = await privateWorkFixture(t, representation, { ownerDecisionRequired: true });
    const workItemId = 'secret', version = 'customer-private-release-name-DO-NOT-DISCLOSE';
    const send = (key, type, data) => f.send(key, type, { workItemId, expectedRevision: f.rev(workItemId), ...data });
    send(f.producer.key, 'work.blocker_resolved', { resolution: 'Corrected external result' });
    send(f.producer.key, 'work.started', {});
    const done = send(f.producer.key, 'work.completed', { summary: 'External result', evidenceUrl: 'https://example.invalid/private-delivery', evidenceVersion: version,
      producerId: f.producer.id, nextAction: 'Review', signedEvidence: makeTestSigner(f.store)() });
    send(f.reviewer.key, 'verification.recorded', { result: 'pass', completionEventId: done.event.id, evidenceVersion: version, summary: 'Checked' });
    f.send(f.owner, 'message.posted', { messageId: 'decision-source', workItemId, body: 'Accept the reviewed result' });
    send(f.owner, 'owner.decision_recorded', { sourceMessageId: 'decision-source', decision: 'approved', completionEventId: done.event.id, evidenceVersion: version, reason: 'Accepted' });
    const stored = f.stored();
    for (const path of ['', '?view=orientation', '?view=work', '/events?after=0&limit=100']) {
      const read = await f.rest(f.observer, path);
      assert.equal(read.status, 200);
      assert.equal(read.text.includes(version), false, path);
    }
    const own = f.store.workContext(f.reviewer.key, 'commons', workItemId);
    assert.equal(own.work.receipt.evidenceVersion, version);
    assert.equal(own.work.verification.evidenceVersion, version);
    assert.equal(own.work.decision.evidenceVersion, version);
    // The public SDK must still accept the withheld representation.
    const origin = f.origin;
    await new RoomAgentClient({ origin, roomId: 'commons', memberId: f.observer.id, token: f.observer.secret }).orient();
    assert.equal(f.stored(), stored);
  });
}
