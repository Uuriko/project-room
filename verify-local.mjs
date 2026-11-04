#!/usr/bin/env node
// verify-local.mjs — lane-side verification runner (MERGE-DEPLOY-TOOLS M1-01).
//
// v1.3 (2026-10-29, POST-EPISODE DISCHARGE re-run): object-store
//   bootstrap trigger broadened — v1.1/v1.2 bootstrapped only when the
//   HEAD object was absent from the source store, so the normal fleet
//   case (stale shared clone holding head+base while main has moved on)
//   died later as an uncaught ToolDefect at getMainDir's
//   listTree(mainSha) with NO bundle emitted (diagnosed live on PR
//   #4900 in wave-2026-10-29-discharge). The bootstrap now fires when
//   ANY required object — head, base, or main — is missing
//   (missingObjects), fetches with a bounded retry (the discharge
//   re-run's first v1.3 default-path attempt died on a main fetch that
//   ran past the 300 s cap inside this sandbox and returned EMPTY
//   stderr — hence also the explicit timeout naming below), and both
//   deferred main-tree reads (the materialise-failure A/B and
//   getMainDir) treat an absent main tree as A/B-unavailable instead
//   of crashing the run. Filed as a build item for supervised landing;
//   first real run under the prepared-store workaround is the
//   discharge re-run's bundle for PR #4900.
// v1.2 (2026-10-28, M1-04): proof-bundle schema reconciliation — the
//   runner now emits proof-bundle-spec v1.1 bundles (bundleVersion
//   "1.1", producedBy {tool, toolVersion, host}, per-check evidence)
//   that verify-proof.mjs v1.1 validates, replacing the private
//   `verify-local/proof-bundle` v1 shape verify-proof returned VOID on.
//   Internal check kinds map via mapCheckKind/toProofChecks: the CI=1
//   check.mjs run emits TWO entries (secret-scan + generation, spec
//   §3.1 combined-run rule). treeSha is now the head commit's real TREE
//   oid (resolveTreeSha); v1.1 copied the commit SHA into treeSha,
//   which made every bundle unbindable. The bundle write no longer
//   imports atomic-write.mjs (importing it read-taints the process
//   under the EPERM episode — wave finding M2-03/M4-02); the atomic
//   pattern (temp + fsync + sha256 readback + rename) is inlined, with
//   the stdout fallback unchanged. formatProofBundle is exported for
//   format-transform tooling.
// v1.1 (2026-10-28, M1-01): object-store bootstrap — if the target
//   sha is absent from the source object store (the shared clone is
//   stale; e.g. PR #5162's head 0805d3fa was not a local object), the
//   runner builds a scratch bare store and fetches the exact head /
//   base / main SHAs from origin (GitHub serves reachable SHAs), then
//   works from that store. Under the EPERM episode the fetch writes
//   are refused and the run ends as a named tool defect, never a
//   verdict on the tree.
// v1.0 (2026-10-28, wave MERGE-DEPLOY-TOOLS lane M1-01): first version.
//   Purpose: make hosted CI a confirmation, not a discovery. Given a PR
//   number (head resolved via ONE pulls API read, merge-base via ONE
//   compare read) or an explicit tree/commit SHA, the runner:
//     1. materialises the tree into lane scratch via the sanctioned
//        `git archive <sha> | tar -x` route (the shared clone
//        ~/workspace/project-room is used ONLY as a git object store —
//        it is stale + dirty and is never read as a working tree), then
//        verifies the materialisation byte-for-byte: every blob in
//        `git ls-tree -r <sha>` is re-hashed from the extracted file
//        (sha1 git-blob framing) and compared. A materialisation that
//        does not hash-match is never graded as the tree's failure.
//     2. determines the affected test set with the repo's OWN selection
//        logic — scripts/verify-affected.mjs run in --json mode inside
//        a scratch git repo whose two commits are the base tree and the
//        head tree (selection is invoked, never reinvented);
//     3. runs, locally: the affected suites (Bun first where available,
//        node --test fallback per file), scripts/verify-preflight.mjs,
//        `CI=1 node scripts/check.mjs` (the CI-mode pass whose stages
//        verify:affected does not select: secret scan, the generation
//        freshness gates — build-ui-strings/openapi-gen/wiki-build/
//        design-tokens --check — and the CI-only MCP/OpenAPI drift
//        test), and the pre-flight registration sweep
//        (fleet-tools/registration-sweep.mjs) in --range mode against
//        the scratch repo;
//     4. emits a proof bundle (proof-bundle-spec.md v1.1: bundleVersion
//        "1.1", treeSha = the head commit's tree oid, commitSha, pr,
//        baseSha, producedBy, startedAt/finishedAt, per-check {name,
//        kind, verdict, wallMs, evidence}) to --out.
//   ENVIRONMENTAL classification (fleet A/B pattern): any check that
//   fails is re-run against pristine main's tree; an identical failure
//   (same exit, same failing-test name set) is ENVIRONMENTAL, never the
//   tree's FAIL. Materialisation failure under the EPERM write-fault
//   episode (zero-filled / hash-mismatching extraction, identical at
//   pristine main) is ENVIRONMENTAL by the same rule.
//   Exit codes: 0 = no FAIL (PASS / NOT-APPLICABLE / ENVIRONMENTAL
//   entries allowed, at least one real check ran) · 1 = any FAIL ·
//   2 = tool defect (bad args, GitHub API failure incl. 403/429 — the
//   runner stops, never retries via another route — or a runner crash)
//   · 3 = ENVIRONMENTAL overall (materialisation blocked by the
//   environment, or every executed check environmental; no verdict on
//   the tree is claimed).
//   Bundle writes use the inlined atomic pattern (temp + fsync +
//   sha256 readback + rename; EPERM-survivable); if the write still
//   fails the bundle is printed to stdout between
//   VERIFY-LOCAL-BUNDLE-BEGIN/END markers instead.
//   Ledger: fleet-tools ledger lines for this tool are carried in the
//   M1-01 lane report (v1.0/v1.1) and the M1-04 lane report (v1.2)
//   (wave-2026-10-28-merge-deploy-tools/clusters/); README-verify-local.md
//   sits beside this file.
// Tests: verify-local.test.mjs (pure-logic + injected-tree fixtures).
//
// Boundary (lane protocol): this tool never merges, never labels,
// never dispatches a deploy, never forges a room/release-lease.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readlinkSync, readdirSync, renameSync, rmSync,
  writeFileSync, writeSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERIFY_LOCAL_VERSION = "1.3";
