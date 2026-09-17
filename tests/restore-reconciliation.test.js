import test from "node:test";
import { spawnSync } from "node:child_process";

// The restore rehearsal (scripts/restore-rehearsal.mjs) is the single source of
// truth for the restore-hazard scenario: this wrapper keeps CI honest about it.
test("restore rehearsal names resurrected authority", () => {
  const run = spawnSync(process.execPath, ["scripts/restore-rehearsal.mjs"], { encoding: "utf8" });
  if (run.status !== 0) {
    console.error(run.stdout);
    console.error(run.stderr);
  }
  assert.equal(run.status, 0, "rehearsal exits green");
  for (const kind of ["credential", "share_link", "agent_connection", "member"])
    assert.ok(run.stdout.includes(`stale ${kind}:`), `report names stale ${kind}`);
  assert.ok(run.stdout.includes("was revoked after the backup"), "revocation named");
  assert.ok(run.stdout.includes("was deactivated after the backup"), "deactivation named");
});

import assert from "node:assert/strict";
