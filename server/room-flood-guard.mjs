// Per (room, member) budget for live chat posts and replies. One looping
// member — human or agent — cannot fill a room. The bucket is in memory and
// resets when the process or Durable Object is evicted. There are no tiers,
// no settings, and no counter.
//
// Burst 30, refill 1 post per 2 seconds. Only message.posted (a reply is
// that command with replyToId) and dm.posted spend a token. Reactions,
// edits, deletes, reads, and work or claim commands do not. System writes,
// importEvents, and projection replay never call consume. store.command
// returns an idempotent replay before consume, so that command id is free.

import { createRateLimiter } from "./identity-ratelimit.mjs";
import { ServiceError } from "./service-error.mjs";

const CHAT_COMMANDS = new Set(["message.posted", "dm.posted"]);
const AGENT_WAIT = "on 429, wait Retry-After and retry";

export function createRoomFloodGuard({ now, capacity = 30, refillPerSecond = 0.5 } = {}) {
  const limiter = createRateLimiter({ now, capacity, refillPerSecond });
  return {
    consume(roomId, memberId, commandType) {
      if (!CHAT_COMMANDS.has(commandType)) return;
      if (typeof roomId !== "string" || typeof memberId !== "string" || roomId.length === 0 || memberId.length === 0) return;
      const decision = limiter.check(`${roomId}:${memberId}`);
      if (decision.allowed) return;
      const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      const error = new ServiceError(429, "rate_limited", AGENT_WAIT, { "Retry-After": String(seconds) });
      error.retryAfterMs = decision.retryAfterMs;
      throw error;
    }
  };
}
