// Local probe only. Calls the real ProjectRoom over the Durable Object
// binding so workerd, not a stand-in, decides whether the method exists.
import worker, { ProjectRoom } from './room.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

export { ProjectRoom };

// Synthetic data and fault injection stay in this local-only entrypoint.
export class RetentionTestRoom extends ProjectRoom {
  seedRetention() {
    this.store.initialize(initialRoom('retention', 'owner'));
    this.store.transaction(() => {
      for (const [id, age] of [['old', 35], ['fresh', 2]]) {
        const at = Date.now() - age * 86400000;
        this.store.db.prepare("INSERT INTO web_fetch_log(request_id,room_id,member_id,host,cache_status,bytes,tags_json,created_at) VALUES(?,'retention','owner','example.com','hit',2,'[]',?)").run(id, at);
        this.store.db.prepare("INSERT INTO web_research_log(request_id,room_id,member_id,question_hash,sources_json,evidence_count,plan_only,created_at) VALUES(?,'retention','owner','hash','[]',0,1,?)").run(id, at);
      }
    });
    return this.retentionCounts();
  }
  retentionCounts() {
    const count = table => this.store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
    return { fetch: count('web_fetch_log'), research: count('web_research_log'), events: count('events') };
  }
  retentionFailure(enabled) {
    this.store.db.exec(enabled
      ? "CREATE TRIGGER retention_test_failure BEFORE DELETE ON web_research_log BEGIN SELECT RAISE(ABORT,'retention fixture failure'); END"
      : 'DROP TRIGGER retention_test_failure');
  }
}

const CRON_METHODS = [
  'syncGmailMailboxes',
  'drainChannelBacklog',
  'drainWebhookDeliveries',
  'refreshLandQueue',
  'planRetention'
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/retention/')) {
      const room = env.ROOM.getByName('invite-only-pilot');
      try {
        if (url.pathname === '/retention/seed') return Response.json(await room.seedRetention());
        if (url.pathname === '/retention/counts') return Response.json(await room.retentionCounts());
        if (url.pathname === '/retention/run') return Response.json(await room.planRetention());
        if (url.pathname === '/retention/fail' || url.pathname === '/retention/recover') {
          await room.retentionFailure(url.pathname === '/retention/fail');
          return Response.json({ configured: true });
        }
      } catch (error) { return Response.json({ error: error.message }, { status: 500 }); }
      return new Response('Not found', { status: 404 });
    }
    if (url.pathname === '/scheduled') {
      await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil() {} });
      return Response.json({ scheduled: true });
    }
    if (url.pathname !== '/rpc') return new Response('Not found', { status: 404 });
    const room = env.ROOM.getByName('invite-only-pilot');
    const results = {};
    for (const method of CRON_METHODS) {
      try {
        results[method] = { ok: true, value: await room[method]() };
      } catch (error) {
        results[method] = { ok: false, message: error?.message ?? String(error) };
      }
    }
    try {
      await room.notARealCronMethod();
      results.notARealCronMethod = { ok: true };
    } catch (error) {
      results.notARealCronMethod = { ok: false, message: error?.message ?? String(error) };
    }
    return Response.json(results);
  }
};
