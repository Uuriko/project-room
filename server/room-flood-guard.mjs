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
// A token is only spent for good when the command lands: store.command runs
// consume before its remaining validation (causation, archived room, DM
// consent, the reducer), and this in-memory bucket does not roll back with
// the command's database transaction, so store.command refunds the token
// via refund() whenever the command then fails (#2951).

import { createRateLimiter } from "./identity-ratelimit.mjs";
import { ServiceError } from "./service-error.mjs";

const CHAT_COMMANDS = new Set(["message.posted", "dm.posted"]);
const AGENT_WAIT = "on 429, wait Retry-After and retry";

export function createRoomFloodGuard({ now, capacity = 30, refillPerSecond = 0.5 } = {}) {
  const limiter = createRateLimiter({ now, capacity, refillPerSecond });
  return {
    // Returns true when a token was actually spent, so the caller knows a
    // later failure needs a refund; non-chat commands and malformed keys
    // spend nothing and return false.
    consume(roomId, memberId, commandType) {
      if (!CHAT_COMMANDS.has(commandType)) return false;
      if (typeof roomId !== "string" || typeof memberId !== "string" || roomId.length === 0 || memberId.length === 0) return false;
      const decision = limiter.check(`${roomId}:${memberId}`);
      if (decision.allowed) return true;
      const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      // AUX-13 follow-up: a 429 names its bucket, like every other limiter.
      const error = new ServiceError(429, "rate_limited", AGENT_WAIT, { "Retry-After": String(seconds), "X-RateLimit-Bucket": "chat-flood" });
      error.retryAfterMs = decision.retryAfterMs;
      throw error;
    },
    // Give back a token spent by consume() for a command that did not land.
    // Same chat/key guards as consume(): anything consume ignored, refund
    // ignores too, so a refund can never mint budget for a non-chat command.
    refund(roomId, memberId, commandType) {
      if (!CHAT_COMMANDS.has(commandType)) return;
      if (typeof roomId !== "string" || typeof memberId !== "string" || roomId.length === 0 || memberId.length === 0) return;
      limiter.refund(`${roomId}:${memberId}`);
    }
  };
}