const REPO = "Uuriko/project-room";
const HERE = dirname(fileURLToPath(import.meta.url));

export class ToolDefect extends Error {}
export class RateLimitStop extends Error {}

// ---------------------------------------------------------------- args
export function parseArgs(argv) {
  const opts = {
    pr: null, sha: null, base: null, out: null, scratch: null,
    sourceRepo: join(process.env.HOME ?? "~", "workspace/project-room"),
    sweep: join(HERE, "registration-sweep.mjs"),
    budgetSec: 300, timeoutMs: 180_000, checkTimeoutMs: 900_000,
    keepScratch: false, noAb: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new ToolDefect(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--pr") opts.pr = Number(next());
    else if (a === "--sha") opts.sha = next();
    else if (a === "--base") opts.base = next();
    else if (a === "--out") opts.out = next();
    else if (a === "--scratch") opts.scratch = next();
    else if (a === "--source-repo") opts.sourceRepo = next();
    else if (a === "--sweep") opts.sweep = next();
    else if (a === "--budget") opts.budgetSec = Number(next());
    else if (a === "--timeout-ms") opts.timeoutMs = Number(next());
    else if (a === "--check-timeout-ms") opts.checkTimeoutMs = Number(next());
    else if (a === "--keep-scratch") opts.keepScratch = true;
    else if (a === "--no-ab") opts.noAb = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new ToolDefect(`unknown argument ${a}`);
  }
  if (opts.help) return opts;
  if ((opts.pr == null) === (opts.sha == null)) {
    throw new ToolDefect("give exactly one of --pr <n> or --sha <sha>");
  }
  if (opts.pr != null && (!Number.isInteger(opts.pr) || opts.pr <= 0)) {
    throw new ToolDefect("--pr must be a positive integer");
  }
  const shaRe = /^[0-9a-f]{7,40}$/i;
  if (opts.sha != null && !shaRe.test(opts.sha)) throw new ToolDefect("--sha must be a hex sha");
  if (opts.base != null && !shaRe.test(opts.base)) throw new ToolDefect("--base must be a hex sha");
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new ToolDefect("--timeout-ms must be > 0");
  return opts;
}

export const HELP = `verify-local.mjs v${VERIFY_LOCAL_VERSION} — lane-side verification runner

usage:
  node verify-local.mjs --pr <n>   [--base <sha>] [--out <bundle.json>] [options]
  node verify-local.mjs --sha <sha> [--base <sha>] [--out <bundle.json>] [options]

Resolves the target tree (PR head via one gh pulls read + one compare
read for the merge-base; or an explicit sha), materialises it with
git archive | tar -x into scratch, hash-verifies the materialisation
against git ls-tree, then runs: the repo's own verify:affected
selection (scripts/verify-affected.mjs --json) executed under Bun
with node --test fallback, scripts/verify-preflight.mjs, CI=1
scripts/check.mjs, and the registration sweep in --range mode.
Failing checks are A/B re-run against pristine main; identical
failures are classified ENVIRONMENTAL, never the tree's FAIL.
Emits a proof-bundle-spec v1.1 bundle (validates with
verify-proof.mjs v1.1); the CI=1 check run appears as two entries
(check-ci1:secret-scan + check-ci1:generation, spec §3.1).

options:
  --base <sha>         base sha (default: PR merge-base, else current main)
  --out <path>         proof-bundle JSON path (default: stdout only)
  --scratch <dir>      scratch root (default: $TMPDIR/verify-local-<sha12>)
  --source-repo <dir>  git object store to archive from
                       (default: ~/workspace/project-room — objects only,
                       its working tree is never read)
  --sweep <path>       registration-sweep.mjs path
  --budget <sec>       verify:affected selection budget (default 300)
  --timeout-ms <ms>    per-test-file timeout (default 180000)
  --check-timeout-ms <ms>  check.mjs / sweep timeout (default 900000)
  --keep-scratch       keep the scratch dir after the run
  --no-ab              skip A/B re-runs against pristine main

exit codes: 0 no FAIL · 1 any FAIL · 2 tool defect / GitHub stop ·
3 ENVIRONMENTAL overall (no verdict on the tree claimed)`;

// ---------------------------------------------------------------- exec
function run(cmd, args, { cwd, env, timeoutMs = 120_000, input } = {}) {
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd, env: env ?? process.env, timeout: timeoutMs, input,
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    status: r.status, signal: r.signal ?? null,
    timedOut: r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM",
    error: r.error ? String(r.error.message ?? r.error) : null,
    stdout: r.stdout ?? "", stderr: r.stderr ?? "",
    wallMs: Date.now() - started,
  };
}

