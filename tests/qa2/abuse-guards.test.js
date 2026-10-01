// Ratchet over abuse guards. KNOWN guards fail today with a tracked QA2 finding;
// when a fix lands the guard flips to PASS and must be removed from KNOWN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { enabled, startServer, runChecker } from "./helpers.js";

const KNOWN = ["G1", "G2", "G3", "G4", "G5", "G7", "G9"];

test("abuse guards: no new failures, fixed guards leave KNOWN", { skip: !enabled, timeout: 15 * 60_000 }, async () => {
  const server = await startServer();
  try {
    const { report, stdout } = await runChecker("abuse-guards.mjs", ["--origin", server.origin, "--known", KNOWN.join(","), "--flood", process.env.QA2_FLOOD ?? "120"]);
    assert.ok(report, stdout);
    for (const r of report.results) {
      if (KNOWN.includes(r.id)) assert.notEqual(r.status, "PASS", `${r.id} passes now: remove it from KNOWN`);
      else assert.equal(r.status, "PASS", `${r.id} ${r.title}: ${r.evidence}`);
    }
  } finally { server.stop(); }
});
