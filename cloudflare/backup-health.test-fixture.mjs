import worker, { ProjectRoom } from './room.mjs';
import { HEARTBEAT_STORAGE_KEY, CRON_JOBS } from './job-heartbeat.mjs';
export class BackupHealthProbe extends ProjectRoom {
  constructor(ctx, env) {
    const counters = { puts: 0, manifests: 0, fail: true };
    const kv = env.ROOM_BACKUPS_KV;
    super(ctx, kv ? { ...env, ROOM_BACKUPS_KV: {
      get: (...args) => kv.get(...args),
      put: async (key, ...args) => {
        counters.puts++;
        if (counters.fail) { counters.fail = false; throw Error('PRIVATE_KV_FAILURE'); }
        await kv.put(key, ...args);
        if (!key.includes('.part-')) counters.manifests++;
      }
    } } : env);
    this.counters = counters;
    this.healthMode = 'normal';
  }
  async runBackup() {
    try { await this.runSlowJob('room-backup'); } catch { /* inspect durable receipt */ }
    return { ...this.counters, health: await super.readJobHealth() };
  }
  async ageBackup() {
    const stored = await this.ctx.storage.get(HEARTBEAT_STORAGE_KEY);
    stored['room-backup'].lastRunAt = Date.now() - 1800001;
    await this.ctx.storage.put(HEARTBEAT_STORAGE_KEY, stored);
    return {};
  }
  async setHealthMode(mode) {
    this.healthMode = mode;
    const now = Date.now(), stored = Object.fromEntries(CRON_JOBS.map(job => [job.name, { lastRunAt: now, lastSuccessAt: now, consecutiveFailures: 0 }]));
    if (mode === 'failing') stored['room-backup'].consecutiveFailures = 1;
    if (mode === 'stale') stored['room-backup'] = { lastRunAt: now - 4 * 86400000, lastSuccessAt: now - 4 * 86400000, consecutiveFailures: 0 };
    await this.ctx.storage.put(HEARTBEAT_STORAGE_KEY, stored);
    return {};
  }
  async readJobHealth() {
    if (this.healthMode === 'timeout') await new Promise(resolve => setTimeout(resolve, 1500));
    return super.readJobHealth();
  }
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), room = env.ROOM.getByName('invite-only-pilot');
    if (url.pathname === '/test/run') return Response.json(await room.runBackup());
    if (url.pathname === '/test/age') return Response.json(await room.ageBackup());
    if (url.pathname === '/test/mode') return Response.json(await room.setHealthMode(url.searchParams.get('mode')));
    return worker.fetch(request, env, ctx);
  }
};
