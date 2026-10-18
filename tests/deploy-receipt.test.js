// Tests for scripts/deploy-receipt.mjs (DA-3). Includes:
//   * the EVIDENCE rule pin against scripts/manual-rollback.mjs source —
//     if the rollback gate's qualification rules drift, this test fails
//     and the generator must be re-pinned before use;
//   * the ee97df613 acceptance fixture: the pair below was read from two
//     agreeing machine sources on 2026-10-18 (deploy run 39080407552's
//     job log + run 39100293040's pre-deploy snapshot) and the generated
//     receipt's current/targets must byte-compare against it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_PATH_RE, buildHeadDeclaration, buildReceipt, crossCheckNextSnapshot,
  evidenceUrlOk, extractDeployedVersionIds, validateReceiptQualification,
} from "../scripts/deploy-receipt.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("pin: evidence-URL rule matches manual-rollback.mjs qualification() verbatim", () => {
  const source = readFileSync(join(HERE, "../scripts/manual-rollback.mjs"), "utf8");
  assert.ok(source.includes(EVIDENCE_PATH_RE.source),
    "manual-rollback.mjs evidence pathname regex drifted from EVIDENCE_PATH_RE — re-pin deploy-receipt.mjs");
  assert.ok(source.includes("check?.result !== 'passed'"), "qualification() result rule drifted");
  assert.ok(source.includes("evidence.format !== 1"), "qualification() format rule drifted");
  assert.ok(source.includes("link.hostname !== 'github.com'"), "qualification() host rule drifted");
});

test("evidenceUrlOk: the gate's URL shape, exactly", () => {
  assert.equal(evidenceUrlOk("https://github.com/Uuriko/project-room/actions/runs/39080407552"), true);
  assert.equal(evidenceUrlOk("https://github.com/Uuriko/project-room/actions/runs/39080407552/attempts/2"), true);
  assert.equal(evidenceUrlOk("https://github.com/Uuriko/project-room/blob/77df0e0b7ce777ca0bdfe61bddd7320b0b352c60/cloudflare/wrangler.jsonc"), true);
  assert.equal(evidenceUrlOk("http://github.com/Uuriko/project-room/actions/runs/39080407552"), false); // not https
  assert.equal(evidenceUrlOk("https://github.com/Uuriko/project-room/actions/runs/39080407552?x=1"), false); // query
  assert.equal(evidenceUrlOk("https://github.com/Uuriko/project-room/actions/runs/39080407552#frag"), false); // hash
  assert.equal(evidenceUrlOk("https://example.com/Uuriko/project-room/actions/runs/39080407552"), false); // host
  assert.equal(evidenceUrlOk("https://github.com/Uuriko/project-room/blob/77df0e0b/cloudflare/wrangler.jsonc"), false); // short sha
  assert.equal(evidenceUrlOk("not a url"), false);
});

test("extractDeployedVersionIds: ordered pair from the deploy log; ambiguity refused", () => {
  const log = [
    "wrangler deploy output… Current Version ID: ", // the workflow's own grep echo — no UUID, ignored
    "2026-10-17T23:49:10Z Current Version ID: 2ae701ef-57d6-427a-95a1-5898d5b49d76",
    "2026-10-17T23:49:18Z Current Version ID: da0edf74-e2ac-4e2b-a50f-ddde930d4cf2",
  ].join("\n");
  assert.deepEqual(extractDeployedVersionIds(log), {
    prod: "2ae701ef-57d6-427a-95a1-5898d5b49d76",
    entry: "da0edf74-e2ac-4e2b-a50f-ddde930d4cf2",
  });
  assert.equal(extractDeployedVersionIds("no versions here"), null);
  assert.equal(extractDeployedVersionIds("Current Version ID: 2ae701ef-57d6-427a-95a1-5898d5b49d76"), null);
});

// --- ee97df613 acceptance fixture (deploy run 39080407552) ---
const SNAPSHOT = {
  targetSha: "ee97df6132c37f8a41cc8925a00792b6bbd26e1d",
  candidateCodeSchemaVersion: 38,
  candidateSchemaSource: { version: 38, revision: "ee97df6132c37f8a41cc8925a00792b6bbd26e1d", path: "server/writer-fence.mjs", blob: "f2a7c40c8e4e31964c8d2fe5c01f66eaaab4df84" },
  prod: { versionId: "bf533d21-d4cc-4596-86db-4537e662e4e6", sourceRevision: "77df0e0b7ce777ca0bdfe61bddd7320b0b352c60", codeSchemaVersion: 38 },
  entry: { versionId: "5e696acc-769d-44d7-8528-2f978c0f6c46", sourceRevision: "77df0e0b7ce777ca0bdfe61bddd7320b0b352c60", codeSchemaVersion: 38 },
};
const DEPLOYED = { prod: "2ae701ef-57d6-427a-95a1-5898d5b49d76", entry: "da0edf74-e2ac-4e2b-a50f-ddde930d4cf2" };
const RUN_URL = "https://github.com/Uuriko/project-room/actions/runs/39080407552";
const WRANGLER_IDENTICAL = {
  identical: true, detail: "wrangler.jsonc ff761dfb04→ff761dfb04; external-probe ed7cf4389b→ed7cf4389b",
  evidenceUrl: "https://github.com/Uuriko/project-room/blob/77df0e0b7ce777ca0bdfe61bddd7320b0b352c60/cloudflare/wrangler.jsonc",
};

