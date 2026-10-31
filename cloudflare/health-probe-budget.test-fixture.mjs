import { DurableObject } from 'cloudflare:workers';
import worker from './room.mjs';
export class BudgetProbe extends DurableObject {
  calls = 0;
  config = {};
  configure(config) { this.config = config; }
  count() { return this.calls; }
  fetch() { this.calls++; throw new Error('Unexpected Durable Object fetch forwarding'); }
  async result() {
    this.calls++;
    const config = this.config;
    if (config.stalled) {
      // A held RPC has no completion until the test explicitly releases it.
      // Keep I/O pending as a real blocked storage/network operation would.
      const keepAlive = setInterval(() => {}, 1000);
      try { await new Promise(resolve => { this.release = resolve; }); }
      finally { clearInterval(keepAlive); }
    } else await new Promise(resolve => setTimeout(resolve, config.delay ?? 0));
    if (config.error) throw new Error('fixture RPC failure');
    return config;
  }
  async probeStorage() { const config = await this.result(); return { ok: config.ok !== false, emailVerification: 'enforced' }; }
  async readJobHealth() { await this.result(); return { schema: 'room.job-health/1', status: 'ok', jobs: [] }; }
  unblock() { this.release?.(); }
}
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname, stub = env.ROOM.getByName('invite-only-pilot');
    if (path === '/configure') { await stub.configure(await request.json()); return new Response('configured'); }
    if (path === '/count') return Response.json({ count: await stub.count() });
    if (path === '/unblock') { await stub.unblock(); return new Response('released'); }
    return worker.fetch(request, env, ctx);
  }
};
