// Pre-deploy onboarding gate (ACT-5b). Runs the probe against staging, then
// compares it with docs/onboarding-probe/baseline.json through gate.mjs.
//
//   node scripts/onboarding-probe/predeploy.mjs --target staging \
//     [--sha <40-hex>] [--runs 3] [--out probe-out] [--override "<reason>"]
//
// --target   "staging" (ROOM_STAGING_ORIGIN, else the checked-in staging
//            origin) or an explicit https origin.
// --sha      wait until the target's /api/version reports this commit before
//            probing, so the run measures the build about to ship.
// --override record a reason and exit 0 even when the gate fails. A blank
//            reason is refused.
//
// Exit 0 when the gate passes (or is overridden), 1 when it fails. The verdict
// is written to <out>/predeploy.json and, in Actions, to the job summary and
// the step outputs `verdict` and `override`.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateGate } from "./gate.mjs";

export const DEFAULT_STAGING_ORIGIN = "https://project-room-stage.getdasha.workers.dev";
const RUNNER = fileURLToPath(new URL("./run.mjs", import.meta.url));
const BASELINE = fileURLToPath(new URL("../../docs/onboarding-probe/baseline.json", import.meta.url));

export function resolveTarget(target, env = process.env) {
  const value = String(target ?? "").trim();
  if (!value || value === "staging") return (env.ROOM_STAGING_ORIGIN || DEFAULT_STAGING_ORIGIN).replace(/\/$/, "");
  if (!/^https?:\/\//.test(value)) throw new Error(`target must be "staging" or an http(s) origin, got ${value}`);
  return value.replace(/\/$/, "");
}

export function parseArgs(argv) {
  const out = { target: "staging", sha: null, runs: 3, outDir: "probe-out", override: null, runner: RUNNER, waitMs: 600_000 };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    const value = argv[i + 1];
    const take = () => { i++; if (value === undefined) throw new Error(`${name} needs a value`); return value; };
    if (name === "--target") out.target = take();
    else if (name === "--sha") out.sha = take();
    else if (name === "--runs") out.runs = Number(take());
    else if (name === "--out") out.outDir = take();
    else if (name === "--override") out.override = take();
    else if (name === "--runner") out.runner = take();
    else if (name === "--wait-ms") out.waitMs = Number(take());
    else throw new Error(`unknown flag ${name}`);
  }
  if (out.override !== null && !out.override.trim()) throw new Error("--override needs a reason");
  if (out.sha !== null && !/^[0-9a-f]{40}$/.test(out.sha)) throw new Error("--sha must be a full 40-character lowercase hex commit");
  if (!Number.isInteger(out.runs) || out.runs < 1 || out.runs > 10) throw new Error("--runs must be 1-10");
  return out;
}

async function readVersion(origin) {
  try {
    const response = await fetch(`${origin}/api/version`, { headers: { "user-agent": "project-room-onboarding-probe/predeploy" } });
    if (!response.ok) return null;
    return (await response.json())?.sourceRevision ?? null;
  } catch {
    return null;
  }
}

export async function waitForSha(origin, sha, { waitMs = 600_000, intervalMs = 15_000, fetchVersion = readVersion, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now } = {}) {
  const deadline = now() + waitMs;
  let seen = await fetchVersion(origin);
  while (seen !== sha && now() < deadline) {
    await sleep(intervalMs);
    seen = await fetchVersion(origin);
  }
  return { ok: seen === sha, seen };
}

export function runProbeProcess({ runner, origin, runs, outDir, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, "--target", origin, "--runs", String(runs), "--out", outDir], { stdio: ["ignore", "inherit", "inherit"], env });
    child.on("error", reject);
    child.on("exit", code => {
      if (code !== 0) return reject(new Error(`probe runner exited ${code}`));
      try { resolve(JSON.parse(readFileSync(join(outDir, "probe-result.json"), "utf8"))); }
      catch (error) { reject(new Error(`probe runner wrote no readable probe-result.json: ${error.message}`)); }
    });
  });
}

// Pure decision core. The probe runner and version fetch are injected so the
// refusal can be proven without a live staging target.
export async function predeploy({ origin, sha = null, runs = 3, outDir = "probe-out", override = null, baseline, runProbe, waitForTarget = waitForSha, log = console.log }) {
  const record = { target: origin, sha, override, verdict: "fail", failures: [], improvements: [], inconclusive: [] };
  if (sha) {
    const at = await waitForTarget(origin, sha);
    if (!at.ok) record.failures.push({ path: "target", step: "version", reason: `target reports ${at.seen ? at.seen.slice(0, 12) : "no version"}, not ${sha.slice(0, 12)}` });
  }
  if (!record.failures.length) {
    let result = null;
    try { result = await runProbe({ origin, runs, outDir }); }
    catch (error) { record.failures.push({ path: "probe", step: "run", reason: error.message }); }
    if (result) {
      const list = Array.isArray(result.runs) && result.runs.length ? result.runs : [result];
      const verdict = evaluateGate(list, baseline, { inconclusive: result.ready?.inconclusive === true });
      record.failures.push(...verdict.failures);
      record.improvements = verdict.improvements;
      record.inconclusive = verdict.inconclusive;
    }
  }
  const passed = record.failures.length === 0;
  record.verdict = passed ? "pass" : override ? "overridden" : "fail";
  log(`onboarding predeploy gate: ${record.verdict} (${origin}${sha ? ` @ ${sha.slice(0, 8)}` : ""})`);
  for (const f of record.failures) log(`fail ${f.path} ${f.step} ${f.reason}`);
  for (const name of record.improvements) log(`improved ${name}`);
  if (record.inconclusive.length) log(`inconclusive: ${record.inconclusive.join(", ")}`);
  if (override) log(`override recorded: ${override}`);
  return { code: record.verdict === "fail" ? 1 : 0, record };
}

function emit(record) {
  const env = process.env;
  if (env.GITHUB_STEP_SUMMARY) {
    const lines = [`\n### Onboarding predeploy gate: ${record.verdict}`, "", `Target ${record.target}${record.sha ? ` at ${record.sha.slice(0, 8)}` : ""}.`];
    for (const f of record.failures) lines.push(`- fail ${f.path} ${f.step}: ${f.reason}`);
    if (record.override) lines.push(`- override: ${record.override}`);
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
  if (env.GITHUB_OUTPUT) {
    const override = (record.override ?? "").replace(/[\r\n]+/g, " ").slice(0, 300);
    appendFileSync(env.GITHUB_OUTPUT, `verdict=${record.verdict}\noverride=${override}\n`);
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`predeploy: ${error.message}`); process.exit(2); }
  const origin = resolveTarget(options.target);
  mkdirSync(options.outDir, { recursive: true });
  const { code, record } = await predeploy({
    origin,
    sha: options.sha,
    runs: options.runs,
    outDir: options.outDir,
    override: options.override,
    baseline: JSON.parse(readFileSync(BASELINE, "utf8")),
    runProbe: ({ origin: o, runs, outDir }) => runProbeProcess({ runner: options.runner, origin: o, runs, outDir }),
    waitForTarget: (o, sha) => waitForSha(o, sha, { waitMs: options.waitMs, intervalMs: Math.min(15_000, Math.max(100, options.waitMs / 10)) }),
  });
  writeFileSync(join(options.outDir, "predeploy.json"), `${JSON.stringify(record, null, 2)}\n`);
  emit(record);
  process.exit(code);
}
