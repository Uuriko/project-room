import worker, { ProjectRoom } from "./room.mjs";
import { HEARTBEAT_STORAGE_KEY } from "./job-heartbeat.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { relieveProjectionsIncrementally } from "../server/store-relief.mjs";
import { operatorArchive } from "../server/operator-archive.mjs";

export class CronIsolationProbe extends ProjectRoom {
  async syncGmailMailboxes() {
    if (!this.ownershipProbe) return super.syncGmailMailboxes();
    this.gmailExecutions = (this.gmailExecutions ?? 0) + 1;
    return { completed: 0 };
  }
  async drainChannelBacklog() {
    if (!this.ownershipProbe) return super.drainChannelBacklog();
    this.channelExecutions = (this.channelExecutions ?? 0) + 1;
    return { completed: 0 };
  }
  async recordCronTick(outcomes) {
    if (this.ownershipProbe && outcomes.some(o => o.job === 'gmail-sync')) {
      this.gmailCommits = (this.gmailCommits ?? 0) + 1;
      await this.commitGate;
      if (this.failCommit) throw new Error('fixture heartbeat write refused');
    }
    return super.recordCronTick(outcomes);
  }
  async exerciseOwnership(failCommit) {
    this.ownershipProbe = true;
    this.env.ROOM_GMAIL_ENABLED = '1';
    this.failCommit = failCommit;
    this.store.createAccount('ownership-account');
    this.store.db.prepare("INSERT INTO private_email_connections (account_id, id, provider, mailbox_id, data_json) VALUES (?, ?, ?, ?, ?)")
      .run('ownership-account', 'ownership-connection', 'telegram-bot', 'ownership-chat', '{}');
    this.store.db.prepare("INSERT INTO pending_channel_updates (account_id, connection_id, update_id, received_at, payload, status, attempts, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run('ownership-account', 'ownership-connection', 1, Date.now(), '{}', 'pending', 0, null, Date.now());
    let release;
    this.commitGate = new Promise(resolve => { release = resolve; });
    const requests = [this.ensureJobAlarm()];
    // Register rejection handlers before the injected commit failure is released.
    const observe = pending => pending.then(value => ({ ok: true, value }), () => ({ ok: false }));
    const observed = [observe(requests[0])];
    try {
      for (let i = 0; !this.gmailCommits && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
      if (!this.gmailCommits) throw new Error('never reached outcome write');
      for (let i = 0; i < 7; i++) observed.push(observe(this.ensureJobAlarm()));
      await new Promise(resolve => setTimeout(resolve, 50));
      const parked = { executions: this.gmailExecutions, commits: this.gmailCommits };
      // Another invocation completed this job while the first caller waited on
      // Gmail. Its original selection must not run the now-current channel job.
      await super.recordCronTick([{ job: 'channel-drain', ok: true, at: Date.now(), durationMs: 0 }]);
      await this.runSlowJob('integrity');
      const independent = !!(await this.recordedJobs()).integrity?.lastSuccessAt;
      release();
      const failures = (await Promise.all(observed)).filter(r => !r.ok).length;
      this.failCommit = false;
      await this.ensureJobAlarm();
      return { parked, failures, independent, channelExecutions: this.channelExecutions ?? 0,
        afterRetry: { executions: this.gmailExecutions, commits: this.gmailCommits } };
    } finally { release(); await Promise.all(observed); }
  }
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
    if (new URL(request.url).pathname === "/ownership") return Response.json(await room.exerciseOwnership(new URL(request.url).searchParams.has('failure')));
    if (new URL(request.url).pathname === "/bounded-relief") return Response.json(await room.boundedRelief());
    if (new URL(request.url).pathname === "/concurrent") return Response.json(await room.concurrentCommits());
    let error = null;
    try { await worker.scheduled({}, env, ctx); }
    catch (caught) { error = caught.message; }
    return Response.json({ error, recorded: await env.ROOM.getByName("invite-only-pilot").recordedJobs() });
  }
};
