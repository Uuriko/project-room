// Linear parity acceptance suite. Runs the 36 probes against a local server
// and reports the score (LINEAR_PARITY_REPORT=1 prints the table). The score is
// a report, not a CI gate: only a core capability that is at parity today
// regressing fails, because that is a real bug.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../../server/http.mjs";
import { linkWithProof } from "../helpers/link-with-proof.mjs";
import { runProbes } from "./parity-probes.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("Linear parity: core capabilities stay at parity", async () => {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const id = f.store.identities.create("ParityAgent");
    linkWithProof(f.store, f.keys.owner, "commons", id, { memberId: "parity-agent", displayName: "ParityAgent", permissions: ["accept_work", "complete_work"] });
    const out = await runProbes({ origin, secret: f.keys.owner, mcpSecret: id.secret, roomId: "commons", repo });
    if (process.env.LINEAR_PARITY_REPORT) console.log(JSON.stringify(out, null, 1));
    for (const r of ["Issues / tasks", "Labels", "Hosted MCP", "Inbox", "API"]) assert.equal(out.rows.find((x) => x.cap === r).status, "parity", r);
  } finally {
    server.closeAllConnections(); await new Promise((r) => server.close(r)); f.store.close();
    try { rmSync(f.directory, { recursive: true, force: true }); } catch {}
  }
});