function ghJson(endpoint) {
  const r = run("gh", ["api", endpoint], { timeoutMs: 60_000 });
  const blob = `${r.stdout}\n${r.stderr}`;
  if (/\b403\b|\b429\b|rate limit/i.test(blob) && r.status !== 0) {
    throw new RateLimitStop(`gh api ${endpoint} stopped: ${r.stderr.trim().slice(0, 300)}`);
  }
  if (r.status !== 0) {
    throw new ToolDefect(`gh api ${endpoint} failed (exit ${r.status}): ${r.stderr.trim().slice(0, 300)}`);
  }
  try { return JSON.parse(r.stdout); }
  catch { throw new ToolDefect(`gh api ${endpoint} returned non-JSON`); }
}

// ------------------------------------------------------- materialisation
// Extract <sha> from the source object store into dest via the
// sanctioned archive pipe. Returns the raw run result; integrity is a
// separate step (verifyTreeIntegrity) so a bad extraction is measured,
// not assumed.
export function materialise(sha, dest, sourceRepo) {
  mkdirSync(dest, { recursive: true });
  const started = Date.now();
  const r = spawnSync(
    "bash",
    ["-c", `git -C "$1" archive "$2" | tar -x -C "$3"`, "verify-local", sourceRepo, sha, dest],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
  );
  return {
    status: r.status, wallMs: Date.now() - started,
    stderrTail: (r.stderr ?? "").trim().split("\n").slice(-3).join(" | ").slice(0, 400),
    epermLines: ((r.stderr ?? "").match(/Operation not permitted/g) ?? []).length,
  };
}

// Parse `git ls-tree -r <sha>` output: [{mode, type, blob, path}].
export function parseLsTree(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line) continue;
    const m = line.match(/^(\d+) (\w+) ([0-9a-f]{40})\t(.*)$/);
    if (m) out.push({ mode: m[1], type: m[2], blob: m[3], path: m[4] });
  }
  return out;
}

export function gitBlobSha(buf) {
  const head = Buffer.from(`blob ${buf.length}\0`, "utf8");
  return createHash("sha1").update(head).update(buf).digest("hex");
}

// Compare an extracted tree against the ls-tree listing. listTree is
// injectable for tests. Returns counts + the first mismatches.
export function verifyTreeIntegrity(entries, dest) {
  let checked = 0, zeroFilled = 0, badCount = 0;
  const mismatches = [];
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const p = join(dest, e.path);
    let ok = false, actualSize = -1;
    try {
      const st = lstatSync(p);
      if (e.mode === "120000") {
        ok = st.isSymbolicLink() && readlinkSync(p) != null;
        actualSize = st.size;
      } else {
        const buf = readFileSync(p);
        actualSize = buf.length;
        if (buf.length === 0) zeroFilled++;
        ok = gitBlobSha(buf) === e.blob;
      }
    } catch { ok = false; }
    checked++;
    if (!ok) {
      badCount++;
      if (mismatches.length < 10) {
        mismatches.push({ path: e.path, expectedBlob: e.blob, actualSize });
      }
    }
  }
  return {
    ok: badCount === 0,
    files: checked, zeroFilled, mismatches,
    mismatchCount: badCount,
  };
}

export function listTree(sha, sourceRepo) {
  const r = run("git", ["-C", sourceRepo, "ls-tree", "-r", sha], { timeoutMs: 120_000 });
  if (r.status !== 0) throw new ToolDefect(`git ls-tree ${sha} failed: ${r.stderr.trim().slice(0, 200)}`);
  return parseLsTree(r.stdout);
}

// The subset of `shas` whose commit object is ABSENT from the source
// store (v1.3). The object-store bootstrap keys on this over ALL
// required objects — head, base, AND main: v1.2 probed head only, so a
// store holding head+base but not the live main tip passed the probe
// and the run died later at the first deferred main read. Pure given
// `has` (injectable for tests); the default probes with rev-parse.
export function missingObjects(shas, sourceRepo, has = null) {
  const present = has ?? ((sha) => resolveTreeSha(sha, sourceRepo) !== null);
  return [...new Set((shas ?? []).filter(Boolean))].filter((sha) => !present(sha));
}

// The head commit's TREE oid (`<commit>^{tree}`), read from the object
// store. Returns null when the commit is absent or has no tree — the
// bundle formatter treats that as a tool defect and refuses to emit
// (v1.1 copied the commit SHA into treeSha; spec §2 forbids it).
export function resolveTreeSha(commitSha, sourceRepo) {
  if (typeof commitSha !== "string" || !/^[0-9a-f]{40}$/.test(commitSha)) return null;
  const r = run("git", ["-C", sourceRepo, "rev-parse", `${commitSha}^{tree}`], { timeoutMs: 60_000 });
  const out = (r.stdout ?? "").trim();
  return r.status === 0 && /^[0-9a-f]{40}$/.test(out) ? out : null;
}

