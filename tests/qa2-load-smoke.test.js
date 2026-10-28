// Regression for #2887: load-smoke.mjs passed (exit 0) even when every
// scenario request was 429 rate-limited, because a 429 only incremented
// `limited` — it was not counted as an error and pushed no latency sample,
// so errorRate was 0 and every p95 was null (skipped) and report.pass held.
//
// These tests spawn the real script against a stub origin. The stub serves
// the setup calls (identity mint, room creation, cleanup) with 200 and
// answers every scenario request with a fixed status, so the pass/fail
// verdict is exercised end to end without a real server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/qa2/load-smoke.mjs");

function startStub(scenarioStatus) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = new URL(req.url, "http://stub");
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "POST" && url.pathname === "/api/agent-identities") return send(200, { identityId: "stub-id", secret: "stub-secret" });
      if (req.method === "POST" && url.pathname === "/api/agent-rooms") return send(200, { roomId: "stub-room" });
      if (url.pathname.endsWith("/revoke")) return send(200, {});
      // Cleanup archive post after the run: not a scenario sample verdict input.
      return send(scenarioStatus, {});
    });
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

function runLoadSmoke(origin) {
  const out = join(mkdtempSync(join(tmpdir(), "load-smoke-")), "report.json");
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SCRIPT, "--origin", origin, "--vus", "2", "--seconds", "1", "--json", out],
      { cwd: ROOT, timeout: 60_000, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") return reject(new Error(`load-smoke spawn failed: ${stderr || error.message}`));
        let report = null;
        try { report = JSON.parse(readFileSync(out, "utf8")); } catch { /* fall through to assert */ }
        resolve({ code: error?.code ?? 0, stdout: `${stdout}${stderr}`, report });
      });
  });
}

test("load smoke fails when every request is 429 rate-limited", { timeout: 120_000 }, async () => {
  const { server, origin } = await startStub(429);
  try {
    const { code, stdout, report } = await runLoadSmoke(origin);
    assert.ok(report, stdout);
    assert.ok(report.total > 0, stdout);
    assert.equal(report.rateLimited, report.total, "every scenario request was 429");
    assert.equal(report.pass, false, `100% 429 must not pass:\n${stdout}`);
    assert.equal(code, 1, `100% 429 must exit 1:\n${stdout}`);
  } finally { server.close(); }
});

test("load smoke passes when every request succeeds", { timeout: 120_000 }, async () => {
  const { server, origin } = await startStub(200);
  try {
    const { code, stdout, report } = await runLoadSmoke(origin);
    assert.ok(report, stdout);
    assert.ok(report.total > 0, stdout);
    assert.equal(report.rateLimited, 0);
    assert.equal(report.pass, true, `healthy stub must pass:\n${stdout}`);
    assert.equal(code, 0, `healthy stub must exit 0:\n${stdout}`);
    for (const kind of ["static", "read", "post"]) assert.ok(report[kind].n > 0, `${kind} should have latency samples`);
  } finally { server.close(); }
});
