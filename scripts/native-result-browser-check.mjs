// Simulated human interaction in disposable local rooms, never a user study.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { textVersion } from "../server/text-results.mjs";

async function setup(t, { mobile = false, review = false } = {}) {
  const f = createAcceptanceFixture(), workItemId = "native-human", body = "  A quiet room\n\nCafé 🪷 — one clear next step.  \n";
  const send = (type, data, actor = "owner") => f.store.command(f.keys[actor], "commons", { id: crypto.randomUUID(), type, data });
  send(T.MEMBER_ADDED, { memberId: "human-checker", displayName: "Test checker", kind: "human", permissions: ["verify"] });
  f.keys["human-checker"] = f.store.issueAccessKey("commons", "human-checker");
  send(T.WORK_PROPOSED, { workItemId, title: "A quiet room", definitionOfDone: "Short text with one next step", mode: "read", accountableMemberId: "owner",
    verifierMemberId: "human-checker", independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: "owner" });
  const item = () => f.store.room("commons").state.workItems[workItemId];
  const mutate = (type, data = {}, actor) => send(type, { workItemId, expectedRevision: item().revision, ...data }, actor);
  mutate(T.WORK_ACCEPTED);
  const posted = send(T.MESSAGE_POSTED, { messageId: "native-draft", workItemId, packetId: "human-packet", basisRevision: 1, body });
  for (let i = 0; i < 102; i++) send(T.MESSAGE_POSTED, { body: "Synthetic background activity", replyToId: "test-welcome" });
  const complete = () => mutate(T.WORK_COMPLETED, { evidenceKind: "room_text", evidenceMessageId: "native-draft", evidenceMessageEventId: posted.event.id,
    evidenceVersion: textVersion(body), previousCompletionEventId: item().receipt?.eventId ?? null, producerId: "owner", summary: "A quiet room", nextAction: "Review" });
  if (review) complete();
  const server = createRoomServer({ store: f.store, streamInterval: 40 }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  const errors = [], outside = []; page.on("pageerror", e => errors.push(e.message)); page.setDefaultTimeout(8000);
  await page.route("**/*", route => { if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); } return route.continue(); });
  await page.goto(origin); await page.locator("#access-key").fill(f.keys[review ? "human-checker" : "owner"]); await page.getByRole("button", { name: "Enter room", exact: true }).click(); await page.locator("#main").waitFor({ state: "visible" });
  const open = async () => {
    if (review) await page.locator(`[data-work-record-id='${workItemId}'] [data-action='verify']`).click();
    else await page.locator("[data-message-id='native-draft'][data-message-action='result']").click();
    await page.locator("#action-dialog").waitFor({ state: "visible" });
  };
  const textReady = async () => { await page.waitForFunction(body => document.querySelector("#action-text-body").textContent === body, body); };
  const fill = async () => {
    if (review) { await page.locator("#action-fields [name=result]").selectOption("pass"); await page.locator("#action-fields [name=summary]").fill("Checked the stored text and next step"); }
    else { await page.locator("#action-fields [name=producerId]").selectOption("owner"); await page.locator("#action-fields [name=summary]").fill("A quiet room"); await page.locator("#action-fields [name=nextAction]").fill("Review exact text"); }
  };
  const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: `test-results/native-result-${name}.png` }); };
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(outside, []); });
  return { ...f, page, workItemId, body, item, send, mutate, complete, open, fill, textReady, capture, save: page.locator("#action-form button[type=submit]") };
}

