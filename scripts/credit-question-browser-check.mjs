// Simulated human browser + real scripted MCP subprocess. No external AI inference.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { startHelperAgentExercise } from "./helper-agent-exercise.mjs";
import { textVersion } from "../server/text-results.mjs";
import { openMcpTestClient } from "./mcp-test-client.mjs";

for (const mobile of [false, true]) test(`credit question ${mobile ? "mobile" : "desktop"}: preserved drafts, earlier result, exact retry and MCP answer`, { timeout: 60000 }, async t => {
  const f = await startHelperAgentExercise({ humanReviewer: true }); let browser, mcp;
  t.after(async () => { await mcp?.close(); await browser?.close(); await f.close(); });
  const owner = JSON.parse(readFileSync(f.manifest.ownerPath)), workId = owner.workItemId;
  const send = (type, data) => f.store.command(owner.token, "commons", { id: crypto.randomUUID(), type, data });
  const result = (id, body) => {
    let work = f.store.room("commons").state.workItems[workId];
    if (work.receipt) {
      send("work.blocked", { workItemId: workId, expectedRevision: work.revision, reason: "Revise draft", nextAction: "Provide revision" });
      send("work.blocker_resolved", { workItemId: workId, expectedRevision: work.revision + 1, resolution: "New draft prepared" });
      work = f.store.room("commons").state.workItems[workId];
    }
    const post = send("message.posted", { messageId: id, workItemId: workId, body });
    return send("work.completed", { workItemId: workId, expectedRevision: work.revision, evidenceKind: "room_text",
      evidenceMessageId: id, evidenceMessageEventId: post.event.id, evidenceVersion: textVersion(body),
      previousCompletionEventId: work.receipt?.eventId ?? null, producerId: null, externalProducer: "Outside collaborator + AI",
      summary: "Outside draft", nextAction: "Clarify authorship before independent review" });
  };
  const first = result("first-text", "An initial outside draft.");
  const reviewer = f.store.issueAccessKey("commons", "reviewer");
  const directory = "test-results/credit-question/" + (mobile ? "mobile-" : "desktop-") + crypto.randomUUID();
  mkdirSync(directory, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  page.setDefaultTimeout(10000); const errors = [], outside = [], commands = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin === owner.origin) return route.continue();
    outside.push(route.request().url()); return route.abort();
  });
  await page.goto(owner.origin); await page.locator("#access-key").fill(reviewer);
  await page.getByRole("button", { name: "Enter room", exact: true }).click(); await page.locator("#main").waitFor();
  const input = page.locator("#message-input"), card = page.locator('[data-work-record-id="' + workId + '"]');
  await input.fill("Keep ordinary room writing.");
  await page.locator("#composer-options > summary").click(); await page.locator("#remember-drafts").check();
  await page.locator("#request-reply").click(); await input.fill("Keep my general question.");
  await page.locator("#request-exit").click(); assert.equal(await input.inputValue(), "Keep ordinary room writing.");
  await card.locator(".work-details > summary").click(); await card.locator("[data-ask-credit]").click();
  assert.match(await page.locator("#request-mode-label").textContent(), /Ask about credit/);
  assert.equal(await page.locator("#message-to-select").inputValue(), "owner");
  await page.locator("#message-to-select").selectOption("helper");
  assert.match(await input.inputValue(), /Outside collaborator \+ AI/);
  await input.fill("Who wrote the original draft, and which parts used AI?");
  await page.screenshot({ path: join(directory, "question.png") });
  await page.locator("#request-exit").click(); await page.locator("#thread-back").click();
  assert.equal(await input.inputValue(), "Keep ordinary room writing.");
  if (!await page.locator("#composer-options").evaluate(node => node.open)) await page.locator("#composer-options > summary").click();
  await page.locator("#request-reply").click(); assert.equal(await input.inputValue(), "Keep my general question.");
  await page.locator("#request-exit").click(); await card.locator("[data-ask-credit]").click();
  assert.equal(await input.inputValue(), "Who wrote the original draft, and which parts used AI?");
  result("second-text", "A newer outside draft.");
  await page.waitForFunction(() => document.querySelector("#request-mode-label").textContent.includes("Earlier result"));
  await page.locator("#request-exit").click();
  if (!await card.locator(".work-details").evaluate(node => node.open)) await card.locator(".work-details > summary").click();
  await card.locator("[data-ask-credit]").click();
  assert.match(await input.inputValue(), /Who contributed to this result/);
  await input.fill("A separate question about the newer result.");
  await page.locator("#request-exit").click();
  await page.screenshot({ path: join(directory, "resume.png") });
  await card.locator("[data-resume-credit]").click();
  assert.equal(await input.inputValue(), "Who wrote the original draft, and which parts used AI?");
  await page.screenshot({ path: join(directory, "earlier-question.png") });
  const before = structuredClone(f.store.room("commons").state.workItems), beforeMembers = structuredClone(f.store.room("commons").state.members);
  let drop = true;
  await page.route("**/api/rooms/commons/commands", async route => {
    commands.push(route.request().postDataJSON());
    if (drop) { drop = false; await route.fetch(); return route.abort("failed"); }
    return route.continue();
  });
  await page.locator("#message-form button[type=submit]").click();
  await page.waitForFunction(() => !document.querySelector("#message-input").disabled && document.querySelector("#composer-status").classList.contains("error"));
  assert.equal(await input.evaluate(node => node.readOnly), true);
  page.once("dialog", dialog => dialog.accept()); await page.reload(); await page.locator("#main").waitFor();
  await page.waitForFunction(() => !document.querySelector("#message-input").disabled);
  assert.equal(await input.inputValue(), "Who wrote the original draft, and which parts used AI?");
  assert.match(await page.locator("#request-mode-label").textContent(), /Earlier result/);
  await page.getByRole("button", { name: "Retry original", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#message-input").disabled && document.querySelector("#request-mode-bar").hidden);
  assert.equal(commands.length, 2); assert.deepEqual(commands[0], commands[1]);
  const data = commands[0].data;
  assert.equal(data.workItemId, workId); assert.equal(data.replyToId, "first-text");
  const state = f.store.room("commons").state;
  assert.equal(Object.keys(state.replyRequests).length, 1); assert.equal(state.replyRequests[data.messageId].recipientId, "helper");
  assert.deepEqual(state.workItems, before); assert.deepEqual(state.members, beforeMembers);
  mcp = await openMcpTestClient(f.manifest.configDirectory);
  const read = (await mcp.call("room_read_request", { requestMessageId: data.messageId })).result;
  assert.notEqual(read.isError, true, JSON.stringify(read.structuredContent));
  const context = read.structuredContent;
  assert.equal(context.page.hasMore, false);
  const original = (await mcp.call("room_read_result", { workItemId: workId, draftMessageId: data.replyToId })).result.structuredContent;
  assert.equal(original.result.text.body, "An initial outside draft.");
  const answer = (await mcp.call("room_respond_to_request", { requestId: "credit-answer", ...context.current.answerBasis,
    responseToRequestId: data.messageId, responseOutcome: "answered", toMemberId: "reviewer", workItemId: workId,
    body: "The outside author reports writing the draft with AI editing assistance. This is their account, not identity proof." })).result.structuredContent;
  assert.equal(answer.status, "recorded");
  await page.locator('[data-message-record-id="' + data.messageId + '"] .request-state').filter({ hasText: "Answered" }).waitFor();
  await page.screenshot({ path: join(directory, "answered.png") });
  assert.deepEqual(f.store.room("commons").state.workItems, before);
  assert.deepEqual(f.store.room("commons").state.members, beforeMembers);
  await page.locator("#thread-back").click(); assert.equal(await input.inputValue(), "Keep ordinary room writing.");
  page.once("dialog", dialog => dialog.accept()); await page.locator("#signout-button").click();
  await page.locator("#auth-panel").waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("project-room:drafts:v3")), null);
  assert.deepEqual(errors, []); assert.deepEqual(outside, []);
  assert.ok(f.evidence().cursors.every(c => c.sequence === 0));
  writeFileSync(join(directory, "evidence.json"), JSON.stringify({ simulatedPeople: true, nativeModelUsed: false, commands,
    originalCompletion: first.event.id, latestWork: before[workId], answer, unchangedWork: true, errors, outside }, null, 2));
  console.log(JSON.stringify({ evidenceDirectory: directory }));
});
