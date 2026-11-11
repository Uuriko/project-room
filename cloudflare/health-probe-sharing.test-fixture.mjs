// Local-only DO records RPC fan-out while the actual Worker routes readiness.
import { DurableObject } from 'cloudflare:workers';
import worker from './room.mjs';
export class ReadinessCounter extends DurableObject {
  calls = 0;
  async probeStorage() {
    this.calls++;
    await new Promise(resolve => setTimeout(resolve, 100));
    return { ok: true, emailVerification: 'enforced' };
  }
  count() { return this.calls; }
}
export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/count') return env.ROOM.getByName('invite-only-pilot').count().then(count => Response.json({ count }));
    return worker.fetch(request, env, ctx);
  }
};
