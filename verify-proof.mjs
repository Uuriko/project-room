#!/usr/bin/env node
// verify-proof.mjs — verifier for proof bundles (proof-bundle-spec.md).
// v1.1 (2026-10-28, MERGE-DEPLOY-TOOLS wave, lane M1-04): schema
//   reconciliation. Accepts bundleVersion "1.0" AND "1.1" and validates
//   check kinds against the taxonomy of the bundle's own version — spec
//   1.1 adds kinds materialisation|selection|test|preflight (the real
//   check classes verify-local runs) to the 1.0 set
//   suite|sweep|secret-scan|generation; a 1.0 bundle carrying a 1.1-only
//   kind is still invalid. `pr` is optional in 1.1 (sha-targeted
//   bundles): absent/null is shape-valid but VOID online with reason
//   "no pr to bind against" (no API read spent). Self-test extended to
//   13 cases. No other behaviour change: binding, tallies, exit codes
//   and the single-read rule are exactly v1.0's.
// v1.0 (2026-10-28, MERGE-DEPLOY-TOOLS wave, lane M1-02).
//
// Validates a proof bundle in seconds:
//   1. schema: every required field, type, enum, and shape rule of
//      proof-bundle-spec.md §2–§3 (bundleVersion "1.0" or "1.1", full
//      40-char lowercase hex SHAs, unique check names, evidence present,
//      finishedAt >= startedAt);
//   2. binding (online mode only): exactly ONE API read — a single
//      GraphQL request fetching the PR's current headRefOid and that
//      commit's tree oid — compared against the bundle's commitSha /
//      treeSha. Any mismatch = VOID, with the reason printed (spec B2/B3).
//      No other network use. A 403/429 from the API is reported as a tool
//      defect (exit 2) and never retried through another route.
//   3. tally: per-verdict counts; ENVIRONMENTAL checks are listed by name
//      as the bundle's uncertified set (spec B5) — they never certify
//      the check either way.
//
// Exit codes (spec §6):
//   0 = VALID (binding confirmed, >= 1 PASS, no FAIL) — under --offline,
//       SHAPE-VALID under the same check conditions, binding NOT checked
//       and the output says so.
//   1 = FAIL or VOID (schema invalid, binding mismatch, any check FAIL,
//       or nothing certified).
//   2 = tool defect (unreadable input, gh unavailable, API read error,
//       internal error): the bundle was not judged.
//
// Usage:
//   node verify-proof.mjs <bundle.json> [--offline] [--repo owner/name] [--json]
//   node verify-proof.mjs --self-test     (offline unit checks, no network)
//
// Spec: ~/workspace/fleet-tools/proof-bundle-spec.md
// Tests: verify-proof.test.mjs.

import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";

export const VERIFY_PROOF_VERSION = "1.1";
export const SUPPORTED_BUNDLE_VERSIONS = ["1.0", "1.1"];
const DEFAULT_REPO = "Uuriko/project-room";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// Per-version kind taxonomies (spec §3/§3.1): a bundle is validated
// against ITS OWN version's set — 1.1 kinds are not retroactively legal
// in a 1.0 bundle.
export const KINDS_BY_VERSION = {
  "1.0": new Set(["suite", "sweep", "secret-scan", "generation"]),
  "1.1": new Set([
    "suite", "sweep", "secret-scan", "generation",
    "materialisation", "selection", "test", "preflight",
  ]),
};
const VERDICTS = new Set(["PASS", "FAIL", "NOT-APPLICABLE", "ENVIRONMENTAL"]);

