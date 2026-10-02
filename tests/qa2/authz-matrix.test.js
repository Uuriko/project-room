import { test } from "node:test";
import assert from "node:assert/strict";
import { enabled, startServer, runChecker } from "./helpers.js";

test("authz matrix: every role x action cell matches policy", { skip: !enabled, timeout: 10 * 60_000 }, async () => {
  const server = await startServer();
  try {
    const { code, stdout, report } = await runChecker("authz-matrix.mjs", ["--origin", server.origin]);
    assert.ok(report, stdout);
    assert.equal(code, 0, stdout);
  } finally { server.stop(); }
});
