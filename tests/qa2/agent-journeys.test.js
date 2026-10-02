// Synthetic agent journeys (outcome-scored, tau-bench style) against a local server.
// KNOWN lists journeys that fail today with a tracked finding; the test is a ratchet:
// a KNOWN journey that starts passing fails the test until it is removed from KNOWN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { enabled, startServer, runChecker } from "./helpers.js";

const KNOWN = new Set(); // J5 (QA2-P1-2) passes after #1304: room-create next points at agent-invites
const KNOWN_UNDISCOVERABLE = new Set(["J8"]); // work-claim create/states still undocumented; J11 is discoverable after #1310 put room.archived in the agent card

test("agent journeys: pass^3 with no unexpected failures", { skip: !enabled, timeout: 10 * 60_000 }, async () => {
  const server = await startServer();
  try {
    const { report, stdout } = await runChecker("agent-journeys.mjs", ["--origin", server.origin, "--trials", "3"]);
    assert.ok(report, `no report:\n${stdout}`);
    for (const s of report.summary) {
      if (KNOWN.has(s.id)) assert.equal(s.passHatK, false, `${s.id} now passes: remove it from KNOWN`);
      else assert.equal(s.passHatK, true, `${s.id} ${s.title} failed: ${s.notes.join("; ")}`);
      if (KNOWN_UNDISCOVERABLE.has(s.id)) assert.equal(s.discoverable, false, `${s.id} is now discoverable: remove it from KNOWN_UNDISCOVERABLE`);
      else assert.equal(s.discoverable, true, `${s.id} needed undocumented knowledge`);
    }
  } finally { server.stop(); }
});