for (const mobile of [false, true]) test(`native result ${mobile ? "mobile" : "desktop"}: selected old draft becomes exact result`, { timeout: 25000 }, async t => {
  const f = await setup(t, { mobile }); await f.open(); await f.textReady(); await f.fill();
  assert.equal(await f.page.locator("#action-fields [name=evidenceUrl]").count(), 0);
  assert.equal(await f.page.locator("#action-title").textContent(), "Save as result");
  assert.equal(await f.page.locator("#action-text-body").evaluate(el => getComputedStyle(el).whiteSpace), "pre-wrap");
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.capture(mobile ? "mobile" : "desktop"); await f.save.click(); await f.page.locator("#action-dialog").waitFor({ state: "hidden" });
  assert.equal(f.item().receipt.nativeText.messageId, "native-draft"); assert.equal(f.item().receipt.evidenceVersion, textVersion(f.body));
  assert.equal(f.item().verification, null); assert.equal(f.item().decision, null);
  await f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await f.page.waitForFunction(body => document.querySelector("#result-body").textContent === body, f.body);
  assert.equal(await f.page.locator("#result-dialog").evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await f.page.locator("#close-result").click(); assert.equal(await f.page.locator("#result-body").textContent(), "");
});

test("native result uncertain save resumes exact text and command", { timeout: 25000 }, async t => {
  const f = await setup(t), attempts = []; await f.open(); await f.textReady(); await f.fill();
  await f.page.route("**/commands", async route => { attempts.push(route.request().postDataJSON()); if (attempts.length === 1) { await route.fetch(); return route.abort("failed"); } return route.continue(); });
  await f.save.click(); await f.page.getByText("Save not confirmed. Retry the original before making changes.", { exact: true }).waitFor();
  await f.page.locator("#cancel-action").click(); await f.page.locator("#resume-action").click();
  assert.equal(await f.page.locator("#action-text-body").textContent(), f.body); await f.save.click(); await f.page.locator("#action-dialog").waitFor({ state: "hidden" });
  assert.deepEqual(attempts[0], attempts[1]); assert.equal(f.item().revision, 2);
});

test("native review shows exact text and leaves human approval pending", { timeout: 25000 }, async t => {
  const f = await setup(t, { review: true }); await f.open(); await f.textReady(); await f.fill();
  assert.equal(await f.page.locator("#action-evidence").isVisible(), false);
  assert.equal(await f.page.locator("#action-dialog").evaluate(el => el.scrollWidth <= el.clientWidth), true); await f.capture("review");
  await f.save.click(); await f.page.locator("#action-dialog").waitFor({ state: "hidden" });
  assert.equal(f.item().verification.result, "pass"); assert.equal(f.item().verification.independenceConfirmed, true); assert.equal(f.item().decision, null);
});

test("native review refuses self-consistent text from a different pinned evidence version", { timeout: 25000 }, async t => {
  const f = await setup(t, { review: true });
  await f.page.route("**/work-result?**", async route => {
    const response = await route.fetch(), value = await response.json(); value.result.text.body = "A substituted result";
    value.result.text.byteLength = Buffer.byteLength(value.result.text.body); value.result.text.evidenceVersion = value.result.receipt.evidenceVersion = textVersion(value.result.text.body);
    return route.fulfill({ status: 200, json: value });
  });
  await f.open(); await f.page.getByText("Exact text unavailable. Review current work to try again.", { exact: true }).waitFor();
  assert.equal(await f.save.isEnabled(), false); assert.equal(await f.page.locator("#action-text-body").textContent(), ""); assert.equal(f.item().verification, null);
});

test("native draft cannot save stale work; explicit refresh keeps the selected text", { timeout: 25000 }, async t => {
  const f = await setup(t); await f.open(); await f.textReady(); await f.fill(); f.mutate(T.WORK_STARTED);
  await f.page.locator("#refresh-action").waitFor({ state: "visible" }); assert.equal(await f.save.isEnabled(), false);
  await f.page.locator("#refresh-action").click(); await f.textReady(); await f.page.waitForFunction(() => !document.querySelector("#action-form button[type=submit]").disabled);
  await f.save.click(); await f.page.locator("#action-dialog").waitFor({ state: "hidden" }); assert.equal(f.item().receipt.nativeText.messageId, "native-draft");
});

test("native result large text and keyboard remain usable; revocation clears visible text", { timeout: 25000 }, async t => {
  const f = await setup(t, { review: true });
  await f.page.evaluate(() => { document.documentElement.style.fontSize = "200%"; }); await f.open(); await f.textReady();
  assert.equal(await f.page.locator("#action-text-body").evaluate(el => getComputedStyle(el).fontSize), "32px");
  assert.equal(await f.page.locator("#action-dialog").evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await f.page.locator("#cancel-action").focus(); await f.page.keyboard.press("Escape"); await f.page.locator("#action-dialog").waitFor({ state: "hidden" });
  await f.page.locator(`[data-read-result='${f.workItemId}']`).click();
  await f.page.waitForFunction(body => document.querySelector("#result-body").textContent === body, f.body); await f.capture("large-text");
  assert.equal(await f.page.locator("#result-body").evaluate(el => getComputedStyle(el).fontSize), "32px");
  f.send(T.MEMBER_ACCESS_CHANGED, { memberId: "human-checker", expectedMemberRevision: 0, permissions: ["verify"], active: false });
  await f.page.locator("#auth-panel").waitFor({ state: "visible" });
  assert.equal(await f.page.locator("#result-body").textContent(), ""); assert.equal(await f.page.locator("#action-text-body").textContent(), "");
});
