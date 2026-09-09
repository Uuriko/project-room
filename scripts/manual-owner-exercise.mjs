// Simulated owner browser stages. The caller supplies the AI answer separately.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { parseWorkReturn } from "../src/work-packet.js";

export async function runManualOwnerExercise({ ownerPath, stage, answerPath, output, mobile = false }) {
  assert.ok(["export", "return"].includes(stage));
  const config = JSON.parse(readFileSync(ownerPath)), origin = new URL(config.origin);
  assert.equal(config.fixture, "room-helper-exercise-v1"); assert.equal(origin.origin, config.origin);
  assert.equal(origin.protocol, "http:"); assert.equal(origin.hostname, "127.0.0.1");
  const directory = resolve(output); mkdirSync(directory, { mode: 0o700 });
  const save = (name, value) => writeFileSync(join(directory, name), value, { flag: "wx", mode: 0o600 });
  const client = new RoomAgentClient({ origin: config.origin, roomId: "commons", token: config.token });
  const before = await client.snapshot(), work = before.state.workItems[config.workItemId];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage(), errors = [], external = [], commands = [];
    page.setDefaultTimeout(10000); page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", route => {
      if (new URL(route.request().url()).origin === config.origin) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/commands")) commands.push(request.postDataJSON()); });
    await page.goto(config.origin); await page.locator("#access-key").fill(config.token);
    await page.getByRole("button", { name: "Enter room", exact: true }).click(); await page.locator("#main").waitFor();
    const composer = "Keep this unrelated manual-route draft.";
    await page.locator("#message-input").fill(composer);
    const card = page.locator('[data-work-record-id="' + config.workItemId + '"]');
    await card.locator(".work-details > summary").click();
    await card.getByRole("button", { name: stage === "export" ? "Use my AI" : "Paste AI draft", exact: true }).click();
    await page.locator("#portable-dialog").waitFor();
    let packet = null, message = null, selectedResult = null;
    if (stage === "export") {
      assert.equal(await page.locator("#portable-source").isChecked(), false);
      packet = await page.locator("#packet-preview").inputValue();
      for (const absent of [config.token, composer, "Our room should feel welcoming"]) assert.equal(packet.includes(absent), false);
      await page.locator("#packet-copy").click();
      await page.getByText("Copied. Paste into your AI.", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), packet);
      save("packet.md", packet);
      await page.screenshot({ path: join(directory, "packet.png") });
      await page.locator("#portable-close").click();
      assert.deepEqual(await client.snapshot(), before, "export is read-only");
      assert.deepEqual(commands, []);
    } else {
      const answer = readFileSync(answerPath, "utf8"), parsed = parseWorkReturn(answer, { roomId: "commons", workItemId: config.workItemId });
      save("answer.md", answer);
      await page.locator("#portable-result").fill(answer);
      await page.screenshot({ path: join(directory, "return.png") });
      await page.locator("#portable-submit").click(); await page.locator("#portable-dialog").waitFor({ state: "hidden" });
      const posted = await client.snapshot();
      assert.deepEqual(posted.state.workItems, before.state.workItems, "posting does not complete work");
      const added = posted.state.messages.filter(m => !before.state.messages.some(previous => previous.id === m.id));
      assert.equal(added.length, 1); message = added[0];
      assert.equal(message.authorId, "owner"); assert.equal(message.body, parsed.body);
      assert.equal(message.workItemId, config.workItemId); assert.equal(message.proposal.packetId, parsed.packetId);
      assert.equal(message.proposal.attribution, "manual-unverified");
      await page.locator('[data-message-action="result"][data-message-id="' + message.id + '"]').click();
      await page.waitForFunction(body => document.querySelector("#action-text-body").textContent === body, message.body);
      assert.equal(await page.locator('[name="producerId"]').inputValue(), "");
      await page.locator('[name="producerId"]').selectOption("__unknown__");
      await page.locator('#action-fields [name="summary"]').fill("Copied AI proposal, returned by the owner. Author not verified.");
      await page.locator('#action-fields [name="nextAction"]').fill("Establish producer attribution before independent review; owner decision remains pending.");
      await page.screenshot({ path: join(directory, "adopt.png") });
      await page.locator("#action-form button[type=submit]").click(); await page.locator("#action-dialog").waitFor({ state: "hidden" });
      const current = (await client.snapshot()).state.workItems[config.workItemId];
      assert.equal(current.receipt.nativeText.messageId, message.id);
      assert.equal(current.receipt.producerId, null); assert.equal(current.receipt.reportedById, "owner");
      assert.equal(current.verification, null); assert.equal(current.decision, null);
      selectedResult = await client.workResult(config.workItemId, { completionEventId: current.receipt.eventId });
      assert.equal(selectedResult.result.text.body, parsed.body); assert.equal(selectedResult.result.receipt.producerAttribution, "unknown");
      await card.locator('[data-read-result]').click();
      await page.waitForFunction(body => document.querySelector("#result-body").textContent === body, parsed.body);
      await page.screenshot({ path: join(directory, "result.png") });
      await page.locator("#close-result").click();
      assert.deepEqual(commands.map(command => command.type), ["message.posted", "work.completed"]);
    }
    assert.equal(await page.locator("#message-input").inputValue(), composer);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    const after = await client.snapshot();
    assert.deepEqual(after.state.helpOffers, before.state.helpOffers, "manual contribution does not invent agent coordination");
    assert.equal(after.state.workItems[config.workItemId].accountableMemberId, work.accountableMemberId);
    assert.equal(after.cursor, before.cursor);
    const evidence = { stage, mobile, simulatedOwner: true, nativeHostUsed: false, independentReviewPerformed: false,
      beforeSequence: before.sequence, afterSequence: after.sequence, packet, message, selectedResult, work: after.state.workItems[config.workItemId], commands, errors, external };
    assert.equal(JSON.stringify(evidence).includes(config.token), false);
    save("evidence.json", JSON.stringify(evidence, null, 2));
    return evidence;
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [ownerPath, stage, answerPath, output] = process.argv.slice(2);
  if (process.argv.length !== 6) throw new Error("Supply fixture owner path, export/return, answer file (or - for export), and NEW evidence directory.");
  const evidence = await runManualOwnerExercise({ ownerPath, stage, answerPath, output });
  console.log(JSON.stringify({ stage, beforeSequence: evidence.beforeSequence, afterSequence: evidence.afterSequence, output,
    messageId: evidence.message?.id, completionEventId: evidence.work.receipt?.eventId }));
}
