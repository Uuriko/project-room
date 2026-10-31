import { ProjectRoom } from './room.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { patrolPendingSince } from '../server/patrol.mjs';
import { jobHealthView, applyOutcomes } from './job-heartbeat.mjs';
export class PatrolHealthProbe extends ProjectRoom {
  async proof(count) {
    const store = this.store;
    store.initialize(initialRoom('patrol-cost'));
    store.patrolTick();
    const now = Date.now();
    const old = applyOutcomes({}, [{ job: 'patrol', ok: true, at: now - 3600000 }]);
    const view = () => jobHealthView(old, now, {}, store).jobs.find(row => row.name === 'patrol');
    const idle = view().status;
    const key = store.issueAccessKey('patrol-cost', 'owner');
    store.command(key, 'patrol-cost', { id: 'fresh-event', type: 'message.posted', data: { body: 'Synthetic fresh event' } });
    const fresh = jobHealthView(old, Date.now(), {}, store).jobs.find(row => row.name === 'patrol');
    const head = store.db.prepare('SELECT sequence FROM rooms WHERE id=?').get('patrol-cost').sequence;
    const insert = store.db.prepare('INSERT INTO events(room_id,sequence,id,body) VALUES (?,?,?,?)');
    store.transaction(() => {
      for (let i = 1; i <= count; i++) insert.run('patrol-cost', head+i, `padding-${i}`, JSON.stringify({ at: new Date(now).toISOString() }));
      store.db.prepare('UPDATE rooms SET sequence=? WHERE id=?').run(head+count, 'patrol-cost');
    });
    const before = store.db.rowsRead;
    const pending = patrolPendingSince(store, Date.now());
    return { idle, fresh: fresh.status, pendingKnown: Number.isFinite(pending), rowsRead: store.db.rowsRead-before };
  }
}
export default { async fetch(request, env) {
  const count = Number(new URL(request.url).searchParams.get('n'));
  return Response.json(await env.ROOM.getByName(`patrol-${count}`).proof(count));
} };
