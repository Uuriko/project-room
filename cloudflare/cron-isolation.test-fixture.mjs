import worker, { ProjectRoom } from "./room.mjs";
import { HEARTBEAT_STORAGE_KEY } from "./job-heartbeat.mjs";

export class CronIsolationProbe extends ProjectRoom {
  async runSlowJob(name) {
    if (name === this.env.FAIL_SLOW_JOB) throw new Error("simulated RPC reset");
    return super.runSlowJob(name);
  }
  async recordedJobs() { return await this.ctx.storage.get(HEARTBEAT_STORAGE_KEY) ?? {}; }
  async concurrentCommits() {
    await Promise.all(["retention", "integrity"].map(job => this.recordCronTick([
      { job, ok: true, at: 1234, durationMs: 0 }
    ])));
    return this.recordedJobs();
  }
}

export default {
  async fetch(request, env, ctx) {
    const room = env.ROOM.getByName("invite-only-pilot");
    if (new URL(request.url).pathname === "/concurrent") return Response.json(await room.concurrentCommits());
    let error = null;
    try { await worker.scheduled({}, env, ctx); }
    catch (caught) { error = caught.message; }
    return Response.json({ error, recorded: await env.ROOM.getByName("invite-only-pilot").recordedJobs() });
  }
};
