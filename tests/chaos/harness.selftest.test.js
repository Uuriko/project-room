// Self-tests for the chaos property harness itself (tests/chaos/).
//
// These pin the runner's contract: deterministic seeds, expected domain
// rejections counted (not failed), unexpected errors fail the property, and
// a broken model is reported with its seed and a minimal op log. Written
// first, before harness.mjs existed (fail-first): the first run failed on
// the missing module, then went green as the runner was implemented.

import test from "node:test";
import assert from "node:assert/strict";
import { Rng } from "./seeded-random.mjs";
import { runProperty, chaosConfig } from "./harness.mjs";

test("Rng: same seed replays the same stream; different seeds diverge", () => {
  const a = new Rng(12345);
  const b = new Rng(12345);
  for (let i = 0; i < 200; i++) assert.equal(a.float(), b.float(), `draw ${i} diverged`);
  assert.equal(new Rng(12345).int(1, 6), new Rng(12345).int(1, 6));
  assert.deepEqual(new Rng(77).shuffle([1, 2, 3, 4, 5]), new Rng(77).shuffle([1, 2, 3, 4, 5]));
  const other = new Rng(54321);
  let same = 0;
  const c = new Rng(12345);
  for (let i = 0; i < 20; i++) if (c.float() === other.float()) same++;
  assert.ok(same < 20, "different seeds must (overwhelmingly) diverge");
});

test("chaosConfig: smoke vs full vs env overrides", () => {
  const smoke = chaosConfig({ defaultSeeds: { smoke: 3, full: 9 }, defaultOps: { smoke: 10, full: 30 }, defaultSeedBase: 7 });
  assert.equal(smoke.mode, "smoke");
  assert.equal(smoke.seeds, 3);
  assert.equal(smoke.opsPerSeed, 10);
  assert.equal(smoke.seedBase, 7);
  assert.equal(smoke.singleSeed, null);
});

test("runProperty: a correct model passes and reports counts", async () => {
  let checks = 0;
  const summary = await runProperty({
    name: "selftest-correct",
    file: "tests/chaos/harness.selftest.test.js",
    defaultSeeds: { smoke: 3, full: 3 },
    defaultOps: { smoke: 10, full: 10 },
    defaultSeedBase: 1000,
    build: () => ({ total: 0 }),
    perform: (ctx, rng) => {
      const n = rng.int(1, 5);
      ctx.total += n;
      return `add ${n}`;
    },
    checkInvariants: ctx => {
      assert.ok(ctx.total >= 0, "total never negative");
      checks++;
    },
  });
  assert.equal(summary.seeds, 3);
  assert.equal(summary.applied, 30);
  assert.equal(summary.rejected, 0);
  assert.equal(checks, 30);
});

test("runProperty: expected domain rejections are counted, not failed", async () => {
  const domainError = () => {
    const error = new Error("nope");
    error.code = "domain_nope";
    return error;
  };
  const summary = await runProperty({
    name: "selftest-rejections",
    defaultSeeds: { smoke: 4, full: 4 },
    defaultOps: { smoke: 10, full: 10 },
    defaultSeedBase: 2000,
    build: () => ({}),
    perform: (ctx, rng) => {
      if (rng.bool(0.5)) throw domainError();
      return "ok";
    },
    checkInvariants: () => {},
  });
  assert.ok(summary.rejected > 0, "some ops should have been rejected");
  assert.ok(summary.applied > 0, "some ops should have applied");
  assert.equal(summary.applied + summary.rejected, 40);
});

test("runProperty: an unexpected error fails the property", async () => {
  await assert.rejects(
    () => runProperty({
      name: "selftest-unexpected",
      defaultSeeds: { smoke: 2, full: 2 },
      defaultOps: { smoke: 5, full: 5 },
      defaultSeedBase: 3000,
      build: () => ({}),
      perform: () => { throw new TypeError("real bug"); },
      checkInvariants: () => {},
    }),
    /selftest-unexpected.*FAILED on/
  );
});

test("runProperty: a broken model is reported with seed reproduction", async () => {
  // A ledger that mints 10 out of thin air every 7th debit. Conservation
  // must fail, and the runner must surface the failure (not swallow it).
  // The failure report is printed to stdout; the rejection proves detection.
  await assert.rejects(
    () => runProperty({
      name: "selftest-broken",
      file: "tests/chaos/harness.selftest.test.js",
      defaultSeeds: { smoke: 3, full: 3 },
      defaultOps: { smoke: 20, full: 20 },
      defaultSeedBase: 4000,
      build: () => ({ balance: 100, debits: 0 }),
      perform: ctx => {
        ctx.debits++;
        if (ctx.debits % 7 === 0) {
          ctx.balance += 10;
          return "credit-without-debit 10 (injected bug)";
        }
        return "no-op";
      },
      checkInvariants: ctx => {
        assert.equal(ctx.balance, 100, "money conserved");
      },
    }),
    /selftest-broken.*FAILED on/
  );
});

test("runProperty: teardown runs once per seed even on success", async () => {
  let tornDown = 0;
  await runProperty({
    name: "selftest-teardown",
    defaultSeeds: { smoke: 3, full: 3 },
    defaultOps: { smoke: 4, full: 4 },
    defaultSeedBase: 5000,
    build: () => ({}),
    perform: () => "ok",
    checkInvariants: () => {},
    teardown: () => { tornDown++; },
  });
  assert.equal(tornDown, 3);
});
