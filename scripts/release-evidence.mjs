// Compact release-evidence manifest built only from actual results.
// Skipped tests are never labeled passed, a dirty candidate tree is never
// labeled clean, and live state is never labeled live without a matching digest.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute, sep, join } from "node:path";

export function parseTapSummary(text) {
  const counts = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  for (const raw of text.split("\n")) {
    const m = /^[#ℹ]\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/.exec(raw.trim());
    if (m) counts[m[1]] = Number(m[2]);
  }
  return counts;
}

export function suiteLabel(counts) {
  if (counts.fail > 0 || counts.cancelled > 0) return "failed";
  if (counts.skipped > 0 || counts.todo > 0) return "passed-with-skips";
  if (counts.tests > 0 && counts.pass === counts.tests) return "passed";
  return "incomplete";
}

export function candidateState(porcelain) {
  return porcelain.trim() === "" ? "clean" : "dirty";
}

export function liveState(probes) {
  if (!Array.isArray(probes) || probes.length === 0) return "unverified";
  let missingDigest = false;
  for (const probe of probes) {
    if (!probe || probe.status !== 200) return "mismatch";
    const expected = probe.expectedSha256;
    if (typeof expected !== "string" || expected.length === 0) {
      missingDigest = true;
      continue;
    }
    if (expected !== probe.actualSha256) return "mismatch";
  }
  return missingDigest ? "unverified" : "live";
}

export function buildManifest({ commit, tapText, porcelain, probes }) {
  const counts = parseTapSummary(tapText);
  return {
    commit,
    sourceBinding: "unverified_import",
    candidate: candidateState(porcelain),
    suite: { ...counts, label: suiteLabel(counts) },
    live: liveState(probes),
  };
}

// A local run with no probes is not a deploy proof, so it can still succeed.
// Once probes are supplied, only a live label may exit 0.
export function cliExitCode(manifest, { probesProvided = false } = {}) {
  if (!manifest || manifest.suite?.label !== "passed" || manifest.candidate !== "clean") return 1;
  if (probesProvided && manifest.live !== "live") return 1;
  return 0;
}

const digest = value => createHash("sha256").update(value).digest("hex");
// Git overrides must not make an observation describe a different checkout.
const observedGit = args => execFileSync("git", args, { encoding: "utf8",
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) }).trim();
function sourceSnapshot() {
  return { commit: observedGit(["rev-parse", "HEAD"]), tree: observedGit(["rev-parse", "HEAD^{tree}"]),
    clean: observedGit(["status", "--porcelain", "--untracked-files=all"]) === "" };
}

// A local attestation, not a signature or hermetic-build guarantee. Neither
// imported logs nor a passing TAP footer establish which source was executed.
export function recordedOutcome({ before, after, exitCode, signal, interruption }) {
  if (interruption || signal || exitCode !== 0) return "failed";
  if (!before?.clean || !after?.clean || before.commit !== after.commit || before.tree !== after.tree) return "source_changed_or_dirty";
  return "passed";
}

