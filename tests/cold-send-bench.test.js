// The cold-load bench prints one JSON line from a throwaway server.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

function runBench(file, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

function oneJsonLine(result, file) {
  assert.equal(result.code, 0, `${file} stderr:\n${result.stderr}`);
  const lines = result.stdout.split("\n").filter(line => line.length > 0);
  assert.equal(lines.length, 1, `${file} stdout:\n${result.stdout}`);
  return JSON.parse(lines[0]);
}

test("cold-send bench prints one JSON line", async () => {
  const report = oneJsonLine(await runBench("perf/cold-send-bench.mjs", { COLD_SEND_BENCH_SAMPLES: "1" }), "perf/cold-send-bench.mjs");
  assert.equal(report.samples, 1);
  assert.equal(report.coldLoad.requests, 8);
  assert.equal(report.coldLoad.jsBytes, 2814);
  assert.equal(report.coldLoad.homeStatus, 200);
  assert.ok(report.coldLoad.assetStatus.every(status => status === 200));
  assert.equal(report.ownSend.status, 201);
  assert.equal(typeof report.coldLoad.ms, "number");
  assert.equal(typeof report.ownSend.ms, "number");
});
