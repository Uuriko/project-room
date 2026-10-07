// Tests for the merge-queue flake eject budget
// (scripts/merge-queue-eject-budget.mjs).
//
// Authoring-gate answers (repo .agents/skills/test-audit):
// 1. Contract: per-PR merge_group failure-eject counting with a 24h rolling
//    window; trip at 3 ejects -> one room alert naming the PR + a quarantine
//    proposal that satisfies the quarantine-check contract. Lane-push / manual
//    / unknown ejects never burn budget.
// 2. Credible regressions: off-by-one in the window filter (aged ejects keep
//    counting), threshold comparing > instead of >=, double-alerting on repeat
//    ejects, alert naming the wrong PR, a proposal that fails quarantine-check
//    (expired repair_by, bad dates, missing test).
// 3. No existing coverage: nothing counts ejects today; merge-queue-receipt
//    only posts receipts. This module owns the budget boundary.
// 4. No production seams: all tests target exported pure functions with
//    fixture ledgers/events. The subprocess check runs the real
//    scripts/quarantine-check.mjs against a proposal — the same contract CI
//    enforces on tests/quarantine.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUDGET_DEFAULTS,
  LEDGER_VERSION,
  emptyLedger,
  mergeLedgers,
  classifyEject,
  recordEject,
  ejectsInWindow,
  evaluateBudget,
  markAlerted,
  proposeQuarantine,
  buildAlertBody,
  alertCommandId,
  pruneOnClose,
  pruneAged,
} from "../scripts/merge-queue-eject-budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-07T05:30:00Z");

function eject(at, sha = "abc1234", reason = "The required status checks have failed.") {
  return { at: new Date(at).toISOString(), sha, reason };
}

test("emptyLedger carries the budget parameters and schema version", () => {
  const ledger = emptyLedger();
  assert.equal(ledger.version, LEDGER_VERSION);
  assert.deepEqual(ledger.budget, { max_ejects: 3, window_hours: 24 });
  assert.deepEqual(ledger.ejects, {});
  assert.deepEqual(ledger.over_budget, {});
  assert.deepEqual(ledger.quarantine_proposals, []);
});

test("classifyEject: explicit check failures burn budget", () => {
  assert.equal(classifyEject("The required status checks have failed."), "failure");
  assert.equal(classifyEject("A required check timed out after 60 minutes."), "failure");
  assert.equal(classifyEject("check run errored: runner lost communication"), "failure");
});

test("classifyEject: lane pushes, manual dequeues and dirty PRs never burn budget", () => {
  assert.equal(
    classifyEject("The head commit for this merge group is not the head of the pull request."),
    "lane_push",
  );
  assert.equal(classifyEject("The pull request was dequeued from the merge queue."), "manual");
  assert.equal(classifyEject("The pull request is not mergeable."), "dirty");
});

test("classifyEject: unknown reasons are fail-closed (no budget burn)", () => {
  assert.equal(classifyEject(""), "unknown");
  assert.equal(classifyEject(null), "unknown");
  assert.equal(classifyEject("Some new reason string GitHub invented tomorrow."), "unknown");
});

test("recordEject: failure ejects append to the per-PR ledger", () => {
  const ledger = emptyLedger();
  const r = recordEject(ledger, { pr: "123", ...eject(NOW) });
  assert.equal(r.counted, true);
  assert.equal(r.kind, "failure");
  assert.equal(ledger.ejects["123"].length, 1);
  assert.equal(ledger.ejects["123"][0].sha, "abc1234");
});

test("recordEject: non-failure ejects leave the ledger untouched", () => {
  const ledger = emptyLedger();
  for (const reason of [
    "The head commit for this merge group is not the head of the pull request.",
    "The pull request was dequeued from the merge queue.",
    "The pull request is not mergeable.",
    "Mystery reason.",
  ]) {
    const r = recordEject(ledger, { pr: "123", at: new Date(NOW).toISOString(), sha: "s", reason });
    assert.equal(r.counted, false);
  }
  assert.deepEqual(ledger.ejects, {});
});

test("recordEject: the same eject (pr + sha) is never double-counted", () => {
  const ledger = emptyLedger();
  recordEject(ledger, { pr: "123", ...eject(NOW, "deadbeef") });
  const r = recordEject(ledger, { pr: "123", ...eject(NOW + 1000, "deadbeef") });
  assert.equal(r.counted, false);
  assert.equal(r.duplicate, true);
  assert.equal(ledger.ejects["123"].length, 1);
});

