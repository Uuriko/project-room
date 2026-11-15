import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { event, EVENT_TYPES as T } from '../src/events.js';
import { auditRecovery } from '../server/recovery.mjs';
import { createRoomServer } from '../server/http.mjs';
import { textVersion } from '../server/text-results.mjs';
import { publicWorkItemReceiptId } from '../server/public-read-model.mjs';

// L3-D1 (#6204): an opted-in current-format room's verified receipt
// must resolve on the public .json face at read time, even though
// current rooms never write public_receipts rows. The stale assertion
// "no anonymous receipt publication" expected 404 after opt-in + pass
// and went red on main 5fd9e41b. Leakage guards that remain valid:
// not-opted-in stays 404, a failed verification is not a receipt and
// stays 404, and opt-out hides again. The table stays empty in every
// case — no write path.

async function setup(t, { receiptsOn = false, result = 'pass' } = {}) {
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
  if (receiptsOn) cmd('owner', 'on', T.ROOM_PUBLIC_RECEIPTS_SET, { enabled: true });
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
  return { store, cmd, data, url };
}

test('verified work is not public before the opt-in', async t => {
  const { url } = await setup(t, { receiptsOn: false, result: 'pass' });
  assert.equal((await fetch(url)).status, 404, 'a verified receipt is not public without the recorded opt-in');
});

test('receipts-on work completes and verifies fail without publishing', async t => {
  const { store, cmd, data, url } = await setup(t, { receiptsOn: true, result: 'fail' });
  assert.equal((await fetch(url)).status, 404, 'a failed verification is not a receipt and stays unpublished');
  cmd('owner', 'off', T.ROOM_PUBLIC_RECEIPTS_SET, { enabled: false });
  assert.equal(cmd('worker', 'c', T.WORK_COMPLETED, data).duplicate, true);
  assert.equal(store.db.prepare('SELECT count(*) n FROM public_receipts').get().n, 0);
  assert.equal((await fetch(url)).status, 404);
  assert.doesNotThrow(() => auditRecovery(store));
});

test('opted-in verified receipt resolves publicly and opt-out hides it', async t => {
  // L3-D1 (#6204): the recorded opt-in is the publication decision.
  // Current rooms still write no public_receipts rows; the public face
  // derives the terminal receipt at read time.
  const { store, cmd, data, url } = await setup(t, { receiptsOn: true, result: 'pass' });
  assert.equal((await fetch(url)).status, 200, 'opted-in verified receipt resolves on the public face');
  cmd('owner', 'off', T.ROOM_PUBLIC_RECEIPTS_SET, { enabled: false });
  assert.equal(cmd('worker', 'c', T.WORK_COMPLETED, data).duplicate, true);
  assert.equal(store.db.prepare('SELECT count(*) n FROM public_receipts').get().n, 0);
  assert.equal((await fetch(url)).status, 404, 'opt-out hides the derived receipt again');
  assert.doesNotThrow(() => auditRecovery(store));
});
