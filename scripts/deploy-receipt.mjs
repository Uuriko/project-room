#!/usr/bin/env node
// deploy-receipt.mjs — DA-3 (FLEET-TOOLS lane, 2026-10-18).
//
// Generates the two deploy artefacts that used to be hand-transcribed —
// the transcription class that produced a wrong rollback baseline on
// 2026-10-17:
//   1. the format-1 compatibility receipt that scripts/manual-rollback.mjs
//      requires (COMPATIBILITY_FILE), and
//   2. the deploy head declaration (freeze/head post text).
// Both are generated from the deploy-prod run's own records — the
// pre-deploy-<sha> snapshot artifact, the deploy job log, the next
// deploy's snapshot (cross-check) and gh api compares — never from
// recollection. Worker-code pairs only (format-1 scope); backup-format
// receipts belong to the per-room Stage 6 rehearsal artefacts.
//
// HARD LIMITS (by design, do not "fix"):
//   * A human still commits the receipt and asserts
//     COMPATIBILITY_REVIEWED at rollback time. The generator removes
//     transcription, never attestation.
//   * oldCodeNewData is filled ONLY from a real boot test supplied with
//     --boot-test; otherwise it is emitted result:"not-run" and the
//     receipt FAILS qualification loudly (see validateReceipt below).
//   * retainedRuntime is never filled by this generator: confirming the
//     target's immutable version still exists with its embedded stamp
//     requires the Cloudflare API (operator key custody — qualification
//     exception E-B, 2026-10-15). It is emitted result:"not-run".
//   * workerBindings IS filled from gh api reads: the declared binding
//     inventories (cloudflare/wrangler.jsonc +
//     cloudflare/external-probe.wrangler.jsonc) must be byte-identical
//     (same blob) at both revisions of the pair, the source-level
//     evidence the 2026-10-15 qualification used.
//
// Usage:
//   node scripts/deploy-receipt.mjs receipt --run <deployRunId>
//        [--out <receipt.json>] [--boot-test <{result,evidence}.json>]
//        [--repo Uuriko/project-room]
//   node scripts/deploy-receipt.mjs head --run <deployRunId>
//        [--exception "name: text"]... [--repo Uuriko/project-room]
//
// Exit codes: 0 = generated (a receipt that does not qualify still exits
// 0 — its validation verdict is printed and is part of the artefact's
// story; committing it as-is would be refused by manual-rollback.mjs) ·
// 1 = generation refused (run not successful, pair sources disagree,
// inputs unreadable).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const GENERATOR_VERSION = "1.0";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