test("evaluateBudget: trips exactly at 3 failure-ejects inside 24h", () => {
  const ledger = emptyLedger();
  recordEject(ledger, { pr: "123", ...eject(NOW - 3 * HOUR, "sha1") });
  recordEject(ledger, { pr: "123", ...eject(NOW - 2 * HOUR, "sha2") });
  let v = evaluateBudget(ledger, "123", NOW);
  assert.equal(v.count, 2);
  assert.equal(v.tripped, false);
  assert.equal(v.alreadyAlerted, false);
  recordEject(ledger, { pr: "123", ...eject(NOW - HOUR, "sha3") });
  v = evaluateBudget(ledger, "123", NOW);
  assert.equal(v.count, 3);
  assert.equal(v.tripped, true);
  assert.equal(v.alreadyAlerted, false);
});

test("evaluateBudget: ejects older than the window age out", () => {
  const ledger = emptyLedger();
  recordEject(ledger, { pr: "123", ...eject(NOW - 25 * HOUR, "old1") });
  recordEject(ledger, { pr: "123", ...eject(NOW - 26 * HOUR, "old2") });
  recordEject(ledger, { pr: "123", ...eject(NOW, "fresh") });
  const v = evaluateBudget(ledger, "123", NOW);
  assert.equal(v.count, 1);
  assert.equal(v.tripped, false);
});

test("evaluateBudget: no repeat alert inside the same window after tripping", () => {
  const ledger = emptyLedger();
  recordEject(ledger, { pr: "123", ...eject(NOW - 3 * HOUR, "s1") });
  recordEject(ledger, { pr: "123", ...eject(NOW - 2 * HOUR, "s2") });
  recordEject(ledger, { pr: "123", ...eject(NOW - HOUR, "s3") });
  markAlerted(ledger, "123", NOW, "alert-id-1");
  recordEject(ledger, { pr: "123", ...eject(NOW, "s4") });
  const v = evaluateBudget(ledger, "123", NOW);
  assert.equal(v.count, 4);
  assert.equal(v.tripped, true);
  assert.equal(v.alreadyAlerted, true);
});

test("evaluateBudget: a fresh trip after the window rolls re-alerts", () => {
  const ledger = emptyLedger();
  // Old trip: alerted 30h ago, its ejects have aged out of the 24h window.
  recordEject(ledger, { pr: "123", ...eject(NOW - 30 * HOUR, "o1") });
  recordEject(ledger, { pr: "123", ...eject(NOW - 29 * HOUR, "o2") });
  recordEject(ledger, { pr: "123", ...eject(NOW - 28 * HOUR, "o3") });
  markAlerted(ledger, "123", NOW - 28 * HOUR, "alert-id-old");
  // New churn inside a fresh window.
  recordEject(ledger, { pr: "123", ...eject(NOW - 3 * HOUR, "n1") });
  recordEject(ledger, { pr: "123", ...eject(NOW - 2 * HOUR, "n2") });
  recordEject(ledger, { pr: "123", ...eject(NOW - HOUR, "n3") });
  const v = evaluateBudget(ledger, "123", NOW);
  assert.equal(v.count, 3);
  assert.equal(v.tripped, true);
  assert.equal(v.alreadyAlerted, false);
});

test("ejectsInWindow: boundary is strict (24h00m00s is out)", () => {
  const list = [
    eject(NOW - 24 * HOUR, "edge"),
    eject(NOW - 24 * HOUR + 1000, "inside"),
  ];
  const kept = ejectsInWindow(list, NOW, 24 * HOUR);
  assert.deepEqual(kept.map((e) => e.sha), ["inside"]);
});