export function validateBundle(bundle) {
  const problems = [];
  const err = (m) => problems.push(m);
  if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle)) {
    return ["bundle root is not a JSON object"];
  }
  if (!SUPPORTED_BUNDLE_VERSIONS.includes(bundle.bundleVersion)) {
    err(`bundleVersion must be one of ${SUPPORTED_BUNDLE_VERSIONS.map((v) => `"${v}"`).join(", ")}, got ${JSON.stringify(bundle.bundleVersion)}`);
  }
  const kinds = KINDS_BY_VERSION[bundle.bundleVersion] ?? KINDS_BY_VERSION["1.1"];
  for (const f of ["treeSha", "commitSha", "baseSha"]) {
    if (typeof bundle[f] !== "string" || !SHA40.test(bundle[f])) {
      err(`${f} must be a full 40-char lowercase hex SHA, got ${JSON.stringify(bundle[f])}`);
    }
  }
  // pr: 1.0 required it; 1.1 makes it optional (absent/null = a
  // sha-targeted bundle with nothing to bind against online, spec §2).
  if (bundle.pr !== undefined && bundle.pr !== null) {
    if (!Number.isInteger(bundle.pr) || bundle.pr < 1) {
      err(`pr must be an integer >= 1, got ${JSON.stringify(bundle.pr)}`);
    }
  } else if (bundle.bundleVersion === "1.0") {
    err(`pr must be an integer >= 1, got ${JSON.stringify(bundle.pr)}`);
  }
  const pb = bundle.producedBy;
  if (pb === null || typeof pb !== "object" || Array.isArray(pb)) {
    err("producedBy must be an object {tool, toolVersion, host}");
  } else {
    for (const f of ["tool", "toolVersion", "host"]) {
      if (typeof pb[f] !== "string" || pb[f].length === 0) {
        err(`producedBy.${f} must be a non-empty string`);
      }
    }
  }
  const ts = {};
  for (const f of ["startedAt", "finishedAt"]) {
    const v = bundle[f];
    if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
      err(`${f} must be an ISO-8601 timestamp string, got ${JSON.stringify(v)}`);
    } else ts[f] = Date.parse(v);
  }
  if (ts.startedAt !== undefined && ts.finishedAt !== undefined && ts.finishedAt < ts.startedAt) {
    err("finishedAt is before startedAt");
  }
  if (!Array.isArray(bundle.checks) || bundle.checks.length < 1) {
    err("checks must be an array with at least one entry");
  } else {
    const seen = new Set();
    bundle.checks.forEach((c, i) => {
      const at = `checks[${i}]`;
      if (c === null || typeof c !== "object" || Array.isArray(c)) {
        err(`${at} is not an object`);
        return;
      }
      if (typeof c.name !== "string" || c.name.length === 0) {
        err(`${at}.name must be a non-empty string`);
      } else if (seen.has(c.name)) {
        err(`${at}.name ${JSON.stringify(c.name)} duplicates an earlier check name`);
      } else seen.add(c.name);
      if (!kinds.has(c.kind)) {
        err(`${at}.kind must be one of ${[...kinds].join("|")} (bundleVersion ${JSON.stringify(bundle.bundleVersion)}), got ${JSON.stringify(c.kind)}`);
      }
      if (!VERDICTS.has(c.verdict)) {
        err(`${at}.verdict must be one of ${[...VERDICTS].join("|")}, got ${JSON.stringify(c.verdict)}`);
      }
      if (typeof c.wallMs !== "number" || !Number.isFinite(c.wallMs) || c.wallMs < 0) {
        err(`${at}.wallMs must be a number >= 0, got ${JSON.stringify(c.wallMs)}`);
      }
      const ev = c.evidence;
      if (typeof ev === "string") {
        if (ev.length === 0) err(`${at}.evidence must be a non-empty string or an object`);
      } else if (ev !== null && typeof ev === "object" && !Array.isArray(ev)) {
        const has = ["path", "note"].some((k) => typeof ev[k] === "string" && ev[k].length > 0)
          || (typeof ev.sha256 === "string" && SHA256.test(ev.sha256));
        if (!has) err(`${at}.evidence object must carry at least one of path / note / sha256 (64-hex)`);
        if (ev.sha256 !== undefined && !(typeof ev.sha256 === "string" && SHA256.test(ev.sha256))) {
          err(`${at}.evidence.sha256 must be 64-char lowercase hex`);
        }
      } else {
        err(`${at}.evidence is required (string or object)`);
      }
    });
  }
  return problems;
}

export function tallyChecks(checks) {
  const tally = { PASS: 0, FAIL: 0, "NOT-APPLICABLE": 0, ENVIRONMENTAL: 0 };
  const uncertified = [];
  for (const c of checks) {
    if (Object.hasOwn(tally, c.verdict)) tally[c.verdict] += 1;
    if (c.verdict === "ENVIRONMENTAL") uncertified.push(c.name);
  }
  return { tally, uncertified };
}

// The single permitted API read: one GraphQL request returning the PR's
// current head commit oid and that commit's tree oid.
export function readPrHead(repo, pr) {
  const [owner, name] = repo.split("/");
  const query = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){headRefOid headRef{target{... on Commit{tree{oid}}}}}}}`;
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `pr=${pr}`],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message || "").trim();
          const e = new Error(`API head read failed for ${repo}#${pr}: ${detail}`);
          e.code = "EAPIREAD";
          reject(e);
          return;
        }
        try {
          const data = JSON.parse(stdout);
          const prNode = data?.data?.repository?.pullRequest;
          if (!prNode?.headRefOid) throw new Error("response carries no headRefOid");
          resolve({
            headCommitSha: prNode.headRefOid,
            headTreeSha: prNode.headRef?.target?.tree?.oid ?? null,
          });
        } catch (parseErr) {
          const e = new Error(`API head read for ${repo}#${pr} returned an unusable response: ${parseErr.message}`);
          e.code = "EAPIREAD";
          reject(e);
        }
      },
    );
  });
}

