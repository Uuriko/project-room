// Tests for server/job-bot.mjs — the fixtures-only room job bot.
//
// Authoring-gate notes (repo .agents/skills/test-audit/SKILL.md):
// - server/job-bot.mjs is NEW: there is no existing coverage to extend, so
//   every contract here gets its primary test at this boundary.
// - Each test below names the observable contract it protects and the
//   credible regression it would catch.
// - No test-only production seams: the bot's factory already injects `now`
//   and `randomId` for production (signed-claims.mjs uses the same time-
//   injection convention); the tests only feed those seams, not new ones.
// - Junk patterns avoided: no mocks implementing the asserted behavior, no
//   expected values computed by the module under test, no string greps of
//   source.
import test from "node:test";
import assert from "node:assert/strict";
import { createJobBot, JobBotError, RECEIPT_SCHEMA } from "../server/job-bot.mjs";

// Deterministic harness: fixed clock + predictable ids.
const setup = (overrides = {}) => {
  let t = 1788830423207;
  let n = 0;
  const bot = createJobBot({
    secret: "a".repeat(32),
    signer: "fixture-signer",
    now: () => t,
    randomId: () => `test${++n}`,
    ...overrides,
  });
  return { bot, tick: (ms = 1000) => { t += ms; } };
};
const registerFast = bot => bot.registerProvider({
  providerId: "fixture-m4", models: ["dasha-27b"], tokPerSec: 40,
  pricePer1kCredits: 5,
});

test("postJob validates its inputs (contract: bad jobs never enter the lifecycle)", () => {
  // Credible regression: an empty prompt or zero budget silently posting
  // would let a no-work job match and settle.
  const { bot } = setup();
  assert.throws(() => bot.postJob({ buyerId: "a1", prompt: "", maxBudgetCredits: 10 }),
    err => err instanceof JobBotError && err.code === "invalid_job");
  assert.throws(() => bot.postJob({ buyerId: "a1", prompt: "hi", maxBudgetCredits: 0 }),
    err => err instanceof JobBotError && err.code === "invalid_job");
  assert.throws(() => bot.postJob({ buyerId: "", prompt: "hi", maxBudgetCredits: 10 }),
    err => err instanceof JobBotError && err.code === "invalid_job");
});

test("full lifecycle: post -> match -> execute -> signed receipt verifies (contract: the D2 loop settles)", () => {
  // Credible regression: any break in the post/match/execute/settle chain
  // (e.g. matchJob forgetting to set providerId) breaks the demand path.
  const { bot } = setup();
  registerFast(bot);
  const job = bot.postJob({ buyerId: "agent-instinct", prompt: "summarize this receipt chain", modelHint: "dasha-27b", maxBudgetCredits: 50 });
  assert.equal(job.status, "posted");
  assert.equal(job.reservedCredits, 50);
  const match = bot.matchJob(job.jobId);
  assert.equal(match.providerId, "fixture-m4");
  const result = bot.executeJob(job.jobId);
  assert.equal(result.status, "settled");
  const r = result.receipt;
  assert.equal(r.schema, RECEIPT_SCHEMA);
  assert.equal(r.jobId, job.jobId);
  assert.equal(r.providerId, "fixture-m4");
  assert.equal(r.buyerId, "agent-instinct");
  assert.equal(r.status, "ok");
  assert.ok(r.tokensIn > 0 && r.tokensOut > 0);
  assert.ok(r.durationMs > 0);
  assert.ok(r.credits > 0 && r.credits <= 50, "cost never exceeds the reserved budget");
  assert.ok(r.prevHash && r.hash && r.sig);
  assert.ok(bot.verifyReceipt(r), "receipt verifies against the bot secret");
  // The unused budget remainder is released, not kept locked.
  const settled = bot.getJob(job.jobId);
  assert.ok(settled.reservedCredits < 50);
});

test("receipt verification rejects tampering and wrong secrets (contract: receipts are unforgable)", () => {
  // Credible regression: signature computed over the wrong canonical bytes
  // would let a forged receipt pass, breaking settlement trust.
  const { bot } = setup();
  registerFast(bot);
  const job = bot.postJob({ buyerId: "a1", prompt: "x".repeat(40), maxBudgetCredits: 50 });
  bot.matchJob(job.jobId);
  const { receipt } = bot.executeJob(job.jobId);
  assert.ok(bot.verifyReceipt(receipt));
  assert.equal(bot.verifyReceipt({ ...receipt, credits: receipt.credits + 1 }), false,
    "tampered field must fail verification");
  assert.equal(bot.verifyReceipt({ ...receipt, sig: "AAAA" }), false,
    "tampered signature must fail verification");
  assert.equal(bot.verifyReceipt({ jobId: job.jobId }), false,
    "incomplete object is not a receipt");
  const { bot: other } = setup({ secret: "b".repeat(32) });
  assert.equal(other.verifyReceipt(receipt), false,
    "receipt does not verify under a different bot secret");
});

test("receipts are hash-linked in settlement order (contract: the chain is append-only)", () => {
  // Credible regression: a receipt minted without chaining prevHash would
  // fork the settlement history the chain relies on for ordering.
  const { bot } = setup();
  registerFast(bot);
  const mk = prompt => {
    const j = bot.postJob({ buyerId: "a1", prompt, maxBudgetCredits: 50 });
    bot.matchJob(j.jobId);
    return bot.executeJob(j.jobId).receipt;
  };
  const r1 = mk("first job");
  const r2 = mk("second job");
  assert.equal(r1.prevHash, "GENESIS");
  assert.equal(r2.prevHash, r1.hash);
  assert.equal(bot.chainHead(), r2.hash);
});

