import test from "node:test";
import assert from "node:assert/strict";
import { buildReport, triagePull } from "../scripts/contributor-triage.mjs";

const pr = { number: 1, title: "A contribution", headRefOid: "a".repeat(40), mergeable: "MERGEABLE", updatedAt: "2026-01-01T00:00:00Z" };
test("metadata-only inventories do not imply CI is missing or failing", () => {
  assert.equal(triagePull(pr).queue, "ci-unobserved");
  assert.equal(triagePull(pr).testAggregatePassed, null);
});
test("an empty or skipped green summary never establishes test execution", () => {
  for (const checks of [[], [{name: "ci-verdict (NOTHING RAN - add ready-to-land)", conclusion: "SUCCESS"}], [{name: "test", conclusion: "SKIPPED"}], [{name: "mechanical", conclusion: "SUCCESS"}]]) {
    assert.equal(triagePull({...pr, statusCheckRollup: checks}).queue, "needs-ci");
  }
});
test("legacy statuses and pending runs prevent review-ready classification", () => {
  const passed = {name: "test", conclusion: "SUCCESS"};
  assert.equal(triagePull({...pr, statusCheckRollup: [passed, {context: "external", state: "ERROR"}]}).queue, "inspect-failures");
  assert.equal(triagePull({...pr, statusCheckRollup: [passed, {context: "external", state: "PENDING"}]}).queue, "ci-running");
  assert.equal(triagePull({...pr, statusCheckRollup: [passed, {name: "unit", status: "IN_PROGRESS", conclusion: ""}]}).queue, "ci-running");
});
test("old drafts and conflicts are preserved, never closure recommendations", () => {
  for (const extra of [{isDraft: true}, {mergeable: "CONFLICTING"}]) {
    const result = triagePull({...pr, ...extra}, new Date("2026-11-10T00:00:00Z"));
    assert.ok(result.daysSinceUpdate > 300);
    assert.equal(result.closureAuthorized, false);
    assert.equal(result.mergeAuthorized, false);
  }
});
test("passing tests still require known mergeability and review", () => {
  const passed = {...pr, statusCheckRollup: [{name: "test", conclusion: "SUCCESS"}]};
  assert.equal(triagePull(passed).queue, "needs-review");
  assert.equal(triagePull({...passed, mergeable: "UNKNOWN"}).queue, "mergeability-unknown");
  assert.equal(triagePull(passed).mergeAuthorized, false);
});
test("snapshot caps and duplicate identities cannot silently hide work", () => {
  assert.equal(buildReport([pr], {limit: 1}).possiblyTruncated, true);
  assert.equal(buildReport([pr], {limit: 2}).possiblyTruncated, false);
  assert.throws(() => buildReport([pr, pr], {limit: 10}), /duplicate/);
  assert.throws(() => buildReport([{...pr, headRefOid: "short"}], {limit: 10}), /exact head/);
  assert.throws(() => buildReport([], {}), /limit/);
});
