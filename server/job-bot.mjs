// Room job bot (fixtures only) — D2 demand-side prototype for the Dasha
// Grid loop (dasha-system-synthesis-2026-09-27.md, Part 2, step 1).
//
// WHAT THIS IS: a fixtures-only build of "room agents post inference jobs
// through a room bot; providers serve them; every job settles as a signed
// receipt." The full lifecycle — post → match → execute → signed receipt —
// runs against an in-memory fixture provider registry. There is NO real
// inference here (execution is deterministic fixture arithmetic, no response
// text is produced) and NO money (budgets are reserved in *credits*, and the
// escrow mechanics stay a later Grid slice behind John's tap).
//
// WHAT THIS IS NOT: a live Grid client. It never touches a network, never
// generates text, never moves funds. The fixture registry is a stand-in for
// the bounded Mac network; the reservation ledger is a stand-in for
// post-&-lock escrow.
//
// Conventions followed:
// - Events follow the room event grammar {at, type, actorId, data}
//   (see server/access-requests.mjs, server/activity-feed.mjs).
// - Signed receipts are hash-linked and HMAC-signed, matching the settled
//   chain's schema shape (settled.chain.v0: prev_hash/hash/sig/signer) so
//   this prototype plugs into the real chain later.
// - Pure and dependency-free beyond node:crypto (time is injected).
//   Frozen outputs; malformed inputs throw JobBotError.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const RECEIPT_SCHEMA = "job.receipt.v0";
const GENESIS = "GENESIS";

class JobBotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "JobBotError";
    this.code = code;
  }
}
export { JobBotError };
const fail = (code, message) => { throw new JobBotError(code, message); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };

// Canonical encoding: base64url of JSON with sorted keys (same convention
// as server/signed-claims.mjs).
const encode = obj => {
  const sorted = Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]]));
  return Buffer.from(JSON.stringify(sorted)).toString("base64url");
};

// Rough fixture tokenization: ~4 chars per token. Deterministic, not real.
const charsPerToken = 4;
const estimateTokensIn = prompt => Math.max(1, Math.ceil(prompt.length / charsPerToken));

