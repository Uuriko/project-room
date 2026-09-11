import test from "node:test";
import assert from "node:assert/strict";
import { parseTapSummary, suiteLabel, candidateState, liveState, buildManifest } from "../scripts/release-evidence.mjs";

const tapClean = "TAP version 13\n# tests 5\n# pass 5\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
const tapSkipped = "TAP version 13\n# tests 5\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n";
const tapFailed = "TAP version 13\n# tests 5\n# pass 4\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n";
const specClean = "ℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n";

test("parseTapSummary reads tap reporter counts", () => {
  assert.deepEqual(parseTapSummary(tapClean), { tests: 5, pass: 5, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
});

test("parseTapSummary reads spec reporter counts", () => {
  assert.deepEqual(parseTapSummary(specClean).pass, 3);
});

test("skipped tests can never be labeled passed", () => {
  assert.equal(suiteLabel(parseTapSummary(tapSkipped)), "passed-with-skips");
  assert.equal(suiteLabel({ tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 1 }), "passed-with-skips");
});

test("failures and cancellations label failed", () => {
  assert.equal(suiteLabel(parseTapSummary(tapFailed)), "failed");
  assert.equal(suiteLabel({ tests: 1, pass: 0, fail: 0, cancelled: 1, skipped: 0, todo: 0 }), "failed");
});

test("a suite with zero tests is incomplete, never passed", () => {
  assert.equal(suiteLabel({ tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 }), "incomplete");
});

test("dirty candidate tree can never be labeled clean", () => {
  assert.equal(candidateState(""), "clean");
  assert.equal(candidateState(" M server/http.mjs\n"), "dirty");
});

test("live state requires probe evidence", () => {
  assert.equal(liveState(undefined), "unverified");
  assert.equal(liveState([]), "unverified");
  assert.equal(liveState([{ url: "https://x/", status: 404 }]), "mismatch");
  assert.equal(liveState([{ url: "https://x/", status: 200, expectedSha256: "a", actualSha256: "b" }]), "mismatch");
  assert.equal(liveState([{ url: "https://x/", status: 200, expectedSha256: "a", actualSha256: "a" }]), "live");
  assert.equal(liveState([{ url: "https://x/", status: 200 }]), "live");
});

test("buildManifest composes honest labels", () => {
  const m = buildManifest({ commit: "abc", tapText: tapSkipped, porcelain: " M x\n", probes: undefined });
  assert.equal(m.suite.label, "passed-with-skips");
  assert.equal(m.suite.skipped, 1);
  assert.equal(m.candidate, "dirty");
  assert.equal(m.live, "unverified");
});
