import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [candidate, reportPath, ...suites] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(candidate) || !reportPath || !suites.length || suites.length > 30
    || suites.some(suite => !/^scripts\/[a-z0-9-]+-browser-check\.mjs$/.test(suite))) {
  throw new Error("Usage: qualify-release-browser.mjs EXACT_SHA REPORT.json scripts/NAME-browser-check.mjs [...]");
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const exact = () => git("rev-parse", "HEAD") === candidate && git("status", "--porcelain") === "";
if (!exact()) throw new Error("Browser qualification requires the exact clean candidate checkout.");
execFileSync("git", ["ls-files", "--error-unmatch", "--", ...suites], { stdio: "ignore" });

const started = performance.now();
const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...suites], {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60 * 1000
});
const elapsedMs = Math.round(performance.now() - started);
if (run.error) throw run.error;
if (!exact()) throw new Error("Candidate changed during the browser run.");
const count = label => Number(run.stdout.match(new RegExp(`^# ${label} (\\d+)$`, "m"))?.[1]);
const [tests, passed, failed, skipped] = ["tests", "pass", "fail", "skipped"].map(count);
if (run.status === null || !tests || tests !== passed + failed + skipped) {
  throw new Error("Browser runner did not return a complete test summary.");
}

const report = resolve(reportPath);
const temporary = report + "." + process.pid;
const tap = run.stdout;
const data = { sourceRevision: candidate, clean: true, suites, tests, passed, failed, skipped, elapsedMs, exitCode: run.status,
  tapDigest: "sha256:" + createHash("sha256").update(tap).digest("hex") };
writeFileSync(report + ".tap", tap, { mode: 0o600 });
writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
renameSync(temporary, report);
console.log(JSON.stringify(data));
process.exitCode = run.status || (passed === tests ? 0 : 1);
