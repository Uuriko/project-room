// Local probe. Workerd decides when ProjectRoom.alarm runs and whether a
// thrown alarm is still armed afterwards.
import worker, { ProjectRoom } from "./room.mjs";
import { CHANNEL_DRAIN_INFLIGHT_KEY } from "./channel-drain-tick.mjs";
import { runCronJobs } from "./job-heartbeat.mjs";

export class JobsProbe extends ProjectRoom {
  constructor(ctx, env) {
    super(ctx, env);
    this.gmailRuns = 0;
    this.channelRuns = 0;
  }
  async syncGmailMailboxes() {
    this.gmailRuns += 1;
    return super.syncGmailMailboxes();
  }
  async drainChannelBacklog() {
    this.channelRuns += 1;
    return super.drainChannelBacklog();
  }
  // #3893 retired this probe's original throw vehicle: the seed used to
  // plant a malformed payload_json row whose JSON.parse throw aborted
  // the drain and failed the webhook-dispatch job. The drain now
  // isolates such rows instead (they dead-letter; the job stays healthy
  // — pinned by tests/webhook-drain-poison-isolation.test.js), so the
  // alarm check arms the throw directly. The subject under test is the
  // alarm machinery — a thrown alarm is re-armed and the failure lands
  // in job health — not the drain's error shape.
  async drainWebhookDeliveries() {
    if (this.drainFailureArmed) throw new Error("seeded webhook drain failure");
    return super.drainWebhookDeliveries();
  }
  jobRunCounts() {
    return { gmailRuns: this.gmailRuns, channelRuns: this.channelRuns };
  }
  async readJobAlarm() {
    if (this.paused || !this.store) return null;
    return this.ctx.storage.getAlarm();
  }
  // Invoke the DO's own fetch handler, whose finally arms the job alarm via
  // waitUntil — the per-request arming path, without running due jobs first
  // (ensureJobAlarm runs them, which would mask the armed time).
  async armViaFetch() {
    const response = await this.fetch(new Request("https://room.example.test/api/health/jobs"));
    return { status: response.status };
  }
  async finishPublicBackfill() {
    for (let step = 0; step < 8; step += 1) {
      const result = await this.backfillPublicReadModel();
      if (result?.done) return { done: true, steps: step + 1 };
    }
    return { done: false, steps: 8 };
  }
  seedDueWebhook(delayMs) {
    const now = Date.now();
    const due = now + delayMs;
    this.store.db.prepare(`INSERT INTO agent_webhook_deliveries
      (delivery_id, idempotency_key, subscription_id, agent_id, event_type, payload_json, signature, state, attempts, next_attempt_at, created_at, updated_at)
      VALUES ('del_due', 'manual:del_due', 'sub_missing', 'ai_missing', 'message.posted', '{}', 'sig', 'pending', 0, ?, ?, ?)`)
      .run(due, now, now);
    return { deliveryId: "del_due", due };
  }
  seedThrowingWebhook() {
    // A due delivery row must exist or the webhook-dispatch job is
    // disabled and never runs; the armed override above supplies the
    // throw when it does. The row itself is well-formed now — a
    // malformed one no longer throws (#3893).
    const identity = this.store.identities.create("Alarm Throw");
    const signing = "alarm-throw-" + "fixture";
    const subscribed = this.store.agentPlugin.subscribeWebhook({
      identityId: identity.identityId,
      url: "https://hooks.example.test/hook",
      events: ["message.posted"],
      secret: signing
    });
    const now = Date.now();
    this.store.db.prepare(`INSERT INTO agent_webhook_deliveries
      (delivery_id, idempotency_key, subscription_id, agent_id, event_type, room_id, target_url, payload_json, signature, state, attempts, next_attempt_at, created_at, updated_at)
      VALUES ('del_throw', 'manual:del_throw', ?, ?, 'message.posted', NULL, 'https://hooks.example.test/hook', '{}', 'sig', 'pending', 0, ?, ?, ?)`)
      .run(subscribed.subscription.subscriptionId, identity.identityId, now, now, now);
    this.drainFailureArmed = true;
    return { deliveryId: "del_throw", due: now };
  }
  readDelivery(deliveryId) {
    return this.store.db.prepare(
      "SELECT state, attempts, next_attempt_at AS nextAttemptAt FROM agent_webhook_deliveries WHERE delivery_id=?"
    ).get(deliveryId) ?? null;
  }
  // alarm() is reserved on the RPC stub. The platform calls it; this probe
  // calls the same method directly so the test can see a throw and the re-arm.
  async runAlarm() {
    await this.alarm();
  }
  // #3927: seed one channel connection + journal row so the drain gate
  // opens. The account goes through the store API because the journal's
  // foreign keys are enforced in DO SQLite (PRAGMA cannot relax them).
  seedChannelDrain() {
    this.store.createAccount("acct_drain_probe");
    this.store.db.prepare("INSERT INTO private_email_connections (account_id, id, provider, mailbox_id, data_json) VALUES (?, ?, ?, ?, ?)")
      .run("acct_drain_probe", "conn_drain_probe", "telegram-bot", "chat_drain_probe", "{}");
    this.store.db.prepare("INSERT INTO pending_channel_updates (account_id, connection_id, update_id, received_at, payload, status, attempts, last_error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("acct_drain_probe", "conn_drain_probe", 1, Date.now(), "{}", "pending", 0, null, Date.now());
    return { seeded: true };
  }
  // #3927 R3: an evicted instance's residue — a durable inflight stamp
  // with cold in-memory fields. Miniflare cannot evict on demand, so the
  // probe writes the stamp and clears the fields directly.
  async seedOrphanDrainStamp(ageMs) {
    const stamp = Date.now() - ageMs;
    await this.ctx.storage.put(CHANNEL_DRAIN_INFLIGHT_KEY, stamp);
    this.channelDrainInflight = false;
    this.channelDrainInflightSince = null;
    return { stamp };
  }
  runDrainTick() { return this.drainChannelBacklog(); }
  // One drain cron tick composed exactly as #runDueJobs composes it:
  // run the job, then record the outcomes.
  async runDrainTickAndRecord() {
    const outcomes = await runCronJobs({ "channel-drain": () => this.drainChannelBacklog() }, { log: () => {} });
    await this.recordCronTick(outcomes);
    return outcomes.map(outcome => ({ job: outcome.job, ok: outcome.ok, unobserved: outcome.unobserved === true }));
  }
  async readDrainState() {
    return {
      outcomeAt: this.channelDrainOutcome?.at ?? null,
      heldAt: this.channelDrainOutcomeHeld?.at ?? null,
      inflight: this.channelDrainInflight === true,
      stamp: await this.ctx.storage.get(CHANNEL_DRAIN_INFLIGHT_KEY) ?? null
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
    if (url.pathname === "/scheduled") {
      await worker.scheduled({ cron: "*/30 * * * *" }, env, ctx);
      const probe = env.ROOM.getByName("invite-only-pilot");
      return Response.json({ scheduled: true, counts: await probe.jobRunCounts() });
    }
    if (url.pathname === "/probe/backfill") {
      return Response.json(await room(env, request).finishPublicBackfill());
    }
    if (url.pathname === "/probe/ensure") {
      const result = await room(env, request).ensureJobAlarm();
      return Response.json(result);
    }
    if (url.pathname === "/probe/alarm-at") {
      return Response.json({ alarmAt: await room(env, request).readJobAlarm() });
    }
    if (url.pathname === "/probe/arm") {
      return Response.json(await room(env, request).armViaFetch());
    }
    if (url.pathname === "/probe/seed-due") {
      const delay = Number(url.searchParams.get("delayMs") ?? "30000");
      return Response.json(await room(env, request).seedDueWebhook(delay));
    }
    if (url.pathname === "/probe/seed-throw") {
      return Response.json(await room(env, request).seedThrowingWebhook());
    }
    if (url.pathname === "/probe/delivery") {
      return Response.json(await room(env, request).readDelivery(url.searchParams.get("id")));
    }
    if (url.pathname === "/probe/seed-drain") {
      return Response.json(await room(env, request).seedChannelDrain());
    }
    if (url.pathname === "/probe/seed-orphan") {
      return Response.json(await room(env, request).seedOrphanDrainStamp(Number(url.searchParams.get("ageMs") || "0")));
    }
    if (url.pathname === "/probe/drain-tick") {
      return Response.json(await room(env, request).runDrainTick());
    }
    if (url.pathname === "/probe/drain-tick-record") {
      return Response.json(await room(env, request).runDrainTickAndRecord());
    }
    if (url.pathname === "/probe/drain-state") {
      return Response.json(await room(env, request).readDrainState());
    }
    if (url.pathname === "/probe/alarm") {
      const target = room(env, request);
      try {
        await target.runAlarm();
        return Response.json({ ok: true, alarmAt: await target.readJobAlarm() });
      } catch (error) {
        return Response.json({
          ok: false,
          error: error?.message ?? String(error),
          alarmAt: await target.readJobAlarm(),
          health: await target.readJobHealth()
        }, { status: 500 });
      }
    }
    return worker.fetch(request, env, ctx);
  }
};
