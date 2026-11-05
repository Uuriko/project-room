// Wake-loop guard: a per-(agent, room) token bucket on instant wakes.
//
// enqueueWake coalesces per message, but two agents that mention each other
// on every reply still mint a new message, and so a new instant wake, each
// turn. The bucket bounds how often one agent can be instantly woken in one
// room. It never drops a signal: an over-budget signal stays in the durable
// queue and is delivered on the agent's next heartbeat or poll. Only the
// immediate release of a waiting poll is skipped.
//
// State is in memory on the AgentHeartbeats instance (single writer per
// store). A restart refills buckets, which errs toward waking.
export const wakeBucketLimits = Object.freeze({ capacity: 20, refillPerMinute: 6, maxKeys: 10000 });

export class WakeBucket {
  constructor(now, limits = wakeBucketLimits) {
    this.now = now; this.limits = limits; this.buckets = new Map();
  }
  // Spend one token for (agentId, roomId). Returns true when the instant
  // wake may fire, false when the bucket is empty.
  take(agentId, roomId) {
    const key = `${agentId}\u0000${roomId ?? ""}`;
    const at = this.now();
    const { capacity, refillPerMinute, maxKeys } = this.limits;
    const prior = this.buckets.get(key);
    const tokens = prior ? Math.min(capacity, prior.tokens + (Math.max(0, at - prior.at) * refillPerMinute) / 60000) : capacity;
    this.buckets.delete(key);
    const ok = tokens >= 1;
    this.buckets.set(key, { tokens: ok ? tokens - 1 : tokens, at });
    if (this.buckets.size > maxKeys) this.buckets.delete(this.buckets.keys().next().value);
    return ok;
  }
}
