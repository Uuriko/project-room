import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event, EVENT_TYPES as T } from '../src/events.js';
import { auditRecovery } from '../server/recovery.mjs';
import { createRoomServer } from '../server/http.mjs';
import { textVersion } from '../server/text-results.mjs';
import { publicWorkItemReceiptId } from '../server/public-read-model.mjs';

for (const result of ['pass', 'fail']) test(`receipts-on work completes and verifies ${result} without publishing`, async t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const log = initialRoom();
  for (const [memberId, permissions] of [['worker', ['accept_work', 'complete_work']], ['checker', ['verify']]]) {
    log.push(event({ roomId: 'commons', actorId: 'owner', type: T.MEMBER_ADDED,
      data: { memberId, displayName: `Private ${memberId}`, kind: 'agent', permissions } }));
  }
  store.initialize(log, { representation: 'normalized-current-v1' });
  const keys = Object.fromEntries(['owner', 'worker', 'checker'].map(id => [id, store.issueAccessKey('commons', id)]));
  const cmd = (who, id, type, data) => store.command(keys[who], 'commons', { id, type, data });
  const work = () => JSON.parse(store.db.prepare('SELECT body FROM work_entities WHERE work_id=?').get('task').body);
  cmd('owner', 'on', T.ROOM_PUBLIC_RECEIPTS_SET, { enabled: true });
  cmd('owner', 'p', T.WORK_PROPOSED, { workItemId: 'task', title: 'Private task', definitionOfDone: 'Saved text reviewed',
    accountableMemberId: 'worker', verifierMemberId: 'checker', independentVerificationRequired: true, mode: 'read' });
  assert.throws(() => cmd('checker', 'wrong-owner', T.WORK_ACCEPTED, { workItemId: 'task', expectedRevision: 0 }));
  cmd('worker', 'a', T.WORK_ACCEPTED, { workItemId: 'task', expectedRevision: 0 });
  cmd('worker', 's', T.WORK_STARTED, { workItemId: 'task', expectedRevision: work().revision });
  const body = 'Private verified result';
  const posted = cmd('worker', 'r', T.MESSAGE_POSTED, { messageId: 'result', body, workItemId: 'task' });
  const data = { workItemId: 'task', expectedRevision: work().revision, evidenceKind: 'room_text',
    evidenceMessageId: 'result', evidenceMessageEventId: posted.event.id, evidenceVersion: textVersion(body),
    previousCompletionEventId: null, producerId: 'worker', summary: 'Saved', nextAction: 'Review' };
  const done = cmd('worker', 'c', T.WORK_COMPLETED, data);
  assert.equal(cmd('worker', 'c', T.WORK_COMPLETED, data).duplicate, true);
  assert.notEqual(work().verification?.result, 'pass', 'completion alone is not verification');
  cmd('checker', 'v', T.VERIFICATION_RECORDED, { workItemId: 'task', expectedRevision: work().revision,
    result, completionEventId: done.event.id, evidenceVersion: textVersion(body), summary: 'Reviewed exact text' });
  assert.equal(work().verification.result, result);
  assert.equal(store.db.prepare('SELECT count(*) n FROM public_receipts').get().n, 0);
  assert.doesNotThrow(() => auditRecovery(store));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/receipts/${publicWorkItemReceiptId('commons', 'task')}.json`;
  assert.equal((await fetch(url)).status, 404, 'no anonymous receipt publication');
  cmd('owner', 'off', T.ROOM_PUBLIC_RECEIPTS_SET, { enabled: false });
  assert.equal(cmd('worker', 'c', T.WORK_COMPLETED, data).duplicate, true);
  assert.equal(store.db.prepare('SELECT count(*) n FROM public_receipts').get().n, 0);
  assert.equal((await fetch(url)).status, 404);
  assert.doesNotThrow(() => auditRecovery(store));
});