// The evidence-URL rule, copied verbatim from manual-rollback.mjs
// qualification(). tests/deploy-receipt.test.js pins this constant
// against that source file; if the gate's rule drifts, the test fails
// and this generator must be re-pinned before use.
export const EVIDENCE_PATH_RE = /\/(?:actions\/runs\/\d+(?:\/attempts\/\d+)?|blob\/[0-9a-f]{40}\/[^?#]+)$/;

export function evidenceUrlOk(value) {
  let link;
  try { link = new URL(value); } catch { return false; }
  return link.protocol === "https:" && !link.username && !link.password && !link.hash
    && link.hostname === "github.com" && !link.search && EVIDENCE_PATH_RE.test(link.pathname);
}

// The deployed pair's new version IDs. deploy-prod's deploy steps print
// "Current Version ID: <uuid>" (wrangler output the workflow itself
// greps); the canonical (prod) step runs before the entry step, so the
// first two full-UUID matches in the deploy job log are the pair, in
// order. Anything else (0, 1, 3+) is ambiguous and refused.
export function extractDeployedVersionIds(logText) {
  const ids = [...String(logText).matchAll(/Current Version ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)]
    .map((m) => m[1]);
  if (ids.length !== 2 || ids[0] === ids[1]) return null;
  return { prod: ids[0], entry: ids[1] };
}

// Build the format-1 receipt from the deploy run's records.
//   snapshot: the parsed pre-deploy-<sha> artifact (deploy-recovery
//     snapshot: targetSha, prod/entry {versionId, sourceRevision, ...})
//   deployed: {prod, entry} version IDs created by the deploy
//   wranglerCompare: {identical: bool, detail: string, evidenceUrl}
//   bootTest: null | {result, evidence} from a real boot test
//   runUrl: https://github.com/<repo>/actions/runs/<id>
export function buildReceipt({ snapshot, deployed, wranglerCompare, bootTest, runUrl }) {
  if (!SHA_RE.test(snapshot?.targetSha ?? "")) throw new Error("snapshot targetSha is not a full SHA");
  for (const name of ["prod", "entry"]) {
    if (!UUID_RE.test(snapshot[name]?.versionId ?? "") || !SHA_RE.test(snapshot[name]?.sourceRevision ?? "")) {
      throw new Error(`snapshot ${name} pair is incomplete — refusing to transcribe a guess`);
    }
    if (!UUID_RE.test(deployed?.[name] ?? "")) throw new Error(`deployed ${name} version id missing or not a UUID`);
  }
  const checks = {
    oldCodeNewData: bootTest
      ? { result: bootTest.result, evidence: bootTest.evidence }
      : { result: "not-run", evidence: runUrl, note: "no boot-test evidence supplied (--boot-test); a human-run old-code-on-new-data boot test is required before this pair can qualify" },
    retainedRuntime: { result: "not-run", evidence: runUrl, note: "immutable-version read requires the Cloudflare API (operator key custody); not producible from GitHub reads — complete in the deploy window via the rollback preflight" },
    workerBindings: wranglerCompare?.identical
      ? { result: "passed", evidence: wranglerCompare.evidenceUrl }
      : { result: "not-run", evidence: runUrl, note: `declared binding inventories differ or could not be compared: ${wranglerCompare?.detail ?? "no compare supplied"}` },
  };
  return {
    format: 1,
    current: {
      prod: { versionId: deployed.prod, sourceRevision: snapshot.targetSha },
      entry: { versionId: deployed.entry, sourceRevision: snapshot.targetSha },
    },
    targets: {
      prod: { versionId: snapshot.prod.versionId, sourceRevision: snapshot.prod.sourceRevision },
      entry: { versionId: snapshot.entry.versionId, sourceRevision: snapshot.entry.sourceRevision },
    },
    checks,
  };
}

const pairMatches = (a, b) => a?.versionId === b?.versionId && a?.sourceRevision === b?.sourceRevision;

// Self-validation replicating the receipt-side rules of
// manual-rollback.mjs qualification() (the env/git sides — the
// dispatcher's COMPATIBILITY_REVIEWED acknowledgment and the committed-
// blob read — are the human's, and are NOT replicated or claimed here).
export function validateReceiptQualification(receipt, expected) {
  const failures = [];
  if (receipt?.format !== 1) failures.push("format is not 1 (compatibility qualification format unknown)");
  for (const name of ["prod", "entry"]) {
    if (!pairMatches(receipt?.current?.[name], expected.current[name])) {
      failures.push(`${name}: receipt current does not cover the expected current pair`);
    }
    if (expected.targets[name] ? !pairMatches(receipt?.targets?.[name], expected.targets[name]) : receipt?.targets?.[name] !== null) {
      failures.push(`${name}: receipt targets do not cover the expected target pair`);
    }
  }
  for (const name of ["oldCodeNewData", "retainedRuntime", "workerBindings"]) {
    const check = receipt?.checks?.[name];
    if (check?.result !== "passed") failures.push(`${name}: result is "${check?.result ?? "missing"}"; qualification requires "passed"`);
    else if (!evidenceUrlOk(check.evidence)) failures.push(`${name}: evidence is not an exact-source GitHub URL (actions/runs or blob/<40-hex>)`);
  }
  return { qualifies: failures.length === 0, failures };
}

// Cross-check: the NEXT deploy's pre-deploy snapshot records the live
// pair it found — which must equal the pair this deploy created. Returns
// {checked: bool, agrees: bool, detail}.
export function crossCheckNextSnapshot(nextSnapshot, deployed, deployedSha) {
  if (!nextSnapshot) return { checked: false, agrees: false, detail: "no later deploy snapshot exists yet — cross-check pending" };
  const agrees = nextSnapshot.prod?.versionId === deployed.prod
    && nextSnapshot.entry?.versionId === deployed.entry
    && nextSnapshot.prod?.sourceRevision === deployedSha
    && nextSnapshot.entry?.sourceRevision === deployedSha;
  return {
    checked: true, agrees,
    detail: agrees
      ? `next deploy snapshot (target ${nextSnapshot.targetSha}) records this pair live`
      : `next deploy snapshot records prod ${nextSnapshot.prod?.versionId}@${nextSnapshot.prod?.sourceRevision}, entry ${nextSnapshot.entry?.versionId}@${nextSnapshot.entry?.sourceRevision} — DISAGREES with the log-extracted pair`,
  };
}

export function buildHeadDeclaration({ run, snapshot, deployed, compare, jobs, exceptions, crossCheck }) {
  const sha = run.head_sha;
  const gate = jobs.find((j) => j.name === "gate");
  const deploy = jobs.find((j) => j.name === "deploy");
  const lines = [
    `HEAD DECLARATION — deploy-prod run ${run.id} (${run.html_url})`,
    `head: ${sha} (full 40-hex; production now serves this revision)`,
    `checks: gate ${gate?.conclusion ?? "unknown"} · deploy ${deploy?.conclusion ?? "unknown"} · run conclusion ${run.conclusion} — dual-green gate (test + schema-gate on this exact SHA) enforced by the workflow before any upload`,
    `prod compare: ${snapshot.prod.sourceRevision} → ${sha} (${compare.total_commits} commits, ${compare.files_changed} files changed)`,
    `pair: current prod ${deployed.prod} / entry ${deployed.entry} @ ${sha}; rollback targets prod ${snapshot.prod.versionId} / entry ${snapshot.entry.versionId} @ ${snapshot.prod.sourceRevision}`,
    `schemas: candidate ${snapshot.candidateCodeSchemaVersion}; prod previous ${snapshot.prod.codeSchemaVersion}; entry previous ${snapshot.entry.codeSchemaVersion}; writer-fence blob ${snapshot.candidateSchemaSource?.blob} (candidate) — see the generated receipt for the pair's qualification state`,
    `cross-check: ${crossCheck.detail}`,
    `exceptions: ${exceptions.length ? "" : "none named"}`,
    ...exceptions.map((e) => `  - ${e}`),
    `rollback: manual-rollback.mjs with the committed format-1 receipt for this exact pair + the dispatcher's compatibility_reviewed assertion; the generator asserts neither.`,
  ];
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI — fleet-side invocation. All reads via the gh CLI (repo precedent:
// scripts/landing-facts.mjs, scripts/release-checkpoint.mjs).

function gh(args, { json = false } = {}) {
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return json ? JSON.parse(out) : out;
}

function downloadSnapshot(runId, repo, sha) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-receipt-"));
  gh(["run", "download", String(runId), "-R", repo, "-n", `pre-deploy-${sha}`, "-D", dir]);
  return JSON.parse(readFileSync(join(dir, "pre-deploy.json"), "utf8"));
}

function snapshotForRun(run, repo) {
  const artifacts = gh(["api", `repos/${repo}/actions/runs/${run.id}/artifacts`], { json: true }).artifacts;
  const name = `pre-deploy-${run.head_sha}`;
  if (!artifacts.some((a) => a.name === name)) throw new Error(`run ${run.id} has no ${name} artifact`);
  return downloadSnapshot(run.id, repo, run.head_sha);
}

function nextDeploySnapshot(run, repo) {
  const runs = gh(["api", `repos/${repo}/actions/workflows/deploy-prod.yml/runs?event=workflow_dispatch&per_page=25`], { json: true }).workflow_runs
    .filter((r) => r.created_at > run.created_at && r.id !== run.id)
    .sort((x, y) => (x.created_at < y.created_at ? -1 : 1));
  for (const candidate of runs) {
    try { return snapshotForRun(candidate, repo); } catch { /* no snapshot artifact — keep looking */ }
  }
  return null;
}

function wranglerCompare(repo, currentRev, targetRev) {
  const files = ["cloudflare/wrangler.jsonc", "cloudflare/external-probe.wrangler.jsonc"];
  const shas = {};
  for (const rev of [currentRev, targetRev]) {
    for (const path of files) {
      shas[`${rev}:${path}`] = gh(["api", `repos/${repo}/contents/${path}?ref=${rev}`], { json: true }).sha;
    }
  }
  const identical = files.every((p) => shas[`${currentRev}:${p}`] === shas[`${targetRev}:${p}`]);
  return {
    identical,
    detail: files.map((p) => `${p} ${shas[`${targetRev}:${p}`].slice(0, 10)}→${shas[`${currentRev}:${p}`].slice(0, 10)}`).join("; "),
    evidenceUrl: `https://github.com/${repo}/blob/${targetRev}/cloudflare/wrangler.jsonc`,
  };
}

function loadRun(runId, repo) {
  const run = gh(["api", `repos/${repo}/actions/runs/${runId}`], { json: true });
  if (run.path !== ".github/workflows/deploy-prod.yml") throw new Error(`run ${runId} is ${run.path}, not deploy-prod`);
  return run;
}

function deployedPair(run, repo) {
  const log = gh(["run", "view", String(run.id), "-R", repo, "--log"]);
  const deployed = extractDeployedVersionIds(log);
  if (!deployed) throw new Error(`could not extract exactly two deployed version IDs from run ${run.id}'s deploy log — refusing to guess the pair`);
  return deployed;
}

function receiptMode(args) {
  const repo = args.repo;
  const run = loadRun(args.run, repo);
  if (run.conclusion !== "success") throw new Error(`deploy run ${run.id} concluded "${run.conclusion}", not success — no receipt for a deploy that did not complete`);
  const snapshot = snapshotForRun(run, repo);
  if (snapshot.targetSha !== run.head_sha) throw new Error(`snapshot target ${snapshot.targetSha} != run head ${run.head_sha}`);
  const deployed = deployedPair(run, repo);
  const cross = crossCheckNextSnapshot(nextDeploySnapshot(run, repo), deployed, run.head_sha);
  if (cross.checked && !cross.agrees) throw new Error(`pair cross-check FAILED: ${cross.detail}`);
  const compare = wranglerCompare(repo, run.head_sha, snapshot.prod.sourceRevision);
  const bootTest = args.bootTest ? JSON.parse(readFileSync(args.bootTest, "utf8")) : null;
  if (bootTest && !evidenceUrlOk(bootTest.evidence)) throw new Error("--boot-test evidence is not an exact-source GitHub URL; refusing to embed it");
  const runUrl = `https://github.com/${repo}/actions/runs/${run.id}`;
  const receipt = buildReceipt({ snapshot, deployed, wranglerCompare: compare, bootTest, runUrl });
  const validation = validateReceiptQualification(receipt, receipt);
  const text = JSON.stringify(receipt, null, 2) + "\n";
  if (args.out) writeFileSync(args.out, text); else console.log(text.trimEnd());
  console.log(`deploy-receipt: pair current ${deployed.prod}/${deployed.entry} @ ${run.head_sha}; targets ${snapshot.prod.versionId}/${snapshot.entry.versionId} @ ${snapshot.prod.sourceRevision}`);
  console.log(`deploy-receipt: wrangler compare: ${compare.detail} — ${compare.identical ? "identical" : "DIFFER"}`);
  console.log(`deploy-receipt: cross-check: ${cross.detail}`);
  console.log(validation.qualifies
    ? "deploy-receipt: receipt QUALIFIES under manual-rollback.mjs's receipt-side rules (dispatcher attestation still required at rollback time)"
    : `deploy-receipt: receipt does NOT qualify yet — ${validation.failures.join("; ")}`);
}

function headMode(args) {
  const repo = args.repo;
  const run = loadRun(args.run, repo);
  const snapshot = snapshotForRun(run, repo);
  const deployed = deployedPair(run, repo);
  const cross = crossCheckNextSnapshot(nextDeploySnapshot(run, repo), deployed, run.head_sha);
  const cmp = gh(["api", `repos/${repo}/compare/${snapshot.prod.sourceRevision}...${run.head_sha}`], { json: true });
  const jobs = gh(["api", `repos/${repo}/actions/runs/${run.id}/jobs`], { json: true }).jobs;
  console.log(buildHeadDeclaration({
    run, snapshot, deployed, jobs,
    compare: { total_commits: cmp.total_commits, files_changed: (cmp.files || []).length >= 300 ? "300+ (compare file list API-capped)" : (cmp.files || []).length },
    exceptions: args.exceptions, crossCheck: cross,
  }).trimEnd());
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const args = { repo: "Uuriko/project-room", exceptions: [] };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i], v = () => rest[++i];
    if (k === "--run") args.run = v();
    else if (k === "--out") args.out = v();
    else if (k === "--boot-test") args.bootTest = v();
    else if (k === "--repo") args.repo = v();
    else if (k === "--exception") args.exceptions.push(v());
    else throw new Error(`unknown argument: ${k}`);
  }
  if (!args.run) throw new Error("--run <deployRunId> is required");
  if (mode === "receipt") receiptMode(args);
  else if (mode === "head") headMode(args);
  else throw new Error("usage: deploy-receipt.mjs receipt|head --run <id> [--out <file>] [--boot-test <json>] [--exception <text>] [--repo <owner/name>]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`deploy-receipt: ${error.message}`); process.exit(1); }
}
