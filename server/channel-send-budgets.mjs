// Per-connection send budgets (TASKS item #41). A thin policy layer over the
// token-bucket limiter (server/token-bucket.mjs) for the
// POST /api/inbox/channel-sends path: every (channel, account, connection)
// gets its own bucket, so one noisy bot can never spend another connection's
// budget or hammer the provider into a ban. Exhaustion is an honest HTTP 429
// with a Retry-After header instead of a provider-side throttle.
//
// Config knobs, in precedence order:
//   1. Per-connection overrides: the JSON object in the
//      CHANNEL_SEND_BUDGETS env var, keyed "channel:connectionId"
//      (e.g. {"telegram:conn-9": {"perMin": 10, "burst": 5}}). The registry
//      also honors a stored connection record's `sendBudget` bag when the
//      connection contract starts carrying it (today the contract rejects
//      extra keys, so this lookup is a no-op placeholder for that slice).
//   2. Channel env knobs: TELEGRAM_SEND_BUDGET_PER_MIN /
//      TELEGRAM_SEND_BUDGET_BURST, falling back to CHANNEL_SEND_BUDGET_PER_MIN
//      / CHANNEL_SEND_BUDGET_BURST.
//   3. Defaults: 30 sends/min per Telegram bot, burst 30.
//
// Gmail: live Gmail send budgets are NOT enforced here. The Gmail send-slice
// design (task 17) is [JOHN]-gated; building Gmail send budgets waits on that
// approval. `check`/`view` for the gmail channel are documented no-ops, and
// the route layer must not call check() for gmail sends.
import { createLimiter } from "./token-bucket.mjs";
import { ServiceError } from "./store.mjs";

export const DEFAULT_SEND_BUDGET_PER_MIN = 30;
export const DEFAULT_SEND_BUDGET_BURST = 30;
// The one channel whose live budget enforcement is [JOHN]-gated (task 17).
export const GMAIL_BUDGET_PENDING_APPROVAL = true;

