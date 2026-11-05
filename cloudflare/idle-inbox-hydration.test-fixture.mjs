import { ProjectRoom } from './room.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
export class IdleInboxProbe extends ProjectRoom {
  async profile() {
    const store = this.store;store.initialize(initialRoom('inbox-profile'));
    const key = store.issueAccessKey('inbox-profile', 'owner');
    let now = Date.now();store.now = () => now;
    for (let i = 0; i < 30; i++) {
      now += 10000;
      store.command(key, 'inbox-profile', { id: `public-${i}`, type: 'message.posted', data: { body: 'public '.repeat(2000) } });
    }
    const expected = store.agentInbox(key, 'inbox-profile');
    store._dropProjectionCache();
    let hydrations = 0;
    const read = store._readProjection.bind(store);
    store._readProjection = (...args) => { hydrations++;return read(...args); };
    const before = store.db.rowsRead;
    const inbox = store.agentInbox(key, 'inbox-profile');
    const rowsRead = store.db.rowsRead-before;
    return { hydrations, rowsRead, same: JSON.stringify(inbox) === JSON.stringify(expected),
      retainedMessages: store.db.prepare("SELECT json_array_length(projection,'$.messages') AS n FROM rooms WHERE id=?").get('inbox-profile').n,
      projectionBytes: store.db.prepare('SELECT length(CAST(projection AS BLOB)) AS n FROM rooms WHERE id=?').get('inbox-profile').n };
  }
}
export default { async fetch(_request, env) { return Response.json(await env.ROOM.getByName('idle-inbox').profile()); } };