// ------------------------------------------------------------- A/B logic
// Failing test names from node --test TAP output.
export function parseTapFailures(tap) {
  const names = new Set();
  for (const line of String(tap ?? "").split("\n")) {
    const m = line.match(/^\s*not ok \d+ - (.+)$/);
    if (m) names.add(m[1].trim());
  }
  return [...names].sort();
}

// Identical failure at pristine main => ENVIRONMENTAL.
export function classifyAB(headFail, mainFail) {
  if (!mainFail) return "FAIL";
  if (headFail.exit !== mainFail.exit && headFail.exit != null && mainFail.exit != null) {
    // exit codes may differ by runner noise; the name set decides for tests
    if (!headFail.names || !mainFail.names) return "FAIL";
  }
  if (headFail.names && mainFail.names) {
    const same = headFail.names.length === mainFail.names.length &&
      headFail.names.every((n, i) => n === mainFail.names[i]);
    return same && headFail.names.length > 0 ? "ENVIRONMENTAL" : "FAIL";
  }
  return headFail.exit === mainFail.exit ? "ENVIRONMENTAL" : "FAIL";
}

export function overallVerdict(checks) {
  if (checks.some((c) => c.verdict === "FAIL")) return { overall: "FAIL", exitCode: 1 };
  const ran = checks.filter((c) => c.verdict === "PASS" || c.verdict === "FAIL");
  const env = checks.filter((c) => c.verdict === "ENVIRONMENTAL");
  if (ran.length === 0 && env.length > 0) return { overall: "ENVIRONMENTAL", exitCode: 3 };
  if (env.length > 0) return { overall: "PASS-WITH-ENVIRONMENTAL", exitCode: 0 };
  return { overall: "PASS", exitCode: 0 };
}

// ------------------------------------------- proof-bundle format (v1.2)
// Internal check kind -> proof-bundle-spec v1.1 kind (spec §3/§3.1).
// "check" is deliberately absent here: the single CI=1 check.mjs run is
// emitted as two entries (secret-scan + generation) by toProofChecks.
export const CHECK_KIND_MAP = {
  materialisation: "materialisation",
  selection: "selection",
  test: "test",
  "test-summary": "test",
  preflight: "preflight",
  sweep: "sweep",
  suite: "suite",
  "secret-scan": "secret-scan",
  generation: "generation",
};

export function mapCheckKind(kind) {
  return CHECK_KIND_MAP[kind] ?? null;
}

const COMBINED_RUN_NOTE =
  "single CI=1 scripts/check.mjs run (combined stages: secret scan, " +
  "generation freshness, syntax, drift) — emitted as paired secret-scan " +
  "+ generation entries per proof-bundle-spec §3.1; a failure of the " +
  "combined run is not stage-separable from its output";

// Internal checks [{name, kind, verdict, wallMs, detail}] -> spec check
// entries [{name, kind, verdict, wallMs, evidence}]. The "check-ci1"
// entry expands into the §3.1 pair; unknown kinds are a tool defect,
// never silently relabelled.
export function toProofChecks(checks) {
  const out = [];
  for (const c of checks) {
    const detail = String(c.detail ?? "").trim();
    const evidence = detail.length > 0 ? detail : `${c.name}: ${c.verdict} (verify-local v${VERIFY_LOCAL_VERSION}; no detail recorded)`;
    if (c.kind === "check") {
      for (const [suffix, kind] of [["secret-scan", "secret-scan"], ["generation", "generation"]]) {
        out.push({
          name: `${c.name}:${suffix}`, kind, verdict: c.verdict, wallMs: c.wallMs,
          evidence: `${evidence} [${COMBINED_RUN_NOTE}]`,
        });
      }
      continue;
    }
    const kind = mapCheckKind(c.kind);
    if (!kind) throw new ToolDefect(`internal check kind ${JSON.stringify(c.kind)} has no proof-bundle-spec v1.1 mapping`);
    out.push({ name: c.name, kind, verdict: c.verdict, wallMs: c.wallMs, evidence });
  }
  return out;
}

// Assemble the spec v1.1 bundle. treeSha MUST be the head commit's real
// tree oid (resolveTreeSha); passing the commit SHA is refused, not
// emitted. pr may be null (sha-targeted run; spec 1.1 makes pr optional
// and such a bundle cannot bind online).
export function formatProofBundle({
  treeSha, commitSha, pr = null, baseSha, mainSha = null,
  startedAt, finishedAt, wallMs = null, host, toolVersion = VERIFY_LOCAL_VERSION,
  runner = null, overall, exitCode, checks, scratch = null,
}) {
  if (typeof treeSha !== "string" || !/^[0-9a-f]{40}$/.test(treeSha)) {
    throw new ToolDefect(`formatProofBundle: treeSha must be a full 40-char tree oid, got ${JSON.stringify(treeSha)}`);
  }
  if (treeSha === commitSha) {
    throw new ToolDefect("formatProofBundle: treeSha === commitSha — refusing to emit a bundle whose treeSha is a commit SHA (resolve the tree oid first)");
  }
  return {
    bundleVersion: "1.1",
    treeSha,
    commitSha,
    ...(pr != null ? { pr } : {}),
    baseSha,
    producedBy: { tool: "verify-local.mjs", toolVersion, host },
    startedAt, finishedAt,
    ...(wallMs != null ? { wallMs } : {}),
    checks: toProofChecks(checks),
    // --- fleet extensions (spec §2: unknown fields are permitted) ---
    mainSha,
    runner,
    overall,
    exitCode,
    scratch,
  };
}

