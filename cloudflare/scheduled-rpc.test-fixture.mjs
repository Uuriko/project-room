// Local probe only. Calls the real ProjectRoom over the Durable Object
// binding so workerd, not a stand-in, decides whether the method exists.
import worker, { ProjectRoom } from './room.mjs';

export { ProjectRoom };

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
