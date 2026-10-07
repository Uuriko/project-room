// Idempotency + replay-attack harness tests (200-hard-tasks #3).
// Contract guarded: the same payout intent executes EXACTLY once no matter
// how many times it is submitted — concurrent replays, reorged chain events,
// client retries — and every replay gets the identical cached result.
// Credible regression: if begin() ever let a second in_progress through, a
// replayed payout intent would double-pay; the concurrent-replay test pins
// the single-execution guarantee.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveKey,
  deriveEventKey,
  validateKey,
  createDedupStore,
  executeOnce,
  IdempotencyError,
} from "../server/idempotency.mjs";

const tick = () => new Promise((r) => setImmediate(r));

describe("idempotency keys", () => {
  it("derives deterministic keys: same params, same key", () => {
    const a = deriveKey({ scope: "payout", params: { jobId: "j1", amountRaw: "50000", chainId: "c" } });
    const b = deriveKey({ scope: "payout", params: { chainId: "c", amountRaw: "50000", jobId: "j1" } });
    assert.equal(a, b);
    assert.match(a, /^idem_v1_payout_[0-9a-f]{32}$/);
    assert.ok(validateKey(a));
  });

  it("different params or scopes give different keys", () => {
    const a = deriveKey({ scope: "payout", params: { jobId: "j1" } });
    const b = deriveKey({ scope: "payout", params: { jobId: "j2" } });
    const c = deriveKey({ scope: "refund", params: { jobId: "j1" } });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  it("rejects malformed keys and bad scopes", () => {
    assert.equal(validateKey("nope"), false);
    assert.equal(validateKey("idem_v1_payout_short"), false);
    assert.throws(() => deriveKey({ scope: "PAYOUT", params: {} }), /scope must be/);
    assert.throws(() => deriveKey({ scope: "payout" }), /params object required/);
  });

  it("derives stable chain-event keys (reorg reinclusion dedupes)", () => {
    const a = deriveEventKey({ chainId: "monad", txHash: "0xabc", logIndex: 3 });
    const b = deriveEventKey({ chainId: "monad", txHash: "0xabc", logIndex: 3 });
    assert.equal(a, b);
    assert.throws(() => deriveEventKey({ chainId: "m", txHash: "0x", logIndex: -1 }), /logIndex/);
  });
});

describe("replay-attack harness", () => {
  it("10 concurrent replays of one payout intent execute exactly once", async () => {
    const store = createDedupStore();
    const key = deriveKey({ scope: "payout", params: { jobId: "job-r1", amountRaw: "50000" } });
    let executions = 0;
    const payout = async () => {
      executions++;
      await tick();
      await tick();
      return { tx: "0xpayout1" };
    };
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => executeOnce(store, key, payout)));
    const fulfilled = attempts.filter((a) => a.status === "fulfilled");
    const conflicts = attempts.filter((a) => a.status === "rejected" && a.reason.code === "IDEM_CONFLICT");
    assert.equal(executions, 1, `payout executed ${executions} times`);
    assert.equal(fulfilled.length + conflicts.length, 10);
    assert.ok(conflicts.length >= 9, `expected >=9 conflicts, got ${conflicts.length}`);
    assert.equal(fulfilled.length, 1);
    assert.deepEqual(fulfilled[0].value.result, { tx: "0xpayout1" });
  });

  it("a retry after completion gets the cached result (replayed: true)", async () => {
    const store = createDedupStore();
    const key = deriveKey({ scope: "payout", params: { jobId: "job-r2" } });
    let executions = 0;
    const first = await executeOnce(store, key, async () => {
      executions++;
      return { tx: "0xone" };
    });
    assert.equal(first.replayed, false);
    const second = await executeOnce(store, key, async () => {
      executions++;
      return { tx: "0xtwo" };
    });
    assert.equal(second.replayed, true);
    assert.deepEqual(second.result, { tx: "0xone" });
    assert.equal(executions, 1);
  });

  it("a failed attempt is retryable; a new attempt runs", async () => {
    const store = createDedupStore();
    const key = deriveKey({ scope: "payout", params: { jobId: "job-r3" } });
    let executions = 0;
    await assert.rejects(
      executeOnce(store, key, async () => {
        executions++;
        throw new Error("chain hiccup");
      }),
      /chain hiccup/
    );
    const retry = await executeOnce(store, key, async () => {
      executions++;
      return { tx: "0xrecovered" };
    });
    assert.equal(retry.replayed, false);
    assert.equal(executions, 2);
  });

  it("reorg simulation: re-included chain event + same intent = one payout", async () => {
    const store = createDedupStore();
    let payouts = 0;
    const processChainEvent = async ({ chainId, txHash, logIndex, jobId, amountRaw }) => {
      // Level 1: dedupe the chain event itself.
      const eventKey = deriveEventKey({ chainId, txHash, logIndex });
      const seen = await executeOnce(store, eventKey, async () => ({ processed: true }));
      if (seen.replayed) return { ...seen, payoutReplayed: true };
      // Level 2: the payout intent — exactly once per job.
      const intentKey = deriveKey({ scope: "payout", params: { jobId, amountRaw, chainId } });
      const payout = await executeOnce(store, intentKey, async () => {
        payouts++;
        return { tx: `0xpay-${jobId}` };
      });
      return { ...payout, payoutReplayed: payout.replayed };
    };
    const event = { chainId: "monad", txHash: "0xabc", logIndex: 3, jobId: "job-reorg", amountRaw: "50000" };
    const first = await processChainEvent(event); // original inclusion
    assert.equal(payouts, 1);
    const reorged = await processChainEvent(event); // reorg: same event re-included
    assert.equal(reorged.payoutReplayed === true || reorged.replayed === true, true);
    assert.equal(payouts, 1, `double payout on reorg: ${payouts}`);
    // A DIFFERENT tx for the same job (replacement tx) still pays only once.
    const replacement = await processChainEvent({ ...event, txHash: "0xdef", logIndex: 7 });
    assert.equal(replacement.payoutReplayed, true);
    assert.equal(payouts, 1);
  });

  it("refund is a separate intent from payout (not a replay)", async () => {
    const store = createDedupStore();
    let payouts = 0, refunds = 0;
    const payoutKey = deriveKey({ scope: "payout", params: { jobId: "job-r4", amountRaw: "50000" } });
    const refundKey = deriveKey({ scope: "refund", params: { jobId: "job-r4", amountRaw: "50000" } });
    await executeOnce(store, payoutKey, async () => {
      payouts++;
      return { tx: "0xpay" };
    });
    const refund = await executeOnce(store, refundKey, async () => {
      refunds++;
      return { tx: "0xrefund" };
    });
    assert.equal(refund.replayed, false);
    assert.equal(payouts, 1);
    assert.equal(refunds, 1);
  });

  it("expired keys are forgotten and re-executable", async () => {
    let now = 1_000_000;
    const store = createDedupStore({ ttlMs: 1000, clock: () => now });
    const key = deriveKey({ scope: "payout", params: { jobId: "job-r5" } });
    let executions = 0;
    await executeOnce(store, key, async () => {
      executions++;
      return { tx: "0xa" };
    });
    now += 2000; // past TTL
    const again = await executeOnce(store, key, async () => {
      executions++;
      return { tx: "0xb" };
    });
    assert.equal(again.replayed, false);
    assert.equal(executions, 2);
  });

  it("malformed keys fail closed with a coded error", async () => {
    const store = createDedupStore();
    await assert.rejects(executeOnce(store, "bogus", async () => ({})), (e) => e instanceof IdempotencyError && e.code === "IDEM_BAD_KEY");
  });
});