// Inline atomic write: temp file in the destination directory + fsync
// + sha256 readback + rename. Deliberately NOT imported from
// atomic-write.mjs: under the EPERM write-fault episode, merely
// importing that module read-taints the importer and its later writes
// are refused (wave findings M2-03/M4-02); the same sequence inlined in
// this process succeeds. Returns true on a hash-verified write.
export function atomicWriteText(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const want = createHash("sha256").update(text, "utf8").digest("hex");
  const got = createHash("sha256").update(readFileSync(tmp)).digest("hex");
  if (got !== want) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw new Error(`atomic write readback mismatch for ${path}`);
  }
  renameSync(tmp, path);
  return true;
}

// ------------------------------------------------------------ check runs
function tailOf(s, n = 300) {
  return String(s ?? "").trim().split("\n").slice(-4).join(" | ").slice(0, n);
}

// Run one test file: Bun first, node --test fallback. Returns
// {exit, names, via, wallMs, detail} where exit is the NODE verdict
// exit when Bun failed (Bun incompatibility is not a tree failure).
export function runTestFile(treeDir, file, timeoutMs, env) {
  const bun = run("bun", ["test", file], { cwd: treeDir, timeoutMs, env });
  if (bun.status === 0) {
    return { exit: 0, names: [], via: "bun", wallMs: bun.wallMs, detail: "bun test passed" };
  }
  const node = run(process.execPath, ["--test", file], { cwd: treeDir, timeoutMs, env });
  const names = parseTapFailures(`${node.stdout}\n${node.stderr}`);
  return {
    exit: node.status ?? 1, names, via: "node (bun failed first)",
    wallMs: bun.wallMs + node.wallMs,
    detail: node.status === 0
      ? `bun failed (exit ${bun.status}); node --test passed`
      : `node --test exit ${node.status}; failing: ${names.slice(0, 5).join("; ") || tailOf(node.stderr)}`,
  };
}

// Build the scratch git repo verify:affected + the sweep need:
// commit A = base tree, commit B = head tree, HEAD = B, worktree = B.
function buildScratchRepo({ scratchRoot, baseSha, headSha, sourceRepo, env }) {
  const repoDir = join(scratchRoot, "repo");
  mkdirSync(repoDir, { recursive: true });
  const git = (args) => run("git", args, { cwd: repoDir, timeoutMs: 300_000, env });
  let r = git(["init", "-q", "."]);
  if (r.status !== 0) throw new ToolDefect(`git init in scratch failed: ${tailOf(r.stderr)}`);
  git(["config", "user.email", "verify-local@localhost"]);
  git(["config", "user.name", "verify-local"]);
  const mBase = materialise(baseSha, repoDir, sourceRepo);
  if (mBase.status !== 0) throw new ToolDefect(`base materialise failed: ${mBase.stderrTail}`);
  git(["add", "-A"]);
  r = git(["commit", "-q", "--allow-empty", "-m", `verify-local base ${baseSha}`]);
  if (r.status !== 0) throw new ToolDefect(`base commit failed: ${tailOf(r.stderr)}`);
  const localBase = git(["rev-parse", "HEAD"]).stdout.trim();
  let localHead = localBase;
  if (headSha !== baseSha) {
    for (const entry of readdirSync(repoDir)) {
      if (entry !== ".git") rmSync(join(repoDir, entry), { recursive: true, force: true });
    }
    const mHead = materialise(headSha, repoDir, sourceRepo);
    if (mHead.status !== 0) throw new ToolDefect(`head materialise failed: ${mHead.stderrTail}`);
    git(["add", "-A"]);
    r = git(["commit", "-q", "--allow-empty", "-m", `verify-local head ${headSha}`]);
    if (r.status !== 0) throw new ToolDefect(`head commit failed: ${tailOf(r.stderr)}`);
    localHead = git(["rev-parse", "HEAD"]).stdout.trim();
  }
  return { repoDir, localBase, localHead };
}

