// The onboarding gate compares a measured run with the committed baseline.
// Exactly 20% slower passes. 21% slower, or a close the baseline could reach
// and this run cannot, fails. A new close is an improvement. Ready jitter
// after one retry is inconclusive and does not fail the path.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyReady, evaluateGate } from "../scripts/onboarding-probe/gate.mjs";

const baseline = JSON.parse(readFileSync(new URL("../docs/onboarding-probe/baseline.json", import.meta.url), "utf8"));

function runs(path, body, count = 5) {
  return Array.from({ length: count }, () => ({ paths: { [path]: body } }));
}

test("a run on the baseline passes, including a run that is exactly 20% slower", () => {
  const onBaseline = evaluateGate(runs("agentDocs", {
    closeReachable: false, firstPost: { t: 770, calls: 5 }, firstClose: null, steps: [],
  }), baseline);
  assert.equal(onBaseline.pass, true);
  assert.deepEqual(onBaseline.failures, []);
  const exact = evaluateGate(runs("agentDocs", {
    closeReachable: false, firstPost: { t: 924, calls: 6 }, firstClose: null, steps: [],
  }), baseline);
  assert.equal(exact.pass, true, JSON.stringify(exact.failures));
});

test("a run 21% slower than the baseline fails", () => {
  const verdict = evaluateGate(runs("agentDocs", {
    closeReachable: false, firstPost: { t: 932, calls: 5 }, firstClose: null, steps: [],
  }), baseline);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.failures[0].reason, "slower");
  assert.equal(verdict.failures[0].path, "agentDocs");
});

test("a close the baseline could reach becomes a failure when this run cannot reach it", () => {
  const withClose = { ...baseline, paths: { ...baseline.paths, agentCode: { step: "firstClose", medianMs: 1000, calls: 4, closeReachable: true } } };
  const verdict = evaluateGate(runs("agentCode", {
    closeReachable: false, firstPost: { t: 1000, calls: 4 }, firstClose: null, steps: [],
  }), withClose);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.failures[0].reason, "unreachable");
});

test("a newly reachable close passes as an improvement", () => {
  const verdict = evaluateGate(runs("agentDocs", {
    closeReachable: true, firstPost: { t: 900, calls: 5 }, firstClose: { t: 1200, calls: 8 }, steps: [],
  }), baseline);
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.improvements, ["agentDocs"]);
});

test("ready latency past three times the baseline is inconclusive after one retry", () => {
  assert.equal(classifyReady(3000, baseline).retry, false);
  assert.equal(classifyReady(3001, baseline).retry, true);
  assert.equal(classifyReady(3001, baseline, { retried: true }).inconclusive, true);
  const verdict = evaluateGate(runs("agentDocs", {
    closeReachable: false, firstPost: { t: 5000, calls: 5 }, firstClose: null, steps: [],
  }), baseline, { inconclusive: true });
  assert.equal(verdict.pass, true);
  assert.deepEqual(verdict.inconclusive, ["ready"]);
  assert.deepEqual(verdict.failures, []);
});
