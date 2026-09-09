// Scripted people only; no outside AI app, mailbox, or provider participates.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { startHelperAgentExercise } from "./helper-agent-exercise.mjs";
import { runManualOwnerExercise } from "./manual-owner-exercise.mjs";

for (const mobile of [false, true]) test(`outside credit ${mobile ? "mobile" : "desktop"}: honest credit, exact retry, useful review without approval`, { timeout: 60000 }, async t => {
  const f = await startHelperAgentExercise({ humanReviewer: true }); let browser;
  t.after(async () => { await browser?.close(); await f.close(); });
  const parent = `test-results/external-credit/${mobile ? "mobile" : "desktop"}-${crypto.randomUUID()}`;
  mkdirSync(parent, { recursive: true });
  const exported = await runManualOwnerExercise({ ownerPath: f.manifest.ownerPath, stage: "export", output: join(parent, "export"), mobile });
  const answerPath = join(parent, "answer.md");
  writeFileSync(answerPath, exported.packet.split("\n").find(line => line.startsWith("ROOM-RETURN ")) + "\n\nA small, useful draft for the room.", { flag: "wx" });
  const evidence = await runManualOwnerExercise({ ownerPath: f.manifest.ownerPath, stage: "return", answerPath, output: join(parent, "return"), mobile,
    externalProducer: "Outside collaborator + AI", loseCompletionResponse: true });
  assert.equal(evidence.afterSequence, exported.afterSequence + 2, "lost response creates no duplicate completion");
  const owner = JSON.parse(readFileSync(f.manifest.ownerPath)), reviewer = f.store.issueAccessKey("commons", "reviewer");
  const beforeMembers = structuredClone(f.store.room("commons").state.members);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000); const errors = [], outside = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => { if (new URL(route.request().url()).origin === owner.origin) return route.continue(); outside.push(route.request().url()); return route.abort(); });
  await page.goto(owner.origin); await page.locator("#access-key").fill(reviewer);
  await page.getByRole("button", { name: "Enter room", exact: true }).click(); await page.locator("#main").waitFor();
  await page.locator("#return-brief-panel > summary").click();
  await page.waitForFunction(() => document.querySelector("#rb-history-list").textContent.includes("Outside collaborator + AI · outside room, reported"));
  await page.locator("#return-brief-panel > summary").click();
  const card = page.locator('[data-work-record-id="' + owner.workItemId + '"]');
  await card.locator('[data-action="verify"]').click();
  await page.getByText("Outside credit is reported, not verified.", { exact: true }).waitFor();
  await page.waitForFunction(body => document.querySelector("#action-text-body").textContent === body, evidence.message.body);
  await page.locator('#action-fields [name="result"]').selectOption("pass");
  await page.locator('#action-fields [name="summary"]').fill("Text is suitable. Producer identity and independence are not established.");
  await page.screenshot({ path: join(parent, "review.png") });
  await page.locator("#action-form button[type=submit]").click(); await page.locator("#action-dialog").waitFor({ state: "hidden" });
  const after = f.store.room("commons").state, work = after.workItems[owner.workItemId];
  assert.equal(work.verification.result, "pass"); assert.equal(work.verification.independenceConfirmed, false);
  assert.equal(work.decision, null); assert.deepEqual(after.members, beforeMembers);
  assert.equal(work.receipt.externalProducer, "Outside collaborator + AI");
  assert.throws(() => f.store.command(owner.token, "commons", { id: crypto.randomUUID(), type: "owner.decision_recorded", data: {
    workItemId: owner.workItemId, expectedRevision: work.revision, completionEventId: work.receipt.eventId,
    evidenceVersion: work.receipt.evidenceVersion, decision: "approved", reason: "A name alone is not independence"
  } }), /independent/);
  await card.locator(".work-details > summary").click();
  await page.screenshot({ path: join(parent, "checked.png") });
  assert.deepEqual(errors, []); assert.deepEqual(outside, []);
  assert.ok(f.evidence().cursors.every(c => c.sequence === 0));
  writeFileSync(join(parent, "final.json"), JSON.stringify({ simulatedPeople: true, nativeModelUsed: false, work, membersUnchanged: true,
    errors, outside, cursors: f.evidence().cursors }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ evidenceDirectory: parent }));
});
