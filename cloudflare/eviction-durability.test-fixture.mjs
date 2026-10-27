// B3-2 eviction-durability probe. Miniflare CAN evict a Durable Object
// that holds no open stream or in-flight request (mf.unsafeEvictDurableObject),
// so the legs the audit's S5 staged — a completed channel drain's outcome
// and the store's storage-failure streak, both held in instance memory —
// are staged here through the real code paths, evicted, and probed on the
// successor instance. The mid-stream / mid-write legs stay instrument-
// blocked (the eviction call times out while references are held); this
// fixture makes no claim about them.
import worker, { ProjectRoom } from "./room.mjs";
import { runCronJobs } from "./job-heartbeat.mjs";

export class EvictionProbe extends ProjectRoom {
  // A unique id per constructed instance: a changed value on the next
  // probe proves the successor is a different instance, not a cache hit.
  instanceId() {
    return (this._iid ??= "inst-" + Math.random().toString(36).slice(2, 10));
  }
  // Seed one channel connection + journal row so the drain gate opens
  // (same seed as the jobs-alarm probe), then run one drain tick: the
  // background half completes and stashes its outcome through
  // #stashChannelDrainOutcome, exactly as in production.
  seedChannelDrain() {
    this.store.createAccount("acct_evict_probe");
    this.store.db.prepare("INSERT INTO private_email_connections (account_id, id, provider, mailbox_id, data_json) VALUES (?, ?, ?, ?, ?)")
      .run("acct_evict_probe", "conn_evict_probe", "telegram-bot", "chat_evict_probe", "{}");
    this.store.db.prepare("INSERT INTO pending_channel_updates (account_id, connection_id, update_id, received_at, payload, status, attempts, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("acct_evict_probe", "conn_evict_probe", 1, Date.now(), "{}", "pending", 0, null, Date.now());
    return { seeded: true };
  }
  runDrainTick() { return this.drainChannelBacklog(); }
  // One drain cron tick composed exactly as the alarm composes it: run
  // the job, then record the outcomes (recordCronTick is the consumer).
  async runDrainTickAndRecord() {
    const outcomes = await runCronJobs({ "channel-drain": () => this.drainChannelBacklog() }, { log: () => {} });
    await this.recordCronTick(outcomes);
    return outcomes.map(outcome => ({ job: outcome.job, ok: outcome.ok, unobserved: outcome.unobserved === true }));
  }
  async readDrainState() {
    return {
      iid: this.instanceId(),
      outcome: this.channelDrainOutcome ?? null,
      held: this.channelDrainOutcomeHeld ?? null
    };
  }
  // Stage the failure streak through the real counter: three outermost
  // storage-unavailable refusals (threshold is 3 by default).
  stageStorageFailures() {
    const driverError = () => Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10, errstr: "disk I/O error" });
    for (let i = 0; i < 3; i++) this.store.storageFailure(driverError());
    return this.readStorageState();
  }
  // A committed write that changes rows: the recovery contract's proof
  // that storage is writable again (clears the streak).
  commitWrite() {
    this.store.createAccount("acct_evict_recovery");
    return this.readStorageState();
  }
  readStorageState() {
    return {
      iid: this.instanceId(),
      storageFailures: this.store.storageFailures,
      storageFailureLastAt: this.store.storageFailureLastAt,
      storageStatus: this.store.storageStatus()
    };
  }
}

function room(env, request) {
  const name = new URL(request.url).searchParams.get("name") || "invite-only-pilot";
  return env.ROOM.getByName(name);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/probe/seed-drain") return Response.json(await room(env, request).seedChannelDrain());
    if (url.pathname === "/probe/drain-tick") return Response.json(await room(env, request).runDrainTick());
    if (url.pathname === "/probe/drain-tick-record") return Response.json(await room(env, request).runDrainTickAndRecord());
    if (url.pathname === "/probe/drain-state") return Response.json(await room(env, request).readDrainState());
    if (url.pathname === "/probe/storage-fail-stage") return Response.json(await room(env, request).stageStorageFailures());
    if (url.pathname === "/probe/commit-write") return Response.json(await room(env, request).commitWrite());
    if (url.pathname === "/probe/storage-state") return Response.json(await room(env, request).readStorageState());
    return worker.fetch(request, env, ctx);
  }
};
