// Verify at read time, slice 2 (server/receipt-verify.mjs): the linked
// pull request is re-fetched from GitHub at read time and its current
// state compared with what the record claims. Behavior protected:
//   - GitHub confirming the merge + a matching source record earns the
//     "server-verified" verdict — the only verdict that may use the word;
//   - GitHub reporting the pull open, closed-unmerged, or missing
//     contradicts a receipt that shows its merge, and the verdict says so;
//   - GitHub unreachable / rate-limited / unreadable makes the verdict
//     partially-verifiable — never failed, never silently "verified";
//   - a receipt that claims no merge (a work item's evidence link) has
//     the pull's state reported as a fact, never scored against a claim
//     it never made.
// Seams: the real RoomStore + read model serve the receipts; GitHub is a
// stub fetch — the injection seam claim-pr-sync itself uses.
// Run: node --test tests/receipt-verify-pull.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { publicReceiptById } from "../server/receipts-live.mjs";
import { verifyPublicReceipt } from "../server/receipt-verify.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";

const NOW = 1_786_100_000_000;
const PR_URL = "https://github.com/Uuriko/project-room/pull/2099";
const github = body => async () => ({ status: 200, ok: true, text: async () => JSON.stringify(body) });
const mergedFetch = github({ state: "closed", merged: true,
  merged_at: "2026-10-01T00:00:00.000Z", merge_commit_sha: "a".repeat(40) });
const openFetch = github({ state: "open", merged: false });
const closedFetch = github({ state: "closed", merged: false });
const missingFetch = async () => ({ status: 404, ok: false, text: async () => "{}" });
const limitedFetch = async () => ({ status: 403, ok: false, text: async () => "{}" });
const downFetch = async () => { throw new Error("network down"); };
const check = (verification, id) => verification.checks.find(entry => entry.id === id);
const verify = (store, id, fetchImpl) =>
  verifyPublicReceipt(store, publicReceiptById(store, id), { fetchImpl, nowMs: NOW });

function serveClaimRoom(t) {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "receipt-verify-pull-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("alpha"));
  const key = store.issueAccessKey("alpha", "owner");
  store.workClaims.set("alpha", { id: "alpha-claim", title: "Done work in alpha", state: "done", owner: "owner",
    history: [{ action: "pr_merged", agentId: "owner", actor: "owner", at: "2026-10-01T00:00:00.000Z" }],
    pullRequest: { url: PR_URL, outcome: "merged", syncedAt: "2026-10-01T00:00:00.000Z" },
    blobs: ["sha256:" + "ab".repeat(32)], updatedAt: "2026-10-01T00:00:00.000Z" });
  store.command(key, "alpha", { id: "publish-alpha", type: "room.public_receipts_set", data: { enabled: true } });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, key, receiptId: store.db.prepare("SELECT id FROM public_receipts WHERE origin_room_id='alpha'").get().id };
}

test("GitHub confirming the merge + matching source = server-verified", async t => {
  const { store, receiptId } = serveClaimRoom(t);
  const verification = await verify(store, receiptId, mergedFetch);
  assert.equal(verification.verdict, "server-verified");
  assert.equal(check(verification, "source-record").status, "pass");
  assert.equal(check(verification, "pull-request").status, "pass");
  assert.match(check(verification, "pull-request").detail, /merged at 2026-10-01/);
  assert.deepEqual(verification.scope.checked, ["Source record", "Pull request on GitHub"]);
});

test("GitHub reporting the pull open contradicts the recorded merge", async t => {
  const { store, receiptId } = serveClaimRoom(t);
  const verification = await verify(store, receiptId, openFetch);
  assert.equal(check(verification, "pull-request").status, "contradicted");
  assert.match(check(verification, "pull-request").detail, /still open/);
  assert.equal(verification.verdict, "contradicted");
});

test("GitHub reporting the pull closed-unmerged contradicts the recorded merge", async t => {
  const { store, receiptId } = serveClaimRoom(t);
  const verification = await verify(store, receiptId, closedFetch);
  assert.equal(check(verification, "pull-request").status, "contradicted");
  assert.match(check(verification, "pull-request").detail, /closed without merging/);
  assert.equal(verification.verdict, "contradicted");
});

test("GitHub reporting no such pull contradicts the recorded merge", async t => {
  const { store, receiptId } = serveClaimRoom(t);
  const verification = await verify(store, receiptId, missingFetch);
  assert.equal(check(verification, "pull-request").status, "contradicted");
  assert.equal(verification.verdict, "contradicted");
});

test("GitHub unreachable or declining is partially verifiable, never failed", async t => {
  const { store, receiptId } = serveClaimRoom(t);
  for (const fetchImpl of [downFetch, limitedFetch]) {
    const verification = await verify(store, receiptId, fetchImpl);
    assert.equal(check(verification, "pull-request").status, "not-checked");
    assert.equal(verification.verdict, "partially-verifiable");
    assert.ok(verification.scope.notChecked.includes("Pull request on GitHub"));
    assert.equal(check(verification, "source-record").status, "pass", "the local checks still ran");
  }
});

test("a work item's evidence pull is reported as fact, never scored as a merge claim", async t => {
  const { store, key } = serveClaimRoom(t);
  const command = (k, id, type, data) => store.command(k, "alpha", { id, type, data });
  command(key, "add-producer", T.MEMBER_ADDED, { memberId: "producer", displayName: "Producer",
    kind: "agent", permissions: ["accept_work", "complete_work"], accountableHumanId: "owner" });
  const producerKey = store.issueAccessKey("alpha", "producer");
  const signEvidence = makeTestSigner(store);
  command(key, "propose", T.WORK_PROPOSED, { workItemId: "wi-1", title: "Evidence work",
    definitionOfDone: "A result text.", accountableMemberId: "producer", mode: "read" });
  const revision = () => store.room("alpha").state.workItems["wi-1"].revision;
  command(producerKey, "accept", T.WORK_ACCEPTED, { workItemId: "wi-1", expectedRevision: revision() });
  command(producerKey, "start", T.WORK_STARTED, { workItemId: "wi-1", expectedRevision: revision() });
  const text = "The evidence result text.";
  command(producerKey, "complete", T.WORK_COMPLETED, { workItemId: "wi-1", expectedRevision: revision(),
    summary: text, evidenceVersion: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    producerId: "producer", evidenceUrl: PR_URL, nextAction: "Review", signedEvidence: signEvidence() });
  const wirId = store.db.prepare("SELECT id FROM public_receipts WHERE source='work-item'").get().id;

  const verification = await verify(store, wirId, openFetch);
  assert.equal(check(verification, "pull-request").status, "observed");
  assert.match(check(verification, "pull-request").detail, /claims no merge/);
  assert.equal(verification.verdict, "record-checked", "an open evidence pull does not contradict a record that claimed no merge");
});