export async function verifyBundle(bundle, { offline = false, repo = DEFAULT_REPO, readHead = readPrHead } = {}) {
  const problems = validateBundle(bundle);
  const result = {
    tool: "verify-proof",
    toolVersion: VERIFY_PROOF_VERSION,
    mode: offline ? "offline (shape only — binding NOT checked)" : "online",
    repo,
    pr: bundle?.pr ?? null,
    bundleVersion: bundle?.bundleVersion ?? null,
    commitSha: bundle?.commitSha ?? null,
    treeSha: bundle?.treeSha ?? null,
    schemaProblems: problems,
    tally: null,
    uncertified: [],
    binding: null,
    status: null,
    reasons: [],
  };
  if (problems.length > 0) {
    result.status = "VOID";
    result.reasons.push("schema invalid — see schemaProblems");
    result.exitCode = 1;
    return result;
  }
  const { tally, uncertified } = tallyChecks(bundle.checks);
  result.tally = tally;
  result.uncertified = uncertified;

  if (!offline) {
    if (!Number.isInteger(bundle.pr)) {
      // Sha-targeted bundle (spec 1.1 §2): shape is fine but there is no
      // PR head to bind against, so online it certifies nothing. No API
      // read is spent.
      result.status = "VOID";
      result.reasons.push("no pr to bind against (sha-targeted bundle; binding requires a PR head read)");
      result.exitCode = 1;
      return result;
    }
    const head = await readHead(repo, bundle.pr); // throws -> caller maps to exit 2
    const commitMatch = head.headCommitSha === bundle.commitSha;
    const treeMatch = head.headTreeSha === bundle.treeSha;
    result.binding = {
      liveHeadCommitSha: head.headCommitSha,
      liveHeadTreeSha: head.headTreeSha,
      commitMatch,
      treeMatch,
    };
    if (!commitMatch || !treeMatch) {
      result.status = "VOID";
      if (!commitMatch) result.reasons.push(`head moved: bundle commitSha ${bundle.commitSha} != live head ${head.headCommitSha}`);
      if (!treeMatch) result.reasons.push(`tree mismatch: bundle treeSha ${bundle.treeSha} != live head tree ${head.headTreeSha}`);
      result.exitCode = 1;
      return result;
    }
  }

  if (tally.FAIL > 0) {
    result.status = "FAIL";
    result.reasons.push(`${tally.FAIL} check(s) FAIL`);
    result.exitCode = 1;
  } else if (tally.PASS === 0) {
    result.status = offline ? "SHAPE-VALID-BUT-UNCERTIFIED" : "UNCERTIFIED";
    result.reasons.push("no PASS check — the bundle certifies nothing");
    result.exitCode = 1;
  } else {
    result.status = offline ? "SHAPE-VALID" : "VALID";
    result.exitCode = 0;
  }
  if (uncertified.length > 0) {
    result.reasons.push(`uncertified (ENVIRONMENTAL, certify neither way): ${uncertified.join(", ")}`);
  }
  return result;
}

function printHuman(r) {
  const lines = [];
  if (r.mode.startsWith("offline")) {
    lines.push("OFFLINE MODE: shape-only verification — binding NOT checked; this result is NOT a certification.");
  }
  lines.push(`verify-proof v${r.toolVersion} — ${r.mode} — ${r.repo}#${r.pr}`);
  lines.push(`bundle: version=${r.bundleVersion} commit=${r.commitSha} tree=${r.treeSha}`);
  if (r.schemaProblems.length > 0) {
    lines.push("schema problems:");
    for (const p of r.schemaProblems) lines.push(`  - ${p}`);
  }
  if (r.binding) {
    lines.push(`binding: live head commit=${r.binding.liveHeadCommitSha} tree=${r.binding.liveHeadTreeSha} commitMatch=${r.binding.commitMatch} treeMatch=${r.binding.treeMatch}`);
  }
  if (r.tally) {
    lines.push(`tally: PASS=${r.tally.PASS} FAIL=${r.tally.FAIL} NOT-APPLICABLE=${r.tally["NOT-APPLICABLE"]} ENVIRONMENTAL=${r.tally.ENVIRONMENTAL}`);
  }
  if (r.uncertified.length > 0) {
    lines.push(`uncertified checks (ENVIRONMENTAL — certify neither way): ${r.uncertified.join(", ")}`);
  } else if (r.tally) {
    lines.push("uncertified checks: none");
  }
  lines.push(`STATUS: ${r.status} (exit ${r.exitCode})`);
  for (const reason of r.reasons) lines.push(`  reason: ${reason}`);
  return lines.join("\n");
}

