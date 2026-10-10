import test from "node:test";
import assert from "node:assert/strict";
import { landingFacts, pathLeases } from "../scripts/landing-facts.mjs";

const MAIN = "a".repeat(40);
const HEAD = "b".repeat(40);
const NFC = "server/caf\u00e9.mjs";
const NFD = "server/cafe\u0301.mjs";
const NOW = Date.parse("2026-10-10T12:00:00.000Z");

test("an NFD landing path names the holder of the NFC lease", async () => {
  assert.equal(NFC === NFD, false);
  const leases = pathLeases({
    truncated: false,
    claims: [{
      id: "lane-a",
      state: "claimed",
      owner: "ai_a",
      leaseExpiresAt: "2026-10-11T00:00:00.000Z",
      files: [NFC],
    }, {
      id: "done-lane",
      state: "done",
      owner: "ai_old",
      files: [NFC],
    }],
  }, [NFD, "server/App.mjs"], NOW);
  assert.equal(leases.paths.find(row => row.path === NFD).holders[0]?.claimId, "lane-a");
  assert.deepEqual(leases.paths.find(row => row.path === "server/App.mjs").holders, []);

  const execImpl = (args) => {
    const key = args.join(" ");
    if (key === "rev-parse HEAD") return { status: 0, stdout: `${HEAD}\n`, stderr: "" };
    if (key === "rev-parse origin/main") return { status: 0, stdout: `${MAIN}\n`, stderr: "" };
    if (key.startsWith("rev-list")) return { status: 0, stdout: "1\n", stderr: "" };
    if (key.startsWith("diff --name-only")) return { status: 0, stdout: `${NFD}\n`, stderr: "" };
    if (key.startsWith("diff ")) return { status: 0, stdout: "diff local\n", stderr: "" };
    if (key.startsWith("patch-id")) return { status: 0, stdout: `${HEAD} x\n`, stderr: "" };
    return { status: 1, stdout: "", stderr: key };
  };
  const facts = await landingFacts({
    fetchImpl: async () => ({ ok: true, json: async () => ({ sourceRevision: null, buildId: "t", deployment: "production" }) }),
    execImpl,
    claimsImpl: async () => ({
      truncated: false,
      claims: [{ id: "lane-a", state: "claimed", owner: "ai_a", leaseExpiresAt: "2026-10-11T00:00:00.000Z", files: [{ path: NFC }] }],
    }),
    nowMs: NOW,
  });
  assert.deepEqual(facts.touchedPaths, [NFD]);
  assert.equal(facts.pathLeases.paths[0].holders[0].claimId, "lane-a");
  assert.equal(facts.notMergeAuthorization, true);
});