export function createJobBot({
  secret,
  signer = "job-bot-fixture",
  botActorId = "job-bot",
  now = () => Date.now(),
  randomId = () => `id_${createHash("sha256").update(String(Math.random())).digest("base64url").slice(0, 12)}`,
} = {}) {
  check(typeof secret === "string" && secret.length >= 32, "config",
    "secret must be a ≥32-char signing secret");
  check(typeof now === "function", "config", "now must be a function");
  check(typeof randomId === "function", "config", "randomId must be a function");

  const providers = new Map();   // providerId -> fixture record
  const jobs = new Map();        // jobId -> job record
  const receipts = new Map();    // receiptId -> receipt
  const eventLog = [];
  let chainHead = GENESIS;       // hash-linked receipt chain head

  const emit = (type, actorId, data) => {
    const event = Object.freeze({ at: now(), type, actorId,
      data: Object.freeze({ ...data }) });
    eventLog.push(event);
    return event;
  };

  const hashBody = body =>
    createHash("sha256").update(encode(body)).digest("hex");
  const signHash = hashHex =>
    createHmac("sha256", secret).update(Buffer.from(hashHex, "hex")).digest("base64url");

  // Register a fixture provider. failNext / alwaysFail are the failure
  // fixtures: when a fixture fails, executeJob produces a signed ERROR
  // receipt and never a success receipt.
  function registerProvider({
    providerId, models, tokPerSec, pricePer1kCredits,
    failNext = false, alwaysFail = false,
  }) {
    check(typeof providerId === "string" && providerId.length > 0, "invalid_provider",
      "providerId must be a non-empty string");
    check(Array.isArray(models) && models.length > 0 && models.every(m => typeof m === "string" && m.length > 0),
      "invalid_provider", "models must be a non-empty array of model names");
    check(typeof tokPerSec === "number" && tokPerSec > 0, "invalid_provider",
      "tokPerSec must be a positive number");
    check(typeof pricePer1kCredits === "number" && pricePer1kCredits > 0, "invalid_provider",
      "pricePer1kCredits must be a positive number");
    const record = Object.freeze({ providerId, models: Object.freeze([...models]),
      tokPerSec, pricePer1kCredits, failNext: Boolean(failNext), alwaysFail: Boolean(alwaysFail) });
    providers.set(providerId, record);
    emit("job-provider.registered", botActorId, { providerId, models, tokPerSec, pricePer1kCredits });
    return record;
  }

  // Post a job. maxBudgetCredits is RESERVED (post-&-lock shape): no listing
  // is ever visible beyond a reserved budget, and settleJob releases the
  // unused remainder. This is a ledger of credits, not money.
  function postJob({ buyerId, prompt, modelHint = null, maxBudgetCredits }) {
    check(typeof buyerId === "string" && buyerId.length > 0, "invalid_job",
      "buyerId must be a non-empty string");
    check(typeof prompt === "string" && prompt.length > 0, "invalid_job",
      "prompt must be a non-empty string");
    check(modelHint === null || (typeof modelHint === "string" && modelHint.length > 0),
      "invalid_job", "modelHint must be null or a non-empty string");
    check(typeof maxBudgetCredits === "number" && maxBudgetCredits > 0, "invalid_job",
      "maxBudgetCredits must be a positive number");
    const jobId = `job_${randomId()}`;
    const tokensIn = estimateTokensIn(prompt);
    const job = {
      jobId, buyerId, prompt, modelHint, maxBudgetCredits,
      reservedCredits: maxBudgetCredits, tokensIn,
      status: "posted", providerId: null, estimate: null, at: now(),
    };
    jobs.set(jobId, job);
    emit("job.posted", buyerId, { jobId, modelHint, maxBudgetCredits, tokensIn,
      reservedCredits: job.reservedCredits });
    return Object.freeze({ ...job });
  }

  // Match a posted job to the cheapest eligible fixture provider. Eligible =
  // serves the model hint (or any provider when no hint) and the estimated
  // cost fits the reserved budget. Nothing is listed beyond the reservation.
  function matchJob(jobId) {
    const job = jobs.get(jobId);
    check(job, "unknown_job", `unknown job ${jobId}`);
    check(job.status === "posted", "bad_job_state",
      `job ${jobId} is ${job.status}; matchJob requires a posted job`);
    let best = null;
    for (const p of providers.values()) {
      if (job.modelHint && !p.models.includes(job.modelHint)) continue;
      // Fixture output estimate: completion ≈ prompt/2, floored by the job's tokensIn.
      const tokensOut = Math.max(8, Math.floor(job.tokensIn / 2));
      const cost = ((job.tokensIn + tokensOut) / 1000) * p.pricePer1kCredits;
      if (cost > job.reservedCredits) continue;
      if (!best || cost < best.cost) best = { provider: p, tokensOut, cost };
    }
    if (!best) {
      job.status = "unmatched";
      emit("job.unmatched", botActorId, { jobId,
        reason: "no eligible fixture provider within budget" });
      fail("no_match", `no fixture provider can serve job ${jobId} within budget`);
    }
    job.status = "matched";
    job.providerId = best.provider.providerId;
    job.estimate = Object.freeze({ tokensIn: job.tokensIn, tokensOut: best.tokensOut,
      costCredits: best.cost,
      durationMs: Math.round(((job.tokensIn + best.tokensOut) / best.provider.tokPerSec) * 1000) });
    emit("job.matched", botActorId, { jobId, providerId: job.providerId,
      estimate: { ...job.estimate } });
    return Object.freeze({ jobId, providerId: job.providerId,
      estimate: { ...job.estimate } });
  }

  // Execute a matched job against the fixture provider. No real inference:
  // usage is deterministic fixture arithmetic. A failing fixture yields a
  // signed ERROR receipt — never a phantom success.
  function executeJob(jobId) {
    const job = jobs.get(jobId);
    check(job, "unknown_job", `unknown job ${jobId}`);
    check(job.status === "matched", "bad_job_state",
      `job ${jobId} is ${job.status}; executeJob requires a matched job`);
    const provider = providers.get(job.providerId);
    check(provider, "provider_gone", `fixture provider ${job.providerId} is no longer registered`);
    const shouldFail = provider.alwaysFail || provider.failNext;
    if (provider.failNext) providers.set(provider.providerId,
      Object.freeze({ ...provider, failNext: false }));
    const settledAt = now();
    if (shouldFail) {
      job.status = "failed";
      job.reservedCredits = job.maxBudgetCredits; // release the full reservation: nothing was spent
      const receipt = issueReceipt({ job, provider, status: "error",
        tokensOut: 0, durationMs: 0, costCredits: 0,
        errorCode: "fixture_provider_failed", settledAt });
      emit("job.failed", botActorId, { jobId, providerId: provider.providerId,
        receiptId: receipt.id, errorCode: "fixture_provider_failed" });
      return Object.freeze({ status: "failed", receipt });
    }
    const costCredits = job.estimate.costCredits;
    job.status = "settled";
    job.reservedCredits = job.maxBudgetCredits - costCredits; // release remainder
    const receipt = issueReceipt({ job, provider, status: "ok",
      tokensOut: job.estimate.tokensOut, durationMs: job.estimate.durationMs,
      costCredits, settledAt });
    emit("job.settled", botActorId, { jobId, providerId: provider.providerId,
      receiptId: receipt.id, costCredits });
    return Object.freeze({ status: "settled", receipt });
  }

  // Sign a receipt into the hash-linked chain. Error receipts carry zero
  // usage and an errorCode; success receipts carry the fixture usage.
  function issueReceipt({ job, provider, status, tokensOut, durationMs, costCredits, errorCode = null, settledAt }) {
    const body = {
      schema: RECEIPT_SCHEMA,
      id: `rcp_${randomId()}`,
      jobId: job.jobId,
      buyerId: job.buyerId,
      providerId: provider.providerId,
      model: job.modelHint ?? provider.models[0],
      tokensIn: job.tokensIn,
      tokensOut,
      durationMs,
      credits: costCredits,
      status,
      errorCode,
      at: settledAt,
      prevHash: chainHead,
      signer,
    };
    const hash = hashBody(body);
    const sig = signHash(hash);
    const receipt = Object.freeze({ ...body, hash, sig });
    chainHead = hash;
    receipts.set(receipt.id, receipt);
    return receipt;
  }

  // Verify a receipt: schema, hash integrity over the canonical body, and
  // signature against the bot's secret.
  function verifyReceipt(receipt) {
    if (!receipt || typeof receipt !== "object") return false;
    if (receipt.schema !== RECEIPT_SCHEMA) return false;
    const { hash, sig, ...body } = receipt;
    if (typeof hash !== "string" || typeof sig !== "string") return false;
    let expectedHash;
    try { expectedHash = hashBody(body); } catch { return false; }
    if (expectedHash !== hash) return false;
    const expectedSig = signHash(hash);
    const a = Buffer.from(sig, "base64url");
    const b = Buffer.from(expectedSig, "base64url");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function getJob(jobId) {
    const job = jobs.get(jobId);
    check(job, "unknown_job", `unknown job ${jobId}`);
    return Object.freeze({ ...job, estimate: job.estimate ? { ...job.estimate } : null });
  }
  function getReceipt(receiptId) {
    const receipt = receipts.get(receiptId);
    check(receipt, "unknown_receipt", `unknown receipt ${receiptId}`);
    return receipt;
  }

  return Object.freeze({
    registerProvider,
    postJob,
    matchJob,
    executeJob,
    verifyReceipt,
    getJob,
    getReceipt,
    providers: () => Object.freeze([...providers.values()]),
    events: () => Object.freeze([...eventLog]),
    chainHead: () => chainHead,
    actorId: botActorId,
  });
}