// ------------------------------------------------------------------ main
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }
  const startedAt = new Date();
  const t0 = Date.now();
  const checks = [];
  const push = (name, kind, verdict, wallMs, detail) =>
    checks.push({ name, kind, verdict, wallMs, detail: String(detail ?? "").slice(0, 1200) });

  // --- resolve target -------------------------------------------------
  let pr = null, headSha, baseSha, mainSha = null;
  if (opts.pr != null) {
    const p = ghJson(`repos/${REPO}/pulls/${opts.pr}`);
    pr = { number: opts.pr, headRef: p.head?.ref ?? null, baseRef: p.base?.ref ?? null, state: p.state ?? null };
    headSha = p.head?.sha;
    if (!headSha) throw new ToolDefect(`PR ${opts.pr} has no head sha`);
    baseSha = opts.base ?? null;
    if (!baseSha) {
      try {
        const cmp = ghJson(`repos/${REPO}/compare/${p.base?.sha}...${headSha}`);
        baseSha = cmp.merge_base_commit?.sha ?? p.base?.sha;
      } catch (e) {
        if (e instanceof RateLimitStop) throw e;
        baseSha = p.base?.sha;
      }
    }
  } else {
    headSha = opts.sha;
    baseSha = opts.base ?? null;
    if (!baseSha) {
      const m = ghJson(`repos/${REPO}/commits/main`);
      baseSha = m.sha;
    }
  }
  if (headSha === baseSha) mainSha = headSha;
  else {
    try { mainSha = ghJson(`repos/${REPO}/commits/main`).sha; } catch { mainSha = baseSha; }
  }

  const scratchRoot = opts.scratch
    ? resolve(opts.scratch)
    : join(process.env.TMPDIR || tmpdir(), `verify-local-${headSha.slice(0, 12)}`);
  mkdirSync(scratchRoot, { recursive: true });
  const env = { ...process.env, TMPDIR: join(scratchRoot, "tmp") };
  mkdirSync(env.TMPDIR, { recursive: true });
  const bunProbe = run("bun", ["--version"], { timeoutMs: 15_000 });
  const runnerInfo = {
    hostname: hostname(),
    tool: `verify-local.mjs v${VERIFY_LOCAL_VERSION}`,
    node: process.version,
    bun: bunProbe.status === 0 ? bunProbe.stdout.trim() : null,
    platform: `${process.platform}/${process.arch}`,
  };

  const finish = async (exitOverride = null) => {
    const { overall, exitCode } = overallVerdict(checks);
    // Spec v1.1: treeSha is the head commit's TREE oid, resolved from
    // the object store the run actually used. If it cannot be resolved
    // the run is a tool defect — never emit commit-as-tree (v1.1 bug).
    const treeSha = resolveTreeSha(headSha, sourceRepo);
    if (!treeSha) {
      throw new ToolDefect(
        `cannot resolve tree oid for head commit ${headSha.slice(0, 12)} in ${sourceRepo}; refusing to emit a bundle with an unbindable treeSha`);
    }
    const bundle = formatProofBundle({
      treeSha, commitSha: headSha,
      pr: pr ? pr.number : null,
      baseSha, mainSha,
      startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
      wallMs: Date.now() - t0,
      host: runnerInfo.hostname,
      runner: runnerInfo,
      overall: exitOverride?.overall ?? overall,
      exitCode: exitOverride?.exitCode ?? exitCode,
      checks,
      scratch: opts.keepScratch ? scratchRoot : null,
    });
    // prDetail survives as a fleet extension field (spec §2 permits).
    if (pr) bundle.prDetail = pr;
    if (opts.out) {
      const text = JSON.stringify(bundle, null, 2);
      let written = false;
      try {
        atomicWriteText(resolve(opts.out), text);
        written = true;
      } catch { /* fall through to plain write, then stdout */ }
      if (!written) {
        try { writeFileSync(resolve(opts.out), text); written = true; } catch { /* stdout below */ }
      }
      if (!written) {
        console.log("VERIFY-LOCAL-BUNDLE-BEGIN");
        console.log(text);
        console.log("VERIFY-LOCAL-BUNDLE-END");
        console.error(`verify-local: bundle write to ${opts.out} failed (EPERM episode?); bundle printed to stdout`);
      }
    }
    console.error(
      `verify-local: ${bundle.overall} (exit ${bundle.exitCode}) tree=${headSha.slice(0, 12)} ` +
      `base=${baseSha.slice(0, 12)} checks=${checks.length} wall=${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    if (!opts.keepScratch) {
      try { rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* scratch cleanup is best-effort */ }
    }
    return bundle.exitCode;
  };

  // --- object store: local clone objects, else scratch bootstrap -----
  // v1.3: bootstrap when ANY required object (head, base, or main) is
  // absent — not head only (see header note; PR #4900 discharge finding).
  let sourceRepo = opts.sourceRepo;
  const missing = missingObjects([headSha, baseSha, mainSha], sourceRepo);
  if (missing.length) {
    const store = join(scratchRoot, "object-store");
    const tmpl = join(scratchRoot, "empty-tmpl");
    mkdirSync(tmpl, { recursive: true });
    const gi = run("git", ["init", "--bare", "-q", store],
      { timeoutMs: 60_000, env: { ...env, GIT_TEMPLATE_DIR: tmpl } });
    if (gi.status !== 0) {
      throw new ToolDefect(
        `required object(s) ${missing.map((s) => s.slice(0, 12)).join(", ")} absent from source object store and scratch ` +
        `object-store init failed (EPERM episode?): ${tailOf(gi.stderr)}`);
    }
    for (const sha of [...new Set([headSha, baseSha, mainSha].filter(Boolean))]) {
      // v1.3: one bounded retry on a fresh connection, and a timeout is
      // NAMED as a timeout — spawnSync's kill leaves status null with
      // empty stderr, which v1.2's message rendered as a bare
      // "failed: " (observed live on this sandbox's slow network path).
      let f = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        f = run("git", ["-C", store, "fetch", "-q", "--no-tags",
          `https://github.com/${REPO}.git`, sha], { timeoutMs: 300_000, env });
        if (f.status === 0 || resolveTreeSha(sha, store)) break;
      }
      if (f.status !== 0 && !resolveTreeSha(sha, store)) {
        throw new ToolDefect(
          `object-store fetch of ${sha.slice(0, 12)} failed after 2 attempts: ` +
          (f.timedOut
            ? "timed out at 300 s (network too slow for a full-history SHA fetch in this environment; " +
              "use --source-repo with a prepared store, or refresh the shared clone)"
            : tailOf(f.stderr) || `git exited ${f.status}`));
      }
    }
    sourceRepo = store;
  }

  // --- materialise head + verify integrity ----------------------------
  const entries = listTree(headSha, sourceRepo);
  const headDir = join(scratchRoot, "head-plain");
  const mHead = materialise(headSha, headDir, sourceRepo);
  const integ = verifyTreeIntegrity(entries, headDir);
  push("materialise", "materialisation",
    integ.ok ? "PASS" : "FAIL", mHead.wallMs,
    integ.ok
      ? `${integ.files} blobs hash-verified against git ls-tree ${headSha.slice(0, 12)}`
      : `${integ.mismatchCount}/${integ.files} blobs mismatch (${integ.zeroFilled} zero-filled); tar stderr: ${mHead.stderrTail}`);
  if (!integ.ok) {
    // A/B: pristine main materialised the same way, right now.
    const abDir = join(scratchRoot, "ab-main-plain");
    const mMain = materialise(mainSha, abDir, sourceRepo);
    // v1.3: an absent main tree must not crash the run (it is exactly
    // the stale-store case the broadened bootstrap now prevents; if it
    // still happens, main counts as fully mismatched for the A/B).
    let mainEntries = null;
    try { mainEntries = listTree(mainSha, sourceRepo); } catch { /* absent: A/B below */ }
    const integMain = mainEntries
      ? verifyTreeIntegrity(mainEntries, abDir)
      : { ok: false, files: 0, mismatchCount: 0, zeroFilled: 0 };
    const environmental = !integMain.ok && integMain.zeroFilled > 0 === integ.zeroFilled > 0;
    checks[checks.length - 1].verdict = environmental ? "ENVIRONMENTAL" : "FAIL";
    checks[checks.length - 1].detail +=
      `; A/B pristine main ${mainSha.slice(0, 12)}: ${integMain.mismatchCount}/${integMain.files} mismatch ` +
      `(${integMain.zeroFilled} zero-filled) => ${environmental
        ? "ENVIRONMENTAL (EPERM write-fault episode signature: extraction writes refused; identical at pristine main)"
        : "NOT reproduced at main — treated as FAIL"}`;
    for (const [n, k] of [
      ["affected-selection", "selection"], ["affected-tests", "test"],
      ["verify-preflight", "preflight"], ["check-ci1", "check"],
      ["registration-sweep", "sweep"],
    ]) push(n, k, "NOT-APPLICABLE", 0, "blocked: tree materialisation did not verify");
    return finish();
  }

  // --- scratch git repo (base + head commits) -------------------------
  const { repoDir, localBase } = buildScratchRepo({
    scratchRoot, baseSha, headSha, sourceRepo, env,
  });

  // lazy pristine-main plain tree for A/B re-runs
  let mainDir = null;
  const getMainDir = () => {
    if (opts.noAb) return null;
    if (!mainDir) {
      mainDir = join(scratchRoot, "main-plain");
      const m = materialise(mainSha, mainDir, sourceRepo);
      // v1.3: guard the deferred listTree(mainSha) — this uncaught call
      // was the PR #4900 crash site. Absent main tree ⇒ A/B unavailable,
      // which abOrFail already reports as a named FAIL detail.
      let im = { ok: false };
      try { im = verifyTreeIntegrity(listTree(mainSha, sourceRepo), mainDir); } catch { /* A/B unavailable */ }
      if (m.status !== 0 || !im.ok) { mainDir = null; return null; }
    }
    return mainDir;
  };
  const abOrFail = (name, kind, wallMs, detail, headFail, rerunAtMain) => {
    const md = getMainDir();
    if (!md) { push(name, kind, "FAIL", wallMs, `${detail}; A/B unavailable (main tree could not materialise)`); return; }
    const mainFail = rerunAtMain(md);
    const verdict = classifyAB(headFail, mainFail);
    push(name, kind, verdict, wallMs,
      verdict === "ENVIRONMENTAL"
        ? `${detail}; A/B: identical failure at pristine main ${mainSha.slice(0, 12)} => ENVIRONMENTAL`
        : `${detail}; A/B: not reproduced identically at pristine main => FAIL`);
  };

  // --- affected selection (repo's own logic, invoked) -----------------
  let selected = [];
  const vaPath = join(repoDir, "scripts/verify-affected.mjs");
  if (!existsSync(vaPath)) {
    push("affected-selection", "selection", "NOT-APPLICABLE", 0, "scripts/verify-affected.mjs absent in tree");
  } else {
    const sel = run(process.execPath,
      [vaPath, "--json", `--base=${localBase}`, `--budget=${opts.budgetSec}`],
      { cwd: repoDir, timeoutMs: 300_000, env });
    try {
      const parsed = JSON.parse(sel.stdout.slice(sel.stdout.indexOf("{")) || "{}");
      selected = (parsed.selected ?? []).map((s) => s.test);
      push("affected-selection", "selection", "PASS", sel.wallMs,
        `${selected.length} test file(s) selected by verify-affected.mjs --json vs base; ` +
        `${(parsed.changed ?? []).length} changed file(s); smokeReasons: ${(parsed.smokeReasons ?? []).join("; ") || "none"}`);
    } catch {
      push("affected-selection", "selection", "FAIL", sel.wallMs,
        `verify-affected --json unparseable (exit ${sel.status}): ${tailOf(sel.stderr) || tailOf(sel.stdout)}`);
    }
  }

  // --- affected tests ---------------------------------------------------
  if (selected.length) {
    let aggWall = 0, fails = 0, envs = 0, passes = 0;
    for (const file of selected) {
      const r = runTestFile(repoDir, file, opts.timeoutMs, env);
      aggWall += r.wallMs;
      if (r.exit === 0) { passes++; push(`test:${file}`, "test", "PASS", r.wallMs, `${r.detail} [via ${r.via}]`); continue; }
      const before = checks.length;
      abOrFail(`test:${file}`, "test", r.wallMs, r.detail,
        { exit: r.exit, names: r.names },
        (md) => {
          const mr = run(process.execPath, ["--test", file], { cwd: md, timeoutMs: opts.timeoutMs, env });
          return { exit: mr.status ?? 1, names: parseTapFailures(`${mr.stdout}\n${mr.stderr}`) };
        });
      if (checks[before].verdict === "ENVIRONMENTAL") envs++; else fails++;
    }
    push("affected-tests", "test-summary",
      fails ? "FAIL" : "PASS", aggWall,
      `${selected.length} file(s): ${passes} pass, ${fails} fail, ${envs} environmental`);
  }

  // --- verify-preflight -------------------------------------------------
  const pfPath = join(repoDir, "scripts/verify-preflight.mjs");
  if (!existsSync(pfPath)) {
    push("verify-preflight", "preflight", "NOT-APPLICABLE", 0, "scripts/verify-preflight.mjs absent in tree");
  } else {
    const pf = run(process.execPath, [pfPath], { cwd: repoDir, timeoutMs: 300_000, env });
    if (pf.status === 0) push("verify-preflight", "preflight", "PASS", pf.wallMs, "exit 0");
    else abOrFail("verify-preflight", "preflight", pf.wallMs,
      `exit ${pf.status}: ${tailOf(pf.stderr) || tailOf(pf.stdout)}`,
      { exit: pf.status },
      (md) => ({ exit: run(process.execPath, [join(md, "scripts/verify-preflight.mjs")], { cwd: md, timeoutMs: 300_000, env }).status ?? 1 }));
  }

  // --- CI=1 check.mjs (secret scan + generation freshness + drift) -----
  const chkPath = join(repoDir, "scripts/check.mjs");
  if (!existsSync(chkPath)) {
    push("check-ci1", "check", "NOT-APPLICABLE", 0, "scripts/check.mjs absent in tree");
  } else {
    const ck = run(process.execPath, [chkPath],
      { cwd: repoDir, timeoutMs: opts.checkTimeoutMs, env: { ...env, CI: "1" } });
    if (ck.status === 0) push("check-ci1", "check", "PASS", ck.wallMs,
      "CI=1 scripts/check.mjs exit 0 (syntax, freshness gates, secret scan, open-routes, drift test)");
    else abOrFail("check-ci1", "check", ck.wallMs,
      `CI=1 scripts/check.mjs exit ${ck.status}: ${tailOf(ck.stderr) || tailOf(ck.stdout)}`,
      { exit: ck.status },
      (md) => ({ exit: run(process.execPath, [join(md, "scripts/check.mjs")], { cwd: md, timeoutMs: opts.checkTimeoutMs, env: { ...env, CI: "1" } }).status ?? 1 }));
  }

  // --- registration sweep ------------------------------------------------
  if (!existsSync(opts.sweep)) {
    push("registration-sweep", "sweep", "NOT-APPLICABLE", 0, `sweep tool absent at ${opts.sweep}`);
  } else {
    const sw = run(process.execPath,
      [opts.sweep, "--range", `${localBase}..HEAD`, "--repo-dir", repoDir, "--json"],
      { timeoutMs: opts.checkTimeoutMs, env });
    if (sw.status === 0) push("registration-sweep", "sweep", "PASS", sw.wallMs, "no MISSING items");
    else if (sw.status === 1) push("registration-sweep", "sweep", "FAIL", sw.wallMs,
      `MISSING registration item(s): ${tailOf(sw.stdout, 600) || tailOf(sw.stderr, 600)}`);
    else push("registration-sweep", "sweep", "NOT-APPLICABLE", sw.wallMs,
      `sweep exit ${sw.status} (NON-CONVERGED / tool-side; claims no verdict): ${tailOf(sw.stderr) || tailOf(sw.stdout)}`);
  }

  return finish();
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      if (err instanceof RateLimitStop) {
        console.error(`verify-local: STOP (GitHub rate limit): ${err.message}`);
        process.exitCode = 2;
      } else if (err instanceof ToolDefect) {
        console.error(`verify-local: tool defect: ${err.message}`);
        process.exitCode = 2;
      } else {
        console.error(`verify-local: crash: ${err?.stack ?? err}`);
        process.exitCode = 2;
      }
    },
  );
}
