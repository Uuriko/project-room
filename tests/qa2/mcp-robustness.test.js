import { test } from "node:test";
import assert from "node:assert/strict";
import { enabled, startServer, runChecker } from "./helpers.js";

test("MCP robustness: malformed and edge inputs never 5xx, leak, or break JSON-RPC", { skip: !enabled, timeout: 5 * 60_000 }, async () => {
  const server = await startServer();
  try {
    const { code, signal, stdout, report } = await runChecker("mcp-robustness.mjs", ["--url", `${server.origin}/mcp`]);
    // A signal-killed checker (e.g. OOM) must fail here, not pass as code 0.
    assert.equal(signal, null, stdout);
    assert.equal(code, 0, stdout);
    // Do not trust the exit code alone: the checker must have actually run
    // and written a report in which every case passed.
    assert.ok(report, stdout);
    assert.ok(Array.isArray(report.results) && report.results.length > 0, stdout);
    for (const result of report.results) {
      assert.equal(result.ok, true, `${result.name}: ${result.why || ""}\n${stdout}`);
    }
  } finally { server.stop(); }
});
