// Explicit operator-local reproduction, not a sandbox or a scheduler. Room data
// never chooses an executable, checkout, script or test. Native agents may call
// this CLI only with the operator's fixed arguments; generic Mac hosts stay unsupported.
import { readFileSync, realpathSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { deriveBrowserSuites } from "./browser-suites.mjs";
import { hostSubprocess } from "../client/host-subprocess.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const line = value => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

export function classifyReproduction(stdout, exitCode, testName) {
  const lines = String(stdout).split(/\r?\n/);
  const pattern = new RegExp(`^(not )?ok \\d+ - ${escapePattern(testName)}(?: #.*)?$`);
  const rows = lines.filter(value => pattern.test(value));
  if (rows.length !== 1 || / #\s*(?:SKIP|TODO)\b/i.test(rows[0]) || !Number.isInteger(exitCode)) return "unknown";
  if (rows[0].startsWith("not ok ") && exitCode !== 0) return "failed";
  if (rows[0].startsWith("ok ") && exitCode === 0 && lines.includes("# fail 0") && lines.includes("# pass 1")) return "passed";
  return "unknown";
}

export async function runBrowserReproduction(options, { run = hostSubprocess, signal } = {}) {
  const { checkout, revision, tree, script, testName, node, git, out, packetId = null, packetSha256 = null, requestMessageId = null, workItemId = null, timeoutMs = 90000 } = options;
  if (![checkout, node, git, out].every(p => typeof p === "string" && p.length <= 1024 && isAbsolute(p)) || !sha(revision) || !sha(tree)
    || !line(testName) || [packetId, requestMessageId, workItemId].some(value => value !== null && !line(value))
    || (packetSha256 !== null && (typeof packetSha256 !== "string" || !/^[a-f0-9]{64}$/.test(packetSha256))) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000)
    throw new Error("Invalid operator reproduction configuration");
  if (realpathSync(checkout) !== checkout || realpathSync(node) !== node || realpathSync(git) !== git || resolve(out) !== out)
    throw new Error("Use canonical absolute operator paths");
  if (!deriveBrowserSuites(join(checkout, "scripts")).includes(script)) throw new Error("Script is not a registered browser suite");
  const scriptPath = join(checkout, script);
  if (realpathSync(scriptPath) !== scriptPath) throw new Error("Browser suite must not be a symlink");
  const source = readFileSync(scriptPath);
  // Deliberately do not inherit Room tokens, NODE_OPTIONS, test filters or CI
  // credentials. HOME permits an already-installed Playwright browser cache;
  // this operator-local mode does not promise network/filesystem isolation.
  const env = { PATH: "/usr/bin:/bin", ...(process.env.HOME ? { HOME: process.env.HOME } : {}) };
  const gitRead = async args => {
    const value = await run({ command: git, args: ["-c", "core.fsmonitor=false", ...args], timeoutMs: 10000 }, { cwd: checkout, env, maxBytes: 1048576, signal });
    if (value.exitCode !== 0) throw new Error("Source verification failed");
    return value.stdout.toString("utf8").trim();
  };
  const verify = async () => {
    if (await gitRead(["rev-parse", "HEAD"]) !== revision || await gitRead(["rev-parse", "HEAD^{tree}"]) !== tree
      || await gitRead(["status", "--porcelain", "--untracked-files=no"]) !== ""
      || await gitRead(["ls-files", "--error-unmatch", "--", script]) !== script)
      throw new Error("Checkout must be clean tracked source at the pinned revision and tree");
  };
  await verify();
  const nodeDigest = digest(readFileSync(node));
  const versionResult = await run({ command: node, args: ["--version"], timeoutMs: 10000 }, { cwd: checkout, env, maxBytes: 128, signal });
  const nodeVersion = versionResult.stdout.toString("utf8").trim();
  const version = /^v(\d+)\.(\d+)\.\d+$/.exec(nodeVersion);
  if (versionResult.exitCode !== 0 || !version || Number(version[1]) < 24 || Number(version[1]) === 24 && Number(version[2]) < 19)
    throw new Error("Explicit supported Node >=24.19 executable required");
  mkdirSync(out, { mode: 0o700 }); // exclusive: never overwrite an earlier attempt
  mkdirSync(join(checkout, ".tmp"), { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(checkout, ".tmp/reproduction-")); env.TMPDIR = temp;
  const startedAt = new Date().toISOString();
  let stdout = Buffer.alloc(0), exitCode = null, outcome = "unknown", reason = null;
  try {
    const result = await run({ command: node, args: ["--test", "--test-concurrency=1", "--test-reporter=tap", `--test-name-pattern=^${escapePattern(testName)}$`, script], timeoutMs },
      { cwd: checkout, env, maxBytes: 1048576, signal });
    stdout = result.stdout; exitCode = result.exitCode;
    outcome = classifyReproduction(stdout, exitCode, testName);
    if (outcome === "unknown") reason = "no_unambiguous_selected_test_result";
  } catch { reason = "child_incomplete_timeout_cancel_startup_or_output_limit"; }
  const observedOutcome = outcome;
  try { await verify(); if (digest(readFileSync(scriptPath)) !== digest(source) || digest(readFileSync(node)) !== nodeDigest) throw new Error("changed"); }
  catch { outcome = "unknown"; reason = "source_or_executable_changed_or_unverifiable"; }
  rmSync(temp, { recursive: true, force: true });
  writeFileSync(join(out, "stdout.tap"), stdout, { flag: "wx", mode: 0o600 });
  const receipt = { version: 1, kind: "browser-reproduction", mode: "operator-local", packetId, packetSha256, requestMessageId, workItemId, revision, tree, script,
    scriptSha256: digest(source), testName, nodeVersion, nodeSha256: nodeDigest, timeoutMs, observedOutcome, outcome, reason, exitCode,
    startedAt, finishedAt: new Date().toISOString(), stdoutSha256: digest(stdout), stdoutBytes: stdout.length,
    limitations: ["stderr_not_retained", "incomplete_child_stdout_not_retained", "dependencies_and_browser_not_pinned", "local_process_not_sandboxed", "not_a_fix_or_release_receipt"] };
  const bytes = JSON.stringify(receipt, null, 2) + "\n";
  writeFileSync(join(out, "receipt.json"), bytes, { flag: "wx", mode: 0o600 });
  return { body: `Browser reproduction: ${outcome}.\nSource: ${revision}\nTree: ${tree}\nSuite: ${script}\nTest: ${testName}\nReceipt SHA-256: ${digest(bytes)}\nStdout SHA-256: ${receipt.stdoutSha256}\nReceipt: ${join(out, "receipt.json")}\nObservation only; no fix or release claimed.`, receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const names = { checkout: "checkout", revision: "revision", tree: "tree", script: "script", "test-name": "testName", node: "node", git: "git", out: "out", "packet-id": "packetId", "packet-sha256": "packetSha256", "request-message-id": "requestMessageId", "work-item-id": "workItemId", "timeout-ms": "timeoutMs" };
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = names[process.argv[i]?.slice(2)];
      if (!process.argv[i]?.startsWith("--") || !key || Object.hasOwn(options, key) || process.argv[i + 1] === undefined) throw new Error("Invalid arguments");
      options[key] = key === "timeoutMs" ? Number(process.argv[i + 1]) : process.argv[i + 1];
    }
    const { body } = await runBrowserReproduction(options);
    process.stdout.write(JSON.stringify({ body }) + "\n");
  } catch { process.stderr.write("Reproduction refused: inspect the explicit operator configuration and source pins.\n"); process.exitCode = 1; }
}