async function recordRun(argv) {
  const divider = argv.indexOf("--");
  if (divider < 0) throw new Error("Use --record NEW_DIRECTORY [--timeout-ms N] -- COMMAND ARGS");
  const options = argv.slice(0, divider), command = argv.slice(divider + 1);
  if (!command.length || options[0] !== "--record" || !options[1]
    || ![2, 4].includes(options.length) || (options.length === 4 && options[2] !== "--timeout-ms")) throw new Error("Invalid record arguments");
  const timeoutMs = options.length === 4 ? Number(options[3]) : 1800000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3600000) throw new Error("Invalid timeout");
  if (process.platform === "win32") throw new Error("Recorded execution requires POSIX process groups");
  const cwd = realpathSync(process.cwd());
  const output = resolve(options[1]);
  const parent = realpathSync(resolve(output, ".."));
  const root = realpathSync(observedGit(["rev-parse", "--show-toplevel"]));
  const rel = relative(root, parent);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) throw new Error("Store evidence outside the checkout");
  const before = sourceSnapshot();
  if (!before.clean) throw new Error("Record from a clean committed candidate");
  mkdirSync(output, { mode: 0o700 }); // Exclusive: never overwrite an earlier attempt.
  const reportPath = join(output, "evidence.json");
  const report = { schemaVersion: 2, status: "running", cwd, before, startedAt: new Date().toISOString(),
    commandDigest: digest(JSON.stringify(command)), // Do not publish credential-bearing arguments.
    recorderSha256: digest(readFileSync(new URL(import.meta.url))),
    toolchain: { node: process.version, platform: process.platform, arch: process.arch,
      git: observedGit(["--version"]) },
    environment: "inherited_not_recorded", sourceBinding: "pending",
    limitations: ["Local unsigned evidence; dependencies and environment are not hermetic.",
      "Before/after snapshots do not detect transient source edits reverted during execution.",
      "A running receipt after recorder interruption is unresolved, not permission to retry a write."] };
  const persist = () => { writeFileSync(reportPath + ".tmp", JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); renameSync(reportPath + ".tmp", reportPath); };
  persist();
  const chunks = [], maxBytes = 16 * 1024 * 1024;
  let size = 0, interruption = null, forceClose, finish, cleanupUnresolved = false;
  const started = performance.now();
  const child = spawn(command[0], command.slice(1), { cwd, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const stop = reason => {
    interruption ??= reason;
    if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ }
    forceClose ??= setTimeout(() => {
      cleanupUnresolved = true;
      child.stdout.destroy(); child.stderr.destroy();
      finish({ exitCode: child.exitCode, signal: child.signalCode });
    }, 250);
  };
  const onTerm = () => stop("SIGTERM"), onInt = () => stop("SIGINT");
  process.on("SIGTERM", onTerm); process.on("SIGINT", onInt);
  const collect = chunk => {
    const remaining = Math.max(0, maxBytes - size);
    if (remaining) chunks.push(chunk.subarray(0, remaining));
    size += chunk.length;
    if (size > maxBytes) stop("output_limit");
  };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  const result = await new Promise(done => {
    finish = done;
    child.once("error", () => { interruption ??= "spawn_error"; });
    child.once("close", (exitCode, signal) => done({ exitCode, signal }));
  });
  clearTimeout(timer); clearTimeout(forceClose); process.off("SIGTERM", onTerm); process.off("SIGINT", onInt);
  const log = Buffer.concat(chunks);
  writeFileSync(join(output, "run.log"), log, { mode: 0o600 });
  let after = null;
  try { after = sourceSnapshot(); } catch { interruption ??= "source_unavailable"; }
  Object.assign(report, { after, ...result, interruption, cleanupUnresolved, finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started), logSha256: digest(log), logTruncated: size > maxBytes,
    sourceBinding: before.clean && after?.clean && before.commit === after.commit && before.tree === after.tree ? "observed_unchanged" : "unverified",
    status: recordedOutcome({ before, after, ...result, interruption }),
    suite: { ...parseTapSummary(log.toString("utf8")), label: suiteLabel(parseTapSummary(log.toString("utf8"))) } });
  persist();
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "passed") process.exitCode = 1;
}

async function main(argv) {
  if (argv[0] === "--record") return recordRun(argv);
  const tapPath = argv[argv.indexOf("--tap") + 1] || null;
  const probesPath = argv.includes("--probes") ? argv[argv.indexOf("--probes") + 1] : null;
  if (!tapPath || argv.includes("--help")) {
    console.error("usage: node scripts/release-evidence.mjs --tap <tap-output-file> [--probes <probes.json>]\nImported logs have unverified source. To record actual execution:\nnode scripts/release-evidence.mjs --record NEW_DIRECTORY [--timeout-ms N] -- COMMAND ARGS\nUse a clean isolated checkout and output outside it. Logs stay private; inspect before sharing. An interrupted running receipt requires reconciliation, not automatic replay.");
    process.exit(2);
  }
  const tapText = readFileSync(tapPath, "utf8");
  const probes = probesPath ? JSON.parse(readFileSync(probesPath, "utf8")) : undefined;
  const git = args => execFileSync("git", args, { encoding: "utf8" });
  const commit = git(["rev-parse", "HEAD"]).trim();
  const porcelain = git(["status", "--porcelain"]);
  const manifest = buildManifest({ commit, tapText, porcelain, probes });
  console.log(JSON.stringify(manifest, null, 2));
  const code = cliExitCode(manifest, { probesProvided: Boolean(probesPath) });
  if (code !== 0) process.exit(code);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await main(process.argv.slice(2)).catch(() => { console.error("Could not collect release evidence; inspect arguments, checkout and private output directory."); process.exitCode = 2; });
}