function selfTest() {
  const base = {
    bundleVersion: "1.0",
    treeSha: "a".repeat(40),
    commitSha: "b".repeat(40),
    baseSha: "c".repeat(40),
    pr: 5098,
    producedBy: { tool: "self-test", toolVersion: "0", host: "local" },
    startedAt: "2026-10-29T00:00:00Z",
    finishedAt: "2026-10-29T00:01:00Z",
    checks: [{ name: "x", kind: "suite", verdict: "PASS", wallMs: 1, evidence: "log" }],
  };
  const v11 = {
    ...base,
    bundleVersion: "1.1",
    checks: [
      { name: "materialise", kind: "materialisation", verdict: "PASS", wallMs: 1, evidence: "3876 blobs hash-verified" },
      { name: "affected-selection", kind: "selection", verdict: "PASS", wallMs: 1, evidence: "3 files selected" },
      { name: "test:a.test.js", kind: "test", verdict: "PASS", wallMs: 1, evidence: "node --test exit 0" },
      { name: "verify-preflight", kind: "preflight", verdict: "PASS", wallMs: 1, evidence: "exit 0" },
    ],
  };
  const cases = [
    ["valid base (1.0) has no problems", validateBundle(base).length === 0],
    ["short treeSha rejected", validateBundle({ ...base, treeSha: "abc" }).length > 0],
    ["wrong bundleVersion rejected", validateBundle({ ...base, bundleVersion: "9.9" }).length > 0],
    ["duplicate check names rejected", validateBundle({ ...base, checks: [base.checks[0], base.checks[0]] }).length > 0],
    ["missing evidence rejected", validateBundle({ ...base, checks: [{ ...base.checks[0], evidence: undefined }] }).length > 0],
    ["finishedAt before startedAt rejected", validateBundle({ ...base, finishedAt: "2026-10-28T00:00:00Z" }).length > 0],
    ["bad kind rejected", validateBundle({ ...base, checks: [{ ...base.checks[0], kind: "lint" }] }).length > 0],
    ["v1.1 bundle with the four new kinds validates clean", validateBundle(v11).length === 0],
    ["1.1-only kind inside a 1.0 bundle rejected", validateBundle({ ...base, checks: [{ ...base.checks[0], kind: "materialisation" }] }).length > 0],
    ["v1.1 sha-targeted bundle (pr absent) validates clean", validateBundle({ ...v11, pr: undefined }).length === 0],
    ["v1.0 bundle without pr rejected", validateBundle({ ...base, pr: undefined }).length > 0],
    ["bundleVersion 1.1 accepted", validateBundle({ ...base, bundleVersion: "1.1" }).length === 0],
    ["bundleVersion 2.0 rejected", validateBundle({ ...base, bundleVersion: "2.0" }).length > 0],
  ];
  let failed = 0;
  for (const [name, ok] of cases) {
    console.log(`${ok ? "ok" : "NOT OK"} — ${name}`);
    if (!ok) failed += 1;
  }
  return failed === 0 ? 0 : 2;
}

async function main(argv) {
  const args = [...argv];
  if (args.includes("--self-test")) return selfTest();
  let offline = false;
  let json = false;
  let repo = DEFAULT_REPO;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--offline") offline = true;
    else if (a === "--json") json = true;
    else if (a === "--repo") { repo = args[i + 1]; i += 1; if (!repo) throw new Error("--repo needs a value"); }
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) {
    console.error("usage: node verify-proof.mjs <bundle.json> [--offline] [--repo owner/name] [--json]");
    return 2;
  }
  let raw;
  try {
    raw = readFileSync(positional[0], "utf8");
  } catch (e) {
    console.error(`tool defect: cannot read bundle file ${positional[0]}: ${e.message}`);
    return 2;
  }
  let bundle;
  try {
    bundle = JSON.parse(raw);
  } catch (e) {
    // Unparseable JSON is a judged bundle: schema-invalid, hence VOID.
    const r = { tool: "verify-proof", toolVersion: VERIFY_PROOF_VERSION, mode: offline ? "offline" : "online", repo, pr: null, bundleVersion: null, commitSha: null, treeSha: null, schemaProblems: [`bundle file is not valid JSON: ${e.message}`], tally: null, uncertified: [], binding: null, status: "VOID", reasons: ["schema invalid — see schemaProblems"], exitCode: 1 };
    console.log(json ? JSON.stringify(r, null, 2) : printHuman(r));
    return 1;
  }
  let result;
  try {
    result = await verifyBundle(bundle, { offline, repo });
  } catch (e) {
    console.error(`tool defect: ${e.message}`);
    return 2;
  }
  console.log(json ? JSON.stringify(result, null, 2) : printHuman(result));
  return result.exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { console.error(`tool defect: ${e?.stack ?? e}`); process.exitCode = 2; },
  );
}
