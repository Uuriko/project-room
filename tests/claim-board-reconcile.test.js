// tests/claim-board-reconcile.test.js — fixture-backed tests for the offline
// claim-board reconciler (scripts/claim-board-reconcile.mjs). Every positive
// fixture must raise its findings; the negative control must raise none.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { reconcile, CHECK_NAMES } from "../scripts/claim-board-reconcile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "..", "scripts", "claim-board-reconcile.mjs");
const fixture = name => JSON.parse(readFileSync(join(here, "fixtures", "claim-reconcile", name), "utf8"));
const codes = findings => findings.map(finding => finding.code);
const byCode = (findings, code) => findings.filter(finding => finding.code === code);

test("acceptance: ROLE-DEPLOYER reported owned with no matching claim card", () => {
  const findings = reconcile(fixture("role-deployer-mismatch.json"));
  assert.equal(findings.length, 1, `expected exactly one finding, got ${JSON.stringify(findings)}`);
  const [finding] = findings;
  assert.equal(finding.code, "ROLE_OWNERSHIP_MISMATCH");
  assert.equal(finding.severity, "error");
  assert.equal(finding.claimId, "ROLE-DEPLOYER");
  assert.equal(finding.evidence.reportedOwner, "instinct");
  assert.ok(finding.detail.includes("instinct"), "detail must name the reported owner");
});

test("stale READY: merged-PR card and superseded card are flagged, fresh card is not", () => {
  const findings = reconcile(fixture("stale-ready.json"));
  assert.deepEqual(codes(findings).sort(), ["STALE_READY", "STALE_READY"]);
  const ids = findings.map(finding => finding.claimId).sort();
  assert.deepEqual(ids, ["deploy-docs-site", "refactor-auth"]);
  const merged = byCode(findings, "STALE_READY").find(f => f.claimId === "deploy-docs-site");
  assert.ok(merged.detail.includes("2011") && merged.detail.includes("merged"));
  const superseded = byCode(findings, "STALE_READY").find(f => f.claimId === "refactor-auth");
  assert.ok(superseded.detail.includes("refactor-auth-v2"));
});

test("missing ledger row: unrecorded state is an error, truncated history is not", () => {
  const findings = reconcile(fixture("missing-ledger-row.json"));
  const missing = byCode(findings, "MISSING_LEDGER_ROW");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].claimId, "api-rate-limit");
  assert.equal(missing[0].severity, "error");
  assert.ok(missing[0].detail.includes("in_progress"));
  const truncated = byCode(findings, "LEDGER_TRUNCATED");
  assert.equal(truncated.length, 1, "truncated history must be info, not a missing-row error");
  assert.equal(truncated[0].claimId, "old-cleanup");
  assert.equal(truncated[0].severity, "info");
  assert.equal(byCode(findings, "MISSING_LEDGER_ROW").filter(f => f.claimId === "old-cleanup").length, 0);
  assert.equal(findings.find(f => f.claimId === "healthy"), undefined);
});

test("PR/branch reconciliation: missing PR row, state drift, orphan branch", () => {
  const findings = reconcile(fixture("pr-branch-drift.json"));
  assert.deepEqual(codes(findings).sort(), ["CLAIM_PR_STATE_DRIFT", "MISSING_PR_ROW", "ORPHAN_BRANCH"]);
  const orphan = byCode(findings, "ORPHAN_BRANCH")[0];
  assert.equal(orphan.claimId, "feature-y");
  assert.ok(orphan.detail.includes("jill/wave-400"));
  const missingPr = byCode(findings, "MISSING_PR_ROW")[0];
  assert.equal(missingPr.claimId, "feature-z");
  const drift = byCode(findings, "CLAIM_PR_STATE_DRIFT")[0];
  assert.equal(drift.claimId, "feature-w");
  assert.ok(drift.detail.includes("merged") && drift.detail.includes("blocked"));
});

test("room events vs board: missing row and state disagreement diverge", () => {
  const findings = reconcile(fixture("event-divergence.json"));
  assert.deepEqual(codes(findings).sort(), ["EVENT_BOARD_DIVERGENCE", "EVENT_BOARD_DIVERGENCE"]);
  const ghost = byCode(findings, "EVENT_BOARD_DIVERGENCE").find(f => f.claimId === "ghost-claim");
  assert.ok(ghost.detail.includes("no board row"));
  const mismatch = byCode(findings, "EVENT_BOARD_DIVERGENCE").find(f => f.claimId === "mismatch-claim");
  assert.ok(mismatch.evidence.boardState === "unclaimed" && mismatch.evidence.eventState === "claimed");
});

test("negative control: a consistent snapshot yields zero findings", () => {
  const findings = reconcile(fixture("clean-negative-control.json"));
  assert.deepEqual(findings, [], `negative control must be clean, got ${JSON.stringify(findings)}`);
});

test("reconcile is deterministic", () => {
  const raw = fixture("stale-ready.json");
  assert.deepEqual(reconcile(raw), reconcile(JSON.parse(JSON.stringify(raw))));
});

test("malformed snapshots are rejected, not silently passed", () => {
  assert.throws(() => reconcile({}), /schema/);
  assert.throws(() => reconcile({ schema: "claim-board-snapshot/v1", claims: [], now: "not-a-date" }), /ISO/);
  assert.throws(() => reconcile({ schema: "claim-board-snapshot/v1", claims: "nope", now: "2026-10-09T19:00:00.000Z" }), /claims/);
});

test("finding codes are a closed, documented vocabulary", () => {
  const all = [
    ...reconcile(fixture("role-deployer-mismatch.json")),
    ...reconcile(fixture("stale-ready.json")),
    ...reconcile(fixture("missing-ledger-row.json")),
    ...reconcile(fixture("pr-branch-drift.json")),
    ...reconcile(fixture("event-divergence.json")),
  ];
  for (const finding of all) {
    assert.ok(CHECK_NAMES.includes(finding.code), `undocumented code ${finding.code}`);
    assert.ok(["error", "warn", "info"].includes(finding.severity));
    assert.equal(typeof finding.detail, "string");
  }
});

test("CLI: clean snapshot exits 0, dirty snapshot exits 2", () => {
  const run = name => {
    try {
      const out = execFileSync(process.execPath,
        [scriptPath, "--snapshot", join(here, "fixtures", "claim-reconcile", name)],
        { encoding: "utf8", timeout: 30000 });
      return { status: 0, out };
    } catch (err) {
      return { status: err.status, out: err.stdout };
    }
  };
  const clean = run("clean-negative-control.json");
  assert.equal(clean.status, 0, `clean CLI run must exit 0, got ${clean.status}: ${clean.out}`);
  assert.deepEqual(JSON.parse(clean.out), []);
  const dirty = run("role-deployer-mismatch.json");
  assert.equal(dirty.status, 2, `dirty CLI run must exit 2, got ${dirty.status}: ${dirty.out}`);
  assert.equal(JSON.parse(dirty.out)[0].code, "ROLE_OWNERSHIP_MISMATCH");
});