test("proposeQuarantine: fills the quarantine schema with a 14-day repair cap", () => {
  const p = proposeQuarantine({
    pr: "123",
    author: "jill",
    failingChecks: ["browser-shards"],
    reason: "The required status checks have failed.",
    atISO: new Date(NOW).toISOString(),
  });
  assert.ok(p.test.includes("browser-shards"), "test names the failing check");
  assert.ok(p.reason.includes("#123"), "reason names the PR");
  assert.match(p.quarantined_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(p.repair_by, /^\d{4}-\d{2}-\d{2}$/);
  const spanDays = Math.round(
    (Date.parse(p.repair_by + "T00:00:00Z") - Date.parse(p.quarantined_at + "T00:00:00Z")) / 86_400_000,
  );
  assert.equal(spanDays, 14);
  assert.equal(p.owner, "jill");
  assert.ok("ticket" in p);
});

test("proposeQuarantine: the proposal passes the real quarantine-check contract", () => {
  const p = proposeQuarantine({
    pr: "456",
    author: "",
    failingChecks: [],
    reason: "The required status checks have failed.",
    atISO: new Date(NOW).toISOString(),
  });
  const dir = mkdtempSync(path.join(tmpdir(), "eject-budget-"));
  const file = path.join(dir, "quarantine.json");
  writeFileSync(file, JSON.stringify({ quarantined: [p] }));
  const out = execFileSync("node", [path.join(here, "..", "scripts", "quarantine-check.mjs"), file], {
    encoding: "utf8",
  });
  assert.match(out, /OK/);
});

test("buildAlertBody: FRICTION alert names the PR, the count, and the proposal", () => {
  const ledger = emptyLedger();
  recordEject(ledger, { pr: "123", ...eject(NOW - 3 * HOUR, "s1") });
  recordEject(ledger, { pr: "123", ...eject(NOW - 2 * HOUR, "s2") });
  recordEject(ledger, { pr: "123", ...eject(NOW - HOUR, "s3") });
  const proposal = proposeQuarantine({
    pr: "123", author: "jill", failingChecks: ["unit"], reason: "x",
    atISO: new Date(NOW).toISOString(),
  });
  const body = buildAlertBody({
    pr: "123", count: 3, windowHours: 24,
    ejects: ejectsInWindow(ledger.ejects["123"], NOW, 24 * HOUR),
    failingChecks: ["unit"], proposal,
  });
  assert.ok(body.startsWith("FRICTION"), "uses the fleet FRICTION prefix");
  assert.ok(body.includes("#123"), "names the PR");
  assert.ok(body.includes("3"), "states the eject count");
  assert.ok(body.includes("24"), "states the window");
  assert.ok(body.includes(proposal.test), "carries the quarantine proposal");
  assert.ok(body.includes("quarantine"), "points at the quarantine flow");
});

test("alertCommandId: deterministic per (pr, trip) like the receipt ids", () => {
  const a = alertCommandId("123", "2026-10-07T05:00:00Z");
  const b = alertCommandId("123", "2026-10-07T05:00:00Z");
  const c = alertCommandId("456", "2026-10-07T05:00:00Z");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("pruneOnClose: a merged/closed PR leaves the ledger", () => {
  const ledger = emptyLedger();
  recordEject(ledger, { pr: "123", ...eject(NOW, "s1") });
  markAlerted(ledger, "123", NOW, "alert-1");
  pruneOnClose(ledger, "123");
  assert.ok(!("123" in ledger.ejects));
  assert.ok(!("123" in ledger.over_budget));
});

test("pruneAged: drops ejects far outside the window, keeps proposals", () => {
  const ledger = emptyLedger();
  recordEject(ledger, { pr: "123", ...eject(NOW - 72 * HOUR, "ancient") });
  recordEject(ledger, { pr: "123", ...eject(NOW - HOUR, "fresh") });
  ledger.quarantine_proposals.push({ test: "x", reason: "y" });
  pruneAged(ledger, NOW);
  assert.deepEqual(ledger.ejects["123"].map((e) => e.sha), ["fresh"]);
  assert.equal(ledger.quarantine_proposals.length, 1);
});

test("BUDGET_DEFAULTS: 3 ejects in a 24h rolling window", () => {
  assert.deepEqual(BUDGET_DEFAULTS, { max_ejects: 3, window_hours: 24 });
});

test("mergeLedgers: unions concurrent ledger updates without double-counting", () => {
  const a = emptyLedger();
  recordEject(a, { pr: "123", ...eject(NOW - 2 * HOUR, "sha-a") });
  markAlerted(a, "123", NOW - 2 * HOUR, "alert-a");
  const b = emptyLedger();
  recordEject(b, { pr: "123", ...eject(NOW - HOUR, "sha-a") }); // same eject, other run
  recordEject(b, { pr: "123", ...eject(NOW - HOUR, "sha-b") });
  recordEject(b, { pr: "999", ...eject(NOW, "sha-c") });
  const merged = mergeLedgers(a, b);
  assert.deepEqual(merged.ejects["123"].map((e) => e.sha).sort(), ["sha-a", "sha-b"]);
  assert.deepEqual(merged.ejects["999"].map((e) => e.sha), ["sha-c"]);
  assert.equal(merged.over_budget["123"].alert_message_id, "alert-a");
  assert.equal(merged.version, LEDGER_VERSION);
});
