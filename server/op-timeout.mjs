// FIX-57: server-side per-operation timeouts with deterministic outcomes.
//
// The mutating work-claim ops (create/claim/update/renew/release) each run
// under a bounded server-side deadline. The deadline is env-tunable with a
// sane default; on expiry the caller gets a deterministic outcome code
// (applied / not-applied / already-applied-idempotent) — never "hung,
// unknown". Determinism comes from pairing the deadline with the
// requestId outcome journal (server/request-dedupe.mjs): a timed-out op is
// re-driven with the same requestId and the server returns the recorded
// outcome instead of double-applying.
//
// stdlib only. No imports.
export const OP_TIMEOUT_OPS = Object.freeze(["create", "claim", "update", "renew", "release"]);

// Sane default: a healthy op is milliseconds; 10s bounds pathological stalls
// (AQ-HI-03: a 136s release) without false-firing on loaded machines.
export const DEFAULT_OP_TIMEOUT_MS = 10_000;
// Upper clamp: "bounded" must stay honest — no op may wait longer than this.
export const MAX_OP_TIMEOUT_MS = 300_000;

const isOp = op => OP_TIMEOUT_OPS.includes(op);

const parseMs = raw => {
  const ms = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

/**
 * Deadline in ms for a mutating work-claim op.
 * Precedence: WORK_CLAIM_OP_TIMEOUT_<OP>_MS (per-op) >
 * WORK_CLAIM_OP_TIMEOUT_MS (global) > DEFAULT_OP_TIMEOUT_MS.
 * Invalid values fall back down the chain; everything clamps to
 * MAX_OP_TIMEOUT_MS. Throws on an unknown op. Never throws on env input.
 */
export function opTimeoutMs(op, env = process.env) {
  if (!isOp(op)) throw new Error(`op-timeout: unknown op ${JSON.stringify(op)}`);
  const perOp = parseMs(env?.[`WORK_CLAIM_OP_TIMEOUT_${op.toUpperCase()}_MS`]);
  const global = parseMs(env?.WORK_CLAIM_OP_TIMEOUT_MS);
  const ms = perOp ?? global ?? DEFAULT_OP_TIMEOUT_MS;
  return Math.min(ms, MAX_OP_TIMEOUT_MS);
}

export class OpTimeoutError extends Error {
  constructor(op, timeoutMs, elapsedMs) {
    super(`work-claim ${op} exceeded its ${timeoutMs}ms server-side deadline`);
    this.name = "OpTimeoutError";
    this.code = "op_timeout";
    this.op = op;
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * Run fn() under a per-op deadline. Resolves { value, elapsedMs } when fn
 * settles first; rejects with OpTimeoutError when the deadline fires first.
 * A synchronous throw from fn passes through untouched (it is a business
 * outcome, not a timeout). The losing side of the race can never surface
 * as an unhandled rejection.
 */
export async function withOpDeadline(op, fn, { timeoutMs = opTimeoutMs(op) } = {}) {
  const startedAt = Date.now();
  let timer = null;
  const pending = Promise.resolve().then(fn);
  // If the deadline wins and fn later rejects, that rejection is observed
  // here so it never becomes an unhandled rejection.
  pending.catch(() => {});
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new OpTimeoutError(op, timeoutMs, Date.now() - startedAt));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    const value = await Promise.race([pending, expired]);
    return { value, elapsedMs: Date.now() - startedAt };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
