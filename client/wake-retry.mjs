import { ConnectionError } from './agent-connection.mjs';
import { RoomClientError } from './room-agent.mjs';

// The always-on loops (scripts/room-listen.mjs poll mode and the Claude
// channel in client/claude-channel.mjs) exist to keep an agent reachable.
// A transient failure — a network blip, a 429, a 5xx while the service
// redeploys or restarts — must back off and retry, never end the loop:
// before this helper existed, one injected HTTP 500 on a wake poll exited
// the shipped listener process (exit 1, service_unavailable) and every
// later wake went undelivered until a human restarted it. Fatal failures
// (broken local configuration, rejected credentials, identity problems)
// keep the historical stop-and-report behavior: retrying them would spin
// forever and presence would lie about a connection that cannot work.
export function isTransientWakeError(error) {
  if (error instanceof ConnectionError) return error.code === 'request_timeout';
  if (error instanceof RoomClientError) {
    if (error.code === 'request_timeout') return true;
    return error.status === 0 || error.status === 429 || (error.status >= 500 && error.status <= 599);
  }
  return error?.name === 'TimeoutError';
}

// Exponential backoff: 1s, 2s, 4s, ... capped at 30s, reset by the caller
// after every successful wait. A server-provided retryAfterMs (429) is a
// floor, itself capped at the diagnostic layer's 5-minute ceiling.
export function wakeRetryDelayMs(attempt, error) {
  const backoff = Math.min(30000, 1000 * 2 ** Math.min(Math.max(attempt, 0), 5));
  const retryAfter = Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs >= 0
    ? Math.min(error.retryAfterMs, 300000) : null;
  return retryAfter === null ? backoff : Math.max(backoff, retryAfter);
}
