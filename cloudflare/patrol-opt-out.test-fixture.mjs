import { ProjectRoom } from './room.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { jobByName, earliestFutureAlarm } from '../server/jobs.mjs';
import { selectWorkerJobs, jobHealthView } from './job-heartbeat.mjs';
export class PatrolOptOutProbe extends ProjectRoom {
  async proof() {
    this.store.initialize(initialRoom('patrol-opt-out'));
    this.store.patrolTick();
    const key = this.store.issueAccessKey('patrol-opt-out', 'owner');
    this.store.command(key, 'patrol-opt-out', { id: 'pending', type: 'message.posted', data: { body: 'Synthetic patrol work' } });
    const before = this.store.db.prepare('SELECT * FROM patrol_cursor').all();
    let patrolSql = 0;
    const prepare = this.store.db.prepare.bind(this.store.db);
    this.store.db.prepare = sql => { if (/patrol_/i.test(sql)) patrolSql++;return prepare(sql); };
    const selected = selectWorkerJobs(this.env, this.store, { onlyJob: 'patrol' }).map(job => job.name);
    const alarm = earliestFutureAlarm([jobByName('patrol')], { env: this.env, store: this.store, now: Date.now(), lastRan: {} });
    const health = jobHealthView({}, Date.now(), this.env, this.store).jobs.find(job => job.name === 'patrol');
    const rpc = await this.patrolTick();
    const cron = await this.ensureJobAlarm();
    const scans = patrolSql;
    this.store.db.prepare = prepare;
    const after = this.store.db.prepare('SELECT * FROM patrol_cursor').all();
    this.store.patrolTick({ roomId: 'patrol-opt-out' });
    const manual = this.store.db.prepare('SELECT * FROM patrol_cursor').all();
    return { selected, alarm, health, rpc, cron, scans, before, after, manual };
  }
}
export default { async fetch(_request, env) { return Response.json(await env.ROOM.getByName('probe').proof()); } };
