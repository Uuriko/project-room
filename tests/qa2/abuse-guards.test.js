// The checker boots through tests/qa2/helpers.js and scores refusal codes
// plus unchanged room state. Default npm test skips it unless QA2_E2E=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { enabled, startServer, runChecker } from "./helpers.js";

test("abuse guards: refusals leave the room state unchanged", { skip: !enabled, timeout: 15 * 60_000 }, async () => {
  const server = await startServer();
  try {
    const { code, stdout, report } = await runChecker("abuse-guards.mjs", ["--origin", server.origin]);
    assert.ok(report, stdout);
    assert.equal(code, 0, stdout);
    for (const result of report.results) {
      assert.equal(result.status, "PASS", `${result.id} ${result.title}: ${result.evidence}`);
    }
  } finally { server.stop(); }
});
