import worker, { ProjectRoom } from "./room.mjs";
import { HEARTBEAT_STORAGE_KEY } from "./job-heartbeat.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { relieveProjectionsIncrementally } from "../server/store-relief.mjs";
import { operatorArchive } from "../server/operator-archive.mjs";

export class CronIsolationProbe extends ProjectRoom {
  async boundedRelief() {
    this.store.initialize(initialRoom("relief-probe"));
    let clock = Date.now();
    this.store.now = () => clock;
    const key = this.store.issueAccessKey("relief-probe", "owner");
    const post = i => {
      clock += 10_000;
      this.store.command(key, "relief-probe", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED,
        data: { messageId: `probe-${i}`, body: `message ${i}`.padEnd(100, "x") } });
    };
    for (let i = 0; i < 200; i++) post(i);
    while (!this.store.backfillMessages({ limit: 1000 }).done) { /* initial verified prefix */ }
    for (let i = 200; i < 320; i++) post(i);
    const result = await relieveProjectionsIncrementally(this.store, {
      limitBytes: 1, recovery: { key: "fixture", target: "kv" }, keepNewest: 100, eventCap: 1, chunkSize: 1
    });
    let diagnostic = null;
    if (!result.relieved) {
      try { operatorArchive(this.store, { roomId: "relief-probe", keepNewest: 100, belowCursor: true, reason: "fixture diagnosis" }, null, { eventCap: 0 }); }
      catch (error) { diagnostic = error.stack; }
    }
    return { result, diagnostic, newestKept: this.store.room("relief-probe").state.messages.some(m => m.id === "probe-319") };
  }
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
    if (new URL(request.url).pathname === "/bounded-relief") return Response.json(await room.boundedRelief());
    if (new URL(request.url).pathname === "/concurrent") return Response.json(await room.concurrentCommits());
    let error = null;
    try { await worker.scheduled({}, env, ctx); }
    catch (caught) { error = caught.message; }
    return Response.json({ error, recorded: await env.ROOM.getByName("invite-only-pilot").recordedJobs() });
  }
};