test("matchJob refuses jobs no fixture can serve (contract: no budget, no listing)", () => {
  // Credible regression: matching the cheapest provider regardless of the
  // budget would violate post-&-lock (a job visible beyond its reservation).
  const { bot } = setup();
  registerFast(bot);
  const job = bot.postJob({ buyerId: "a1", prompt: "x".repeat(400), modelHint: "unknown-model", maxBudgetCredits: 50 });
  assert.throws(() => bot.matchJob(job.jobId),
    err => err instanceof JobBotError && err.code === "no_match");
  assert.equal(bot.getJob(job.jobId).status, "unmatched");
  const events = bot.events().filter(e => e.type === "job.unmatched");
  assert.equal(events.length, 1, "unmatched jobs emit a room-grammar event");
});

test("matchJob picks the cheapest eligible provider and respects the model hint (contract: fair matching)", () => {
  // Credible regression: a greedy first-fit match could route work to an
  // expensive provider or to one that does not serve the requested model.
  const { bot } = setup();
  bot.registerProvider({ providerId: "expensive", models: ["dasha-27b"], tokPerSec: 40, pricePer1kCredits: 50 });
  bot.registerProvider({ providerId: "cheap", models: ["dasha-27b"], tokPerSec: 40, pricePer1kCredits: 2 });
  bot.registerProvider({ providerId: "wrong-model", models: ["other-70b"], tokPerSec: 1000, pricePer1kCredits: 1 });
  const job = bot.postJob({ buyerId: "a1", prompt: "x".repeat(100), modelHint: "dasha-27b", maxBudgetCredits: 50 });
  const match = bot.matchJob(job.jobId);
  assert.equal(match.providerId, "cheap");
});

test("a failing fixture provider yields a signed ERROR receipt and never a success (contract: no phantom settlements)", () => {
  // Credible regression: swallowing a provider failure as success would
  // mint payment-grade receipts for work never done — the core trust break.
  const { bot } = setup();
  bot.registerProvider({ providerId: "flaky", models: ["dasha-27b"], tokPerSec: 40,
    pricePer1kCredits: 5, failNext: true });
  const job = bot.postJob({ buyerId: "a1", prompt: "x".repeat(40), maxBudgetCredits: 50 });
  bot.matchJob(job.jobId);
  const result = bot.executeJob(job.jobId);
  assert.equal(result.status, "failed");
  const r = result.receipt;
  assert.equal(r.status, "error");
  assert.equal(r.errorCode, "fixture_provider_failed");
  assert.equal(r.tokensOut, 0);
  assert.equal(r.credits, 0);
  assert.ok(bot.verifyReceipt(r), "error receipts are signed too (auditable failures)");
  assert.equal(bot.getJob(job.jobId).status, "failed");
  // The next job on the same provider recovers: failNext fired exactly once.
  const job2 = bot.postJob({ buyerId: "a1", prompt: "x".repeat(40), maxBudgetCredits: 50 });
  bot.matchJob(job2.jobId);
  const ok = bot.executeJob(job2.jobId);
  assert.equal(ok.status, "settled");
});

test("alwaysFail fixture providers never settle (contract: persistent failures stay errors)", () => {
  // Credible regression: retrying past a dead provider and eventually
  // succeeding would misattribute a settlement to a dead fixture.
  const { bot } = setup();
  bot.registerProvider({ providerId: "dead", models: ["dasha-27b"], tokPerSec: 40,
    pricePer1kCredits: 5, alwaysFail: true });
  for (const prompt of ["one", "two"]) {
    const job = bot.postJob({ buyerId: "a1", prompt, maxBudgetCredits: 50 });
    bot.matchJob(job.jobId);
    const result = bot.executeJob(job.jobId);
    assert.equal(result.status, "failed");
    assert.equal(result.receipt.status, "error");
  }
});

test("lifecycle ordering is enforced (contract: no skipping match/execute steps)", () => {
  // Credible regression: executeJob accepting a merely-posted job would let
  // a job settle with no provider and no cost estimate.
  const { bot } = setup();
  registerFast(bot);
  const job = bot.postJob({ buyerId: "a1", prompt: "x".repeat(40), maxBudgetCredits: 50 });
  assert.throws(() => bot.executeJob(job.jobId),
    err => err instanceof JobBotError && err.code === "bad_job_state");
  assert.throws(() => bot.matchJob("job_nope"),
    err => err instanceof JobBotError && err.code === "unknown_job");
  bot.matchJob(job.jobId);
  bot.executeJob(job.jobId);
  assert.throws(() => bot.executeJob(job.jobId),
    err => err instanceof JobBotError && err.code === "bad_job_state",
    "double execution is refused — no double settlement");
});

test("bot events follow the room event grammar {at, type, actorId, data} (contract: room-compatible journaling)", () => {
  // Credible regression: a non-conforming event shape breaks consumers that
  // index the room event stream.
  const { bot, tick } = setup();
  tick(5000);
  registerFast(bot);
  const job = bot.postJob({ buyerId: "agent-x", prompt: "hello", maxBudgetCredits: 50 });
  bot.matchJob(job.jobId);
  bot.executeJob(job.jobId);
  const types = bot.events().map(e => e.type);
  assert.deepEqual(types, [
    "job-provider.registered", "job.posted", "job.matched", "job.settled",
  ]);
  for (const event of bot.events()) {
    assert.ok(Number.isInteger(event.at), "at is a timestamp");
    assert.ok(typeof event.type === "string" && event.type.length > 0);
    assert.ok(typeof event.actorId === "string" && event.actorId.length > 0);
    assert.ok(event.data && typeof event.data === "object");
    assert.ok(Object.isFrozen(event), "events are frozen");
  }
  assert.equal(bot.events()[1].actorId, "agent-x", "posted events carry the buyer as actor");
});
