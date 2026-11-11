import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createWork } from '../server/work-claims.mjs';
import { availableClaimsFromBoard, availableWorkInRoom } from '../server/available-work.mjs';
import { openWorkOf } from '../server/needs-me.mjs';
import { createRoomServer } from '../server/http.mjs';

for (const workEntities of [false, true]) {
  test(`discovery excludes dangling and unaccepted work links, preserving native and accepted work (entities=${workEntities})`, t => {
    const store = new RoomStore(':memory:', { workEntities }); t.after(() => store.close());
    store.initialize(initialRoom());
    const token = store.issueAccessKey('commons', 'owner');
    const command = (id, type, data) => store.command(token, 'commons', { id, type, data });
    command('policy', 'room.policy_set', { requireIndependentReview: false, requireOwnerDecision: false });
    for (const workItemId of ['accepted', 'unaccepted']) {
      command('propose-' + workItemId, 'work.proposed', { workItemId, title: workItemId,
        definitionOfDone: 'Explicit result', accountableMemberId: 'owner', mode: 'read' });
    }
    command('accept', 'work.accepted', { workItemId: 'accepted', expectedRevision: 0 });
    const add = (id, extra = {}) => store.workClaims.set('commons', { ...createWork({ id, title: id },
      { now: Date.now(), agentId: 'owner' }), ...extra });
    // Same suffix alone must never suppress independently authored native work.
    add('native-next');
    add('unaccepted', { workItemId: 'unaccepted' });
    for (let n = 0; n < 60; n++) add('orphan-' + n, { workItemId: 'missing-' + n });
    const snapshot = store.db.prepare('SELECT * FROM work_claims WHERE room_id=? ORDER BY rowid').all('commons');
    const available = availableWorkInRoom(store, 'commons', { viewerId: 'owner', limit: 2 });
    assert.equal(available.total, 2, 'filter before result cap');
    assert.deepEqual(available.items.map(item => item.id).sort(), ['accepted', 'native-next']);
    const authority = store.roomAuthority('commons');
    const room = store.room;
    let inbox;
    store.room = () => { throw new Error('inbox must not hydrate the whole room'); };
    try { inbox = openWorkOf(store, 'commons', 'owner', authority); }
    finally { store.room = room; }
    assert.equal(inbox.count, 2);
    assert.deepEqual(inbox.top.map(item => item.id).sort(), ['accepted', 'native-next']);
    assert.deepEqual(store.db.prepare('SELECT * FROM work_claims WHERE room_id=? ORDER BY rowid').all('commons'), snapshot,
      'discovery does not rewrite historical ownership, scope or evidence');
  });
}

test('selected inline null work is not advertised while claim refusal preserves the historical card', async t => {
  const store = new RoomStore(':memory:', { workEntities: false }); store.initialize(initialRoom());
  const token = store.issueAccessKey('commons', 'owner');
  const send = (id, type, data) => store.command(token, 'commons', { id, type, data });
  send('proposal', 'work.proposed', { workItemId: 'accepted', title: 'Canonical inline record',
    definitionOfDone: 'Explicit result', accountableMemberId: 'owner', mode: 'read' });
  send('acceptance', 'work.accepted', { workItemId: 'accepted', expectedRevision: 0 });
  const before = store.workClaims.get('commons', 'accepted');
  // Corruption-only control: keep the key but replace its canonical value.
  store.transaction(() => store.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.workItems.accepted',NULL) WHERE id=?").run('commons'));
  const workItems = JSON.parse(store.db.prepare('SELECT projection FROM rooms WHERE id=?').get('commons').projection).workItems;
  assert.equal(Object.hasOwn(workItems, 'accepted'), true); assert.equal(workItems.accepted, null);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const refused = await fetch(origin + '/api/rooms/commons/work-claims/accepted/claim', { method: 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).linkedWork.status, 'unavailable');
  const authority = store.roomAuthority('commons'), board = store.workClaims.list('commons');
  assert.deepEqual(availableClaimsFromBoard(board, 'commons', { viewerId: 'owner', state: {
    room: { ownerId: authority.ownerId }, members: authority.members, workItems } }), []);
  assert.equal(openWorkOf(store, 'commons', 'owner', authority), null);
  assert.deepEqual(store.workClaims.get('commons', 'accepted'), before);
});
