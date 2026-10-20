// Receipt legibility (MONEY-LEGIBILITY step 3, pack P3 + P4): the web receipt
// card renders the recorded checksClaimed as a checklist and a signed-by line
// for signedEvidence, and the work card discloses earlier verification and
// decision rounds instead of showing only the latest. A plain room_text
// receipt with no claimed checks and no signature renders neither addition,
// and no earlier-rounds disclosure appears when there are no earlier rounds.
// Real browser + local HTTP service; identities and keys are disposable fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { signInFixture } from "./auth-signin.mjs";
import { issueTestIdentity, signTestEvidence } from "./helpers/signed-evidence.mjs";
import { contentHashOf } from "../server/signed-evidence.mjs";
import { textVersion } from "../server/text-results.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

test("receipt card shows claimed checks + signed line; work card discloses earlier rounds", { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-receipt-legibility-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const now = Date.now();
  store.now = () => now;
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", command(T.MEMBER_ADDED, {
    memberId: "producer", displayName: "Producer", kind: "agent",
    accountableHumanId: "owner", permissions: ["accept_work", "complete_work"]
  }));
  store.command(owner, "commons", command(T.MEMBER_ADDED, {
    memberId: "reviewer", displayName: "Reviewer", kind: "agent",
    accountableHumanId: "owner", permissions: ["verify"]
  }));
  setTier(store.db, "commons", "producer", "t2_standard", { updatedBy: "owner", nowMs: now });
  setTier(store.db, "commons", "reviewer", "t2_standard", { updatedBy: "owner", nowMs: now });
  const producer = store.issueAccessKey("commons", "producer");
  const reviewer = store.issueAccessKey("commons", "reviewer");
  const item = id => store.room("commons").state.workItems[id];
  const rev = id => item(id).revision;
  const evidence = id => ({ completionEventId: item(id).receipt.eventId, evidenceVersion: item(id).receipt.evidenceVersion });

  // --- Item 1: two completion rounds; v1 verified PASS then changes
  // requested, v2 is the current receipt (checks + signed evidence). ---
  const signer = issueTestIdentity(store, "Evidence Signer");
  const sign = contentHash => signTestEvidence(signer, { issuedAt: new Date(now).toISOString(), contentHash });
  const ev1 = sign(contentHashOf("first-version-bytes"));
  const ev2 = sign(contentHashOf("corrected-version-bytes"));
  store.command(owner, "commons", command(T.WORK_PROPOSED, {
    workItemId: "legible-receipt", title: "Legibility finding", definitionOfDone: "Versioned evidence",
    accountableMemberId: "producer", mode: "read",
    independentVerificationRequired: true, ownerDecisionRequired: true,
    verifierMemberId: "reviewer", humanDecisionMakerId: "owner"
  }));
  store.command(producer, "commons", command(T.WORK_ACCEPTED, { workItemId: "legible-receipt", expectedRevision: rev("legible-receipt") }));
  store.command(producer, "commons", command(T.WORK_STARTED, { workItemId: "legible-receipt", expectedRevision: rev("legible-receipt") }));
  store.command(producer, "commons", command(T.WORK_COMPLETED, {
    workItemId: "legible-receipt", expectedRevision: rev("legible-receipt"),
    summary: "First version of the finding", evidenceUrl: "https://example.invalid/v1", evidenceVersion: "v1",
    producerId: "producer", nextAction: "Review the first version",
    checksClaimed: ["Checked the draft spelling", "Counted the draft citations"], signedEvidence: ev1
  }));
  store.command(reviewer, "commons", command(T.VERIFICATION_RECORDED, {
    workItemId: "legible-receipt", expectedRevision: rev("legible-receipt"), ...evidence("legible-receipt"),
    result: "pass", summary: "First check"
  }));
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "decision-rationale-1", body: "The citation needs fixing before this can be accepted." }));
  store.command(owner, "commons", command(T.OWNER_DECISION_RECORDED, {
    workItemId: "legible-receipt", expectedRevision: rev("legible-receipt"), ...evidence("legible-receipt"),
    decision: "changes_requested", reason: "Fix the citation", sourceMessageId: "decision-rationale-1"
  }));
  store.command(producer, "commons", command(T.WORK_BLOCKER_RESOLVED, { workItemId: "legible-receipt", expectedRevision: rev("legible-receipt"), resolution: "Citation fixed" }));
  store.command(producer, "commons", command(T.WORK_STARTED, { workItemId: "legible-receipt", expectedRevision: rev("legible-receipt") }));
  store.command(producer, "commons", command(T.WORK_COMPLETED, {
    workItemId: "legible-receipt", expectedRevision: rev("legible-receipt"),
    summary: "Corrected finding", evidenceUrl: "https://example.invalid/v2", evidenceVersion: "v2",
    producerId: "producer", nextAction: "Review the correction",
    checksClaimed: ["Re-checked the spelling", "Recounted the citations"], signedEvidence: ev2
  }));
  store.command(reviewer, "commons", command(T.VERIFICATION_RECORDED, {
    workItemId: "legible-receipt", expectedRevision: rev("legible-receipt"), ...evidence("legible-receipt"),
    result: "pass", summary: "Second check"
  }));
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: "decision-rationale-2", body: "The corrected version checks out." }));
  store.command(owner, "commons", command(T.OWNER_DECISION_RECORDED, {
    workItemId: "legible-receipt", expectedRevision: rev("legible-receipt"), ...evidence("legible-receipt"),
    decision: "approved", reason: "Accept the finding", sourceMessageId: "decision-rationale-2"
  }));
  // Fixture truth, server-side: the current receipt is v2 and exactly two
  // earlier rounds are stored (the v1 verification + the v1 decision).
  assert.equal(item("legible-receipt").receipt.evidenceVersion, "v2");
  assert.deepEqual(item("legible-receipt").receipt.checksClaimed, ["Re-checked the spelling", "Recounted the citations"]);
  assert.equal(item("legible-receipt").verificationHistory.length, 1);
  assert.equal(item("legible-receipt").decisionHistory.length, 1);

  // --- Item 2: a plain room_text receipt — no claimed checks, no signature,
  // no earlier rounds. Nothing new may render for it. ---
  store.command(owner, "commons", command(T.WORK_PROPOSED, {
    workItemId: "plain-receipt", title: "Plain note", definitionOfDone: "A short note",
    accountableMemberId: "producer", mode: "read"
  }));
  store.command(producer, "commons", command(T.WORK_ACCEPTED, { workItemId: "plain-receipt", expectedRevision: rev("plain-receipt") }));
  store.command(producer, "commons", command(T.WORK_STARTED, { workItemId: "plain-receipt", expectedRevision: rev("plain-receipt") }));
  const body = "A plain in-room result with nothing extra recorded.";
  const post = store.command(producer, "commons", command(T.MESSAGE_POSTED, { messageId: "plain-result", workItemId: "plain-receipt", body }));
  store.command(producer, "commons", command(T.WORK_COMPLETED, {
    workItemId: "plain-receipt", expectedRevision: rev("plain-receipt"), evidenceKind: "room_text",
    evidenceMessageId: "plain-result", evidenceMessageEventId: post.event.id, evidenceVersion: textVersion(body),
    previousCompletionEventId: null, producerId: "producer",
    summary: "Plain result", nextAction: "Nothing further"
  }));
  assert.equal(item("plain-receipt").receipt.checksClaimed.length, 0);
  assert.equal(item("plain-receipt").receipt.signedEvidence, undefined);

  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })).newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await signInFixture(page, owner);
  await page.locator("#main").waitFor({ state: "visible" });

  const card = page.locator('[data-work-record-id="legible-receipt"]');
  await card.waitFor();
  const receipt = card.locator(".receipt");
  // P3: the current receipt's claimed checks render as a checklist, labelled
  // as reported (never as verified).
  assert.equal(await receipt.locator(".receipt-checks li").count(), 2);
  const checksText = await receipt.locator(".receipt-checks").textContent();
  assert.ok(checksText.includes("Checks reported by the producer"), checksText);
  assert.ok(checksText.includes("Re-checked the spelling"), checksText);
  assert.ok(checksText.includes("Recounted the citations"), checksText);
  // The superseded v1 checks belong to the old receipt and are not rendered.
  const receiptText = await receipt.textContent();
  assert.ok(!receiptText.includes("Checked the draft spelling"), receiptText);
  assert.ok(!receiptText.includes("Counted the draft citations"), receiptText);
  // P3: the signed-evidence line names the recorded signer and the current
  // evidence's short content hash; the superseded signature stays unshown.
  const signedText = await receipt.locator(".receipt-signed").textContent();
  assert.ok(signedText.includes(signer.identityId), signedText);
  assert.ok(signedText.includes(ev2.contentHash.slice(0, 17)), signedText);
  assert.ok(!signedText.includes(ev1.contentHash.slice(0, 17)), signedText);
  // P4: earlier rounds disclose the v1 verification and the v1 decision,
  // in order, with result + actor + text; the current rounds are not
  // duplicated inside the disclosure (they render as the card's own blocks).
  const history = card.locator(".work-history");
  assert.equal(await history.count(), 1);
  const historyText = await history.textContent();
  assert.ok(historyText.includes("Earlier review rounds (2)"), historyText);
  assert.ok(historyText.includes("First check"), historyText);
  assert.ok(historyText.includes("Fix the citation"), historyText);
  assert.ok(historyText.indexOf("First check") < historyText.indexOf("Fix the citation"), historyText);
  assert.ok(!historyText.includes("Second check"), historyText);
  assert.ok(!historyText.includes("Accept the finding"), historyText);
  const cardText = await card.textContent();
  assert.ok(cardText.includes("Second check"), cardText);
  assert.ok(cardText.includes("Accept the finding"), cardText);

  // Negative: the plain receipt renders none of the additions.
  const plain = page.locator('[data-work-record-id="plain-receipt"]');
  await plain.waitFor();
  assert.equal(await plain.locator(".receipt-checks").count(), 0);
  assert.equal(await plain.locator(".receipt-signed").count(), 0);
  assert.equal(await plain.locator(".work-history").count(), 0);
  assert.deepEqual(errors, []);
});