test("acceptance: ee97 skeleton — pair byte-compares with the hand-derived pair; validation fails loudly on the two not-run checks", () => {
  const receipt = buildReceipt({ snapshot: SNAPSHOT, deployed: DEPLOYED, wranglerCompare: WRANGLER_IDENTICAL, bootTest: null, runUrl: RUN_URL });
  // Byte-compare of the pair sections against ground truth.
  assert.equal(JSON.stringify(receipt.current), JSON.stringify({
    prod: { versionId: "2ae701ef-57d6-427a-95a1-5898d5b49d76", sourceRevision: "ee97df6132c37f8a41cc8925a00792b6bbd26e1d" },
    entry: { versionId: "da0edf74-e2ac-4e2b-a50f-ddde930d4cf2", sourceRevision: "ee97df6132c37f8a41cc8925a00792b6bbd26e1d" },
  }));
  assert.equal(JSON.stringify(receipt.targets), JSON.stringify({
    prod: { versionId: "bf533d21-d4cc-4596-86db-4537e662e4e6", sourceRevision: "77df0e0b7ce777ca0bdfe61bddd7320b0b352c60" },
    entry: { versionId: "5e696acc-769d-44d7-8528-2f978c0f6c46", sourceRevision: "77df0e0b7ce777ca0bdfe61bddd7320b0b352c60" },
  }));
  assert.equal(receipt.format, 1);
  assert.equal(receipt.checks.workerBindings.result, "passed"); // wrangler blobs identical across the pair (verified via gh api)
  assert.equal(receipt.checks.oldCodeNewData.result, "not-run"); // no boot test supplied — never approximated
  assert.equal(receipt.checks.retainedRuntime.result, "not-run"); // Cloudflare custody — never approximated
  const validation = validateReceiptQualification(receipt, receipt);
  assert.equal(validation.qualifies, false);
  assert.deepEqual(validation.failures.map((f) => f.split(":")[0]), ["oldCodeNewData", "retainedRuntime"]);
});

test("validation: a fully-passed receipt for the same pair qualifies; pair drift fails", () => {
  const receipt = buildReceipt({
    snapshot: SNAPSHOT, deployed: DEPLOYED, wranglerCompare: WRANGLER_IDENTICAL, runUrl: RUN_URL,
    bootTest: { result: "passed", evidence: RUN_URL },
  });
  receipt.checks.retainedRuntime = { result: "passed", evidence: RUN_URL };
  assert.equal(validateReceiptQualification(receipt, receipt).qualifies, true);
  const drifted = structuredClone(receipt);
  drifted.targets.prod.versionId = "bf533d21-d4cc-4596-86db-4537e662e4e7";
  const v = validateReceiptQualification(drifted, receipt);
  assert.equal(v.qualifies, false);
  assert.ok(v.failures.some((f) => f.startsWith("prod: receipt targets")));
});

test("cross-check: next snapshot agreeing/disagreeing/pending", () => {
  const next = { targetSha: "cef1c096485db09699931287437d26abfaf473a6", prod: { versionId: DEPLOYED.prod, sourceRevision: SNAPSHOT.targetSha }, entry: { versionId: DEPLOYED.entry, sourceRevision: SNAPSHOT.targetSha } };
  assert.equal(crossCheckNextSnapshot(next, DEPLOYED, SNAPSHOT.targetSha).agrees, true);
  assert.equal(crossCheckNextSnapshot({ ...next, prod: { versionId: "x", sourceRevision: "y" } }, DEPLOYED, SNAPSHOT.targetSha).agrees, false);
  assert.equal(crossCheckNextSnapshot(null, DEPLOYED, SNAPSHOT.targetSha).checked, false);
});

test("buildReceipt refuses incomplete pairs instead of transcribing a guess", () => {
  assert.throws(() => buildReceipt({ snapshot: { ...SNAPSHOT, prod: { versionId: "nope", sourceRevision: SNAPSHOT.prod.sourceRevision } }, deployed: DEPLOYED, wranglerCompare: WRANGLER_IDENTICAL, bootTest: null, runUrl: RUN_URL }), /refusing to transcribe a guess/);
});

test("head declaration carries the full SHA, the pair, the compare and named exceptions", () => {
  const text = buildHeadDeclaration({
    run: { id: 39080407552, head_sha: SNAPSHOT.targetSha, conclusion: "success", html_url: RUN_URL },
    snapshot: SNAPSHOT, deployed: DEPLOYED,
    jobs: [{ name: "gate", conclusion: "success" }, { name: "deploy", conclusion: "success" }],
    compare: { total_commits: 12, files_changed: 34 },
    exceptions: ["integrity: consecutiveFailures 118 — fix on main, exception closes on a live tick"],
    crossCheck: { checked: true, agrees: true, detail: "next deploy snapshot records this pair live" },
  });
  assert.match(text, /ee97df6132c37f8a41cc8925a00792b6bbd26e1d/);
  assert.match(text, /2ae701ef-57d6-427a-95a1-5898d5b49d76/);
  assert.match(text, /bf533d21-d4cc-4596-86db-4537e662e4e6/);
  assert.match(text, /12 commits, 34 files changed/);
  assert.match(text, /integrity: consecutiveFailures 118/);
});
