// Legacy storage. The claim thread builds its entries from stored
// work_claim.updated events, which are read raw. A merged or closed pull
// request on private work is recorded there with its URL, so filtering the
// Board row alone would still show an outsider the private repository and pull
// number. The event is written with the server's own emitter, the one the
// pull request sync uses; the reads are real HTTP and MCP calls.
import test from "node:test";
import assert from "node:assert/strict";
import { emitWorkClaimEvent } from "../server/work-claim-events.mjs";
import { privateWorkFixture, privateMarkers, PRIVATE } from "./helpers/private-work-fixture.mjs";

test("legacy: the claim thread does not show an outsider a private task's pull request", async t => {
  const f = await privateWorkFixture(t, "legacy");
  const url = `https://github.com/acme/${PRIVATE.REPO}/pull/7`;
  const row = f.store.workClaims.list("commons").find(item => item.workItemId === "secret");
  emitWorkClaimEvent(f.store, "commons", { actorId: f.producer.id, item: row, action: "pr_merged", pullRequest: { url } });
  const before = f.stored(), leaks = {};
  for (const viewer of ["observer", "triage", "broad"]) {
    const rest = await f.rest(f[viewer], "/work-claims/secret/thread");
    assert.equal(rest.status, 200);
    const tool = await f.mcp(f[viewer], "room_work_claim_thread", { claimId: "secret" });
    assert.ok(tool.ok);
    for (const [label, text] of [["REST thread", rest.text], ["room_work_claim_thread", tool.text]]) {
      const found = privateMarkers(text);
      if (found.length) leaks[`${label} as ${viewer}`] = found;
    }
    // The entry itself stays, so the thread is still a truthful timeline.
    assert.ok(rest.json.entries.some(entry => entry.action === "pr_merged"), "the merge still appears in the timeline");
  }
  for (const viewer of ["producer", "reviewer"]) {
    const rest = await f.rest(f[viewer], "/work-claims/secret/thread");
    assert.ok(rest.json.entries.some(entry => entry.pullRequest?.url === url), `${viewer} still reads the pull request`);
  }
  assert.equal(f.stored(), before, "reads changed stored rows");
  assert.deepEqual(leaks, {});
});