const number = (value, fallback) => {
  const parsed = typeof value === "string" && value.trim() ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
// Resolve { rate (tokens/sec), burst } for a channel from env. Pure, so tests
// and operators can inspect it without a registry.
export function resolveSendBudget({ channel, env = {} }) {
  if (channel === "gmail") return null; // [JOHN]-gated; see module header.
  const upper = String(channel).toUpperCase();
  const perMin = number(env[`${upper}_SEND_BUDGET_PER_MIN`], number(env.CHANNEL_SEND_BUDGET_PER_MIN, DEFAULT_SEND_BUDGET_PER_MIN));
  const burst = Math.round(number(env[`${upper}_SEND_BUDGET_BURST`], number(env.CHANNEL_SEND_BUDGET_BURST, DEFAULT_SEND_BUDGET_BURST)));
  return { rate: perMin / 60, burst: Math.max(1, burst) };
}
// Per-connection overrides from the CHANNEL_SEND_BUDGETS JSON map. Malformed
// entries are ignored (never a startup failure), so a typo degrades to the
// channel default instead of breaking sends.
export function parseConnectionBudgets(raw) {
  if (typeof raw !== "string" || !raw.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== "string" || !key || value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const perMin = Number(value.perMin ?? value.per_min ?? value.sendsPerMin);
    const burst = Number(value.burst);
    if (Number.isFinite(perMin) && perMin > 0) out[key] = { perMin, ...(Number.isFinite(burst) && burst >= 1 ? { burst: Math.round(burst) } : {}) };
  }
  return out;
}

const budgetKey = ({ channel, accountId, connectionId }) =>
  [channel, accountId, connectionId === null || connectionId === undefined ? "direct" : String(connectionId)].join(":");

// A registry of per-connection token buckets. limiterCache is bounded (LRU
// eviction) so a long-lived process cannot accumulate a limiter per stale
// connection id. now is injectable for tests.
export function createSendBudgetRegistry({ env = {}, now = () => Date.now(), connectionBudget = null, cacheSize = 512 } = {}) {
  if (typeof connectionBudget !== "function" && connectionBudget !== null)
    throw new TypeError("connectionBudget must be a function or null");
  const limiters = new Map(); // budgetKey -> { limiter, signature }
  const connectionOverrides = parseConnectionBudgets(env.CHANNEL_SEND_BUDGETS);
  const storedBudget = (channel, accountId, connectionId) => {
    try {
      const bag = connectionBudget?.(channel, accountId, connectionId);
      if (bag && typeof bag === "object" && Number.isFinite(Number(bag.perMin)) && Number(bag.perMin) > 0)
        return { perMin: Number(bag.perMin), burst: Number.isFinite(Number(bag.burst)) && Number(bag.burst) >= 1 ? Math.round(Number(bag.burst)) : undefined };
    } catch { /* a failing lookup degrades to env defaults */ }
    return null;
  };
  const configFor = (channel, accountId, connectionId) => {
    const key = `${channel}:${connectionId ?? "direct"}`;
    const override = connectionOverrides[key] ?? storedBudget(channel, accountId, connectionId);
    const base = resolveSendBudget({ channel, env });
    if (!base) return null;
    if (!override) return base;
    return { rate: override.perMin / 60, burst: Math.max(1, Math.round(override.burst ?? base.burst)) };
  };
  const limiterFor = scope => {
    const key = budgetKey(scope);
    const config = configFor(scope.channel, scope.accountId, scope.connectionId);
    if (!config) return null;
    const signature = `${config.rate}/${config.burst}`;
    const cached = limiters.get(key);
    if (cached && cached.signature === signature) { limiters.delete(key); limiters.set(key, cached); return cached.limiter; }
    const limiter = createLimiter({ rate: config.rate, burst: config.burst });
    limiters.delete(key); limiters.set(key, { limiter, signature });
    while (limiters.size > Math.max(1, cacheSize)) limiters.delete(limiters.keys().next().value);
    return limiter;
  };
  const validateScope = scope => {
    if (!scope || typeof scope !== "object" || typeof scope.channel !== "string" || !scope.channel
      || typeof scope.accountId !== "string" || !scope.accountId)
      throw new ServiceError(500, "invalid_send_budget_scope", "Send-budget scope must name a channel and account.");
  };
  // Consume one send token. Returns { remaining } on success; throws an HTTP
  // 429 ServiceError with a Retry-After header when the budget is exhausted.
  // Gmail is a no-op: live Gmail budgets wait on the task-17 approval.
  const check = (scope, { now: at } = {}) => {
    validateScope(scope);
    if (scope.channel === "gmail") return { remaining: null, pendingApproval: GMAIL_BUDGET_PENDING_APPROVAL };
    const limiter = limiterFor(scope);
    const result = limiter.tryTake(budgetKey(scope), { now: at ?? now() });
    if (!result.allowed)
      throw new ServiceError(429, "send_budget_exhausted",
        "Send budget exhausted for this connection. Wait and retry; nothing was sent.",
        { "Retry-After": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) });
    return { remaining: result.remaining };
  };
  // Non-consuming diagnostics for the channel-health card: remaining sends and
  // when the bucket refills. Returns null for channels without budgets.
  const view = (scope, { now: at } = {}) => {
    if (!scope || typeof scope !== "object" || typeof scope.channel !== "string" || !scope.channel
      || typeof scope.accountId !== "string" || !scope.accountId) return null;
    if (scope.channel === "gmail") return { pendingApproval: GMAIL_BUDGET_PENDING_APPROVAL };
    const limiter = limiterFor(scope);
    const snap = limiter.peek(budgetKey(scope), { now: at ?? now() });
    return { remaining: snap.remaining, resetsAtMs: snap.fullAtMs };
  };
  return Object.freeze({ check, view, budgetKey, resolveSendBudget, size: () => limiters.size });
}
