// Per (room, member) budget for chat posts. One looping member — human or
// agent — cannot fill a room. The bucket is in memory and resets when the
// process or Durable Object is evicted. There are no tiers and no settings.
//
// Burst 30, refill 1 post per 2 seconds. Replays must not call consume:
// store.command returns the prior receipt before this runs.

import { createRateLimiter } from "./identity-ratelimit.mjs";
import { ServiceError } from "./service-error.mjs";

const CHAT_COMMANDS = new Set(["message.posted", "dm.posted"]);

export function createRoomFloodGuard({ now, capacity = 30, refillPerSecond = 0.5 } = {}) {
  const limiter = createRateLimiter({ now, capacity, refillPerSecond });
  return {
    consume(roomId, memberId, commandType) {
      if (!CHAT_COMMANDS.has(commandType)) return;
      if (typeof roomId !== "string" || typeof memberId !== "string" || roomId.length === 0 || memberId.length === 0) return;
      const decision = limiter.check(`${roomId}:${memberId}`);
      if (decision.allowed) return;
      const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      const error = new ServiceError(
        429,
        "rate_limited",
        `This member is posting faster than the room allows; retry after ${seconds} s`,
        { "Retry-After": String(seconds) }
      );
      error.retryAfterMs = decision.retryAfterMs;
      throw error;
    }
  };
}
