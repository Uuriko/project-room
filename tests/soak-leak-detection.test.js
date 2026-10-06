// Q007 soak harness — failing-first detection proof.
//
// These tests guard the soak harness's own detection contract:
//   1. an intentionally injected memory leak must make the harness FAIL;
//   2. a clean server must make the harness PASS;
//   3. an injected unhandled rejection must make the harness FAIL.
//
// Without (1) and (3) the harness could be "green-always" and never catch a
// real leak or rejection; without (2) it could be "red-always". Each test
// boots the real server (scripts/soak-test.mjs) with a scratch database, so
// nothing here touches production state or server behavior — the preload is
// observe-only and fault injection lives entirely in the harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmpRoot = join(root, ".tmp", "soak-tests");

function runSoak(name, extraEnv, durationS) {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, "soak-report.json");
  let status = null;
  let stderr = "";
  try {
    execFileSync(process.execPath, [join(root, "scripts", "soak-test.mjs")], {
      cwd: root,
      timeout: (durationS + 150) * 1000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TMPDIR: join(root, ".tmp"),
        SOAK_DURATION_S: String(durationS),
        SOAK_LOAD_RPS: "5",
        SOAK_REPORT_PATH: reportPath,
        ...extraEnv,
      },
    });
    status = 0;
  } catch (error) {
    status = error.status ?? "timeout";
    stderr = String(error.stderr ?? "");
  }
  assert.ok(existsSync(reportPath), `soak report was not written (${name})${stderr ? `\nstderr: ${stderr.slice(-2000)}` : ""}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  return { status, report };
}

test("soak harness FAILS on an injected memory leak (failing-first)", () => {
  // ~1 MiB/s retained by the preload leak injector over a 45 s soak:
  // expected growth is ~35-45 MiB, far above the 8 MiB trip threshold.
  const { status, report } = runSoak("leak", {
    SOAK_INJECT_LEAK: "1",
    SOAK_MAX_HEAP_GROWTH_MB: "8",
  }, 45);
  assert.equal(status, 1, `expected harness exit 1, got ${status} (verdict=${report.verdict})`);
  assert.equal(report.verdict, "fail");
  assert.ok(report.metrics, "expected a metrics summary in the report");
  assert.ok(
    report.failures.some((f) => f.includes("heap growth")),
    `expected a heap-growth failure, got: ${JSON.stringify(report.failures)}`,
  );
  assert.ok(report.metrics.heapGrowthMB > 8, `expected measurable leak growth, got ${report.metrics.heapGrowthMB} MB`);
});

test("soak harness PASSES on a clean server", () => {
  const { status, report } = runSoak("clean", {}, 35);
  assert.equal(status, 0, `expected harness exit 0, got ${status}; failures=${JSON.stringify(report.failures)}`);
  assert.equal(report.verdict, "pass");
  assert.deepEqual(report.failures, []);
  assert.ok(report.metrics.samples >= 20, `expected >= 20 samples, got ${report.metrics.samples}`);
});

test("soak harness FAILS on an injected unhandled rejection", () => {
  const { status, report } = runSoak("rejection", {
    SOAK_INJECT_REJECTION: "1",
  }, 30);
  assert.equal(status, 1, `expected harness exit 1, got ${status} (verdict=${report.verdict})`);
  assert.equal(report.verdict, "fail");
  assert.ok(
    report.failures.some((f) => f.includes("unhandled rejection") || f.includes("crashed")),
    `expected an unhandled-rejection/crash failure, got: ${JSON.stringify(report.failures)}`,
  );
});
