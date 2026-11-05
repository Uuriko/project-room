import { HttpTestRoom } from './http-worker.test-fixture.mjs';
import { RoomStore } from '../server/store.mjs';
import { durableStorage } from './storage.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { runGuideStep } from '../server/room-guide.mjs';

export class CanonicalPostContextTestRoom extends HttpTestRoom {
  async fetch() {
    const store = this.store;
    store.maintainMessageCertification = true;
    store.initialize(initialRoom());
    const owner = store.issueAccessKey('commons', 'owner');
    store.command(owner, 'commons', { id: 'work', type: 'work.proposed', data: {
      workItemId: 'review', title: 'Review patch', definitionOfDone: 'Report findings', mode: 'read', accountableMemberId: 'owner'
    } });
    const post = id => store.command(owner, 'commons', {
      id, type: 'message.posted', data: { messageId: id, body: `Body ${id}` }
    });
    post('first');
    while (!store.backfillMessages({ limit: 1000 }).done) {}
    store.checkMessagesParity();
    store.migrateMessageAuthority('commons');
    store.maintainMessageCertification = false;
    const workBefore = store.db.prepare("SELECT * FROM work_entities WHERE room_id='commons'").all();
    const room = store.room;
    let wholeRoomReads = 0;
    store.room = function(...args) { wholeRoomReads++; return room.apply(this, args); };
    try { post('second'); } finally { store.room = room; }
    const raw = JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get().projection);
    let corruptSkipRefused = false;
    try {
      store.transaction(() => {
        store.db.prepare("UPDATE rooms SET projection=json_set(projection,'$.room.starterSeeded',0) WHERE id='commons'").run();
        runGuideStep(store, 'commons');
      });
    } catch (error) { corruptSkipRefused = error.message.includes('projection_corrupt'); }
    const workUnchanged = JSON.stringify(store.db.prepare("SELECT * FROM work_entities WHERE room_id='commons'").all()) === JSON.stringify(workBefore);
    let corruptWorkRefused = false;
    try {
      store.transaction(() => {
        store.db.prepare("UPDATE work_entities SET body='{}' WHERE room_id='commons' AND work_id='review'").run();
        post('must-refuse');
      });
    } catch (error) { corruptWorkRefused = error.message.includes('work_projection_corrupt'); }
    const cold = new RoomStore(null, { database: store.db, storagePlatform: durableStorage });
    return Response.json({ wholeRoomReads, corruptSkipRefused, corruptWorkRefused, workUnchanged, count: raw.messageAuthority.count,
      hasArray: Object.hasOwn(raw, 'messages'), bodies: cold.room('commons').state.messages.map(message => message.body) });
  }
}
export default { fetch(request, env) { return env.ROOM.getByName('canonical-post-fixture').fetch(request); } };
