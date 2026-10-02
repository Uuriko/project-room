// Local probe. Workerd decides when ProjectRoom.alarm runs and whether a
// thrown alarm is still armed afterwards.
import worker, { ProjectRoom } from "./room.mjs";

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
  jobRunCounts() {
    return { gmailRuns: this.gmailRuns, channelRuns: this.channelRuns };
  }
  async readJobAlarm() {
    if (this.paused || !this.store) return null;
    return this.ctx.storage.getAlarm();
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
      VALUES ('del_throw', 'manual:del_throw', ?, ?, 'message.posted', NULL, 'https://hooks.example.test/hook', '{', 'sig', 'pending', 0, ?, ?, ?)`)
      .run(subscribed.subscription.subscriptionId, identity.identityId, now, now, now);
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
