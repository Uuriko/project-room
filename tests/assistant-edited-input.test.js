// The real HTTP boundary owns edit-versus-publication ordering for shared runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';

for (const changed of ['opening', 'contribution']) for (const finish of ['publish', 'report']) {
  test(`${finish} must reconsider an edited ${changed}, even after acknowledging it`, async t => {
    const f = createAcceptanceFixture();
    const server = createRoomServer({ store: f.store });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
    const origin = `http://127.0.0.1:${server.address().port}/api/rooms/commons`;
    const call = async (actor, path, input, status = path === 'commands' ? 201 : 200) => {
      const response = await fetch(`${origin}/${path}`, { method: input ? 'POST' : 'GET', headers: { authorization: `Bearer ${f.keys[actor]}`, 'content-type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
      const value = await response.json();
      assert.equal(response.status, status, JSON.stringify(value)); return value;
    };
    const act = (actor, input, status) => call(actor, 'assistant', { requestId: randomUUID(), ...input }, status);
    const post = (actor, messageId, body) => call(actor, 'commands', { id: randomUUID(), type: 'message.posted', data: { messageId, body } });
    await act('owner', { action: 'configure', expectedRevision: 0, name: 'Room', coordinatorMemberId: 'producer' });
    await post('owner', 'opening', 'Plan dinner Friday.');
    await post('guest', 'contribution', 'Include eight people.');
    await act('owner', { action: 'invoke', runId: 'dinner', sourceMessageId: 'opening' });
    await act('guest', { action: 'contribute', runId: 'dinner', sourceMessageId: 'contribution', expectedRevision: 0 });
    await act('producer', { action: 'claim', runId: 'dinner', attemptId: 'host', expectedRevision: 1 });
    const acknowledged = (await act('producer', { action: 'report', runId: 'dinner', attemptId: 'host', expectedRevision: 2, state: 'working', summary: 'Read both inputs.', appliedInputMessageIds: ['opening', 'contribution'] })).result;
    const edit = { id: randomUUID(), type: 'message.edited', data: { messageId: changed, expectedMessageRevision: 0, body: changed === 'opening' ? 'Plan dinner Saturday.' : 'Include twelve people.' } };
    await call(changed === 'opening' ? 'owner' : 'guest', 'commands', edit);
    if (finish === 'report') await post('producer', 'answer', 'Dinner on Friday for eight.');
    const completion = { action: finish, runId: 'dinner', attemptId: 'host', expectedRevision: acknowledged.revision, summary: 'Dinner planned.', ...(finish === 'publish' ? { body: 'Dinner on Friday for eight.' } : { state: 'done', resultMessageId: 'answer' }) };
    const refused = await act('producer', completion, 409);
    assert.equal(refused.error.code, 'assistant_revision_conflict');
    const current = (await call('producer', 'assistant')).runs.find(run => run.id === 'dinner');
    assert.equal(current.revision, acknowledged.revision + 1);
    assert.equal(current.status, 'working');
    assert.equal(current.inputs.find(input => input.sourceMessageId === changed).status, 'pending');
    assert.equal(current.inputs.find(input => input.sourceMessageId !== changed).status, 'applied');
    assert.equal(current.resultMessageId, undefined);
    assert.equal(f.store.room('commons').state.messages.filter(message => message.id.startsWith('assistant-publish-')).length, 0);
    // Re-reading the run alone cannot silently re-acknowledge the changed text.
    const pending = await act('producer', { ...completion, expectedRevision: current.revision }, 409);
    assert.equal(pending.error.code, 'assistant_inputs_pending');
    // Retrying a lost edit response does not invalidate twice.
    await call(changed === 'opening' ? 'owner' : 'guest', 'commands', edit, 200);
    assert.equal((await call('producer', 'assistant')).runs.find(run => run.id === 'dinner').revision, current.revision);
    if (finish === 'report') await call('producer', 'commands', { id: randomUUID(), type: 'message.edited', data: { messageId: 'answer', expectedMessageRevision: 0, body: 'Dinner updated to the revised instructions.' } });
    const repaired = (await act('producer', { ...completion, expectedRevision: current.revision, appliedInputMessageIds: [changed], ...(finish === 'publish' ? { body: 'Dinner updated to the revised instructions.' } : {}) })).result;
    assert.equal(repaired.status, 'done');
    // Historical completion remains a receipt; later edits do not reopen work.
    await call(changed === 'opening' ? 'owner' : 'guest', 'commands', { ...edit, id: randomUUID(), data: { ...edit.data, expectedMessageRevision: 1, body: 'A later request.' } });
    assert.equal((await call('producer', 'assistant')).runs.find(run => run.id === 'dinner').revision, repaired.revision);
  });
}
