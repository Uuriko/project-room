import { ProjectRoom } from './room.mjs';

export class FairnessProbe extends ProjectRoom {
  constructor(ctx, env) {
    super(ctx, env);
    this.trace = [];
  }
  async seed() {
    const now = Date.now();
    this.store.db.prepare(`INSERT INTO agent_webhook_deliveries
      (delivery_id,idempotency_key,subscription_id,agent_id,event_type,payload_json,signature,state,attempts,next_attempt_at,created_at,updated_at)
      VALUES ('fairness','fairness','missing','missing','message.posted','{}','fixture','pending',0,?,?,?)`).run(now, now, now);
    await this.ctx.storage.deleteAlarm();
  }
  syncGmailMailboxes() {
    this.trace.push('first-job');
    // A real RPC read queued while the batch is still executing. Do not await
    // it here: the scheduler, not this runner, must give that request a turn.
    this.pendingRead = this.env.ROOM.getByName('fairness').readCheckpoint();
    return { completed: 0 };
  }
  readCheckpoint() {
    this.trace.push('read');
    return [...this.trace];
  }
  drainWebhookDeliveries() {
    this.trace.push('second-job');
    return { delivered: 0 };
  }
  async result() {
    await this.pendingRead;
    return this.trace;
  }
}

export default {
  async fetch(request, env) {
    const room = env.ROOM.getByName('fairness');
    if (new URL(request.url).pathname === '/seed') {
      await room.seed();
      return Response.json({ ok: true });
    }
    await room.ensureJobAlarm();
    return Response.json(await room.result());
  }
};
