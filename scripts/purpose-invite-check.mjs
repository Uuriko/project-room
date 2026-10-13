import { clickChrome, ensureSidebarClosed } from "./room-chrome.mjs";
// W4-51 L3: invite for a purpose. An inviter can point an invitation link at the
// question or result the guest is invited to help with; after joining, the room
// opens on that item. The purpose travels only in the URL fragment (never sent to
// the server). It selects a destination; guest access still covers room history.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { showGuestJoin, fillJoinName, signInFixture } from "./auth-signin.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { makeTestSigner } from "./helpers/signed-evidence.mjs";

for (const width of [390, 1280]) for (const theme of ["light", "dark"]) {
test(`invite for a purpose ${width}/${theme}: link opens the invited work item after join`, { timeout: 90000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 50 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  browser = await chromium.launch({ headless: true });
  const origin = `http://127.0.0.1:${server.address().port}`, errors = [];

  // A reported result can change before its invitation is redeemed. The link
  // selects current work, never pins an old receipt or grants approval.
  const currentWork = () => f.store.snapshot(f.keys.owner, "commons").state.workItems["test-handoff"];
  const mutate = (type, data = {}) => f.store.command(f.keys.producer, "commons", { id: randomUUID(), type,
    data: { workItemId: "test-handoff", expectedRevision: currentWork().revision, ...data } });
  mutate(T.WORK_ACCEPTED);
  mutate(T.WORK_COMPLETED, { summary: "Earlier agenda result", evidenceUrl: "https://example.invalid/agenda", evidenceVersion: "v1",
    producerId: "producer", nextAction: "Review", signedEvidence: makeTestSigner(f.store)() });

  // 1. The inviter picks a purpose when creating the link.
  const inviterContext = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
  await inviterContext.addInitScript(value => localStorage.setItem("project-room-theme", value), theme);
  const inviter = await inviterContext.newPage();
  inviter.setDefaultTimeout(8000); inviter.on("pageerror", error => errors.push(error.message));
  await inviter.goto(origin);
  await signInFixture(inviter, f.keys.owner);
  await inviter.locator("#main").waitFor({ state: "visible" });
  await inviter.locator("#message-input").fill("Keep this unfinished thought");
  let creates = 0, lists = 0;
  inviter.on("request", request => {
    if (!request.url().endsWith("/share-links")) return;
    if (request.method() === "POST") creates++;
    if (request.method() === "GET") lists++;
  });
  const workDetails = inviter.locator('[data-work-record-id="test-handoff"] .work-details');
  await workDetails.locator("summary").first().click();
  const contextualInvite = inviter.locator('[data-focus-key="work-invite:test-handoff"]');
  await contextualInvite.evaluate(el => { el.dataset.inviteWork = "missing-work"; });
  await contextualInvite.click();
  assert.equal(await inviter.locator("#share-link-dialog").evaluate(el => el.open), false, "missing work cannot open a contextual invitation");
  await contextualInvite.evaluate(el => { el.dataset.inviteWork = "test-handoff"; });
  await contextualInvite.click();
  const purpose = inviter.locator("#share-link-purpose");
  await purpose.waitFor();
  assert.equal(await purpose.inputValue(), "test-handoff", "contextual invitation preselects the work");
  assert.match(await inviter.locator("#share-link-history-note").innerText(), /room and its history/);
  assert.equal(await inviter.locator("#growth-kit").isVisible(), false, "contextual invitations do not offer a competing generic link");
  assert.equal(creates, 0, "opening the dialog does not create a room share link");
  assert.equal(lists, 0, "opening an invitation does not fetch hidden link management");
  assert.equal(await inviter.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal page overflow");
  mkdirSync("test-results/context-invite", { recursive: true });
  await inviter.screenshot({ path: `test-results/context-invite/${width}-${theme}.png` });
  await inviter.keyboard.press("Escape");
  assert.equal(await inviter.locator("#message-input").inputValue(), "Keep this unfinished thought");
  assert.equal(await contextualInvite.evaluate(el => el === document.activeElement), true, "closing restores the contextual action");
  await clickChrome(inviter, "#invite-people-button");
  await purpose.waitFor();
  assert.equal(await inviter.locator("#growth-kit").isVisible(), true, "general invitations retain the existing invitation kit");
  assert.equal(await purpose.inputValue(), "", "general invitations do not inherit a previous work selection");
  await inviter.keyboard.press("Escape");
  await ensureSidebarClosed(inviter);
  await contextualInvite.click();
  await purpose.waitFor();
  const options = await purpose.locator("option").allTextContents();
  assert.ok(options.some(text => text.includes("Test: prepare an agenda")), `purpose picker lists the open question, got: ${options.join(" | ")}`);
  assert.equal(await purpose.inputValue(), "test-handoff");
  await inviter.locator("#share-link-create").click();
  await inviter.locator("#share-link-result").waitFor({ state: "visible" });
  const url = await inviter.locator("#share-link-url").inputValue();
  assert.ok(url.endsWith("/work/test-handoff"), `link carries the purpose fragment: ${url}`);
  await inviter.locator("#share-purpose-note").waitFor({ state: "visible" });
  assert.match(await inviter.locator("#share-purpose-note").textContent(), /Test: prepare an agenda/);
  assert.match(await inviter.locator("#share-purpose-note").textContent(), /read the room and its history/i);
  assert.doesNotMatch(await inviter.locator("#share-purpose-note").textContent(), /nothing else.*shared/i);
  assert.equal(lists, 0, "creating and copying the link needs no list request");
  await inviterContext.close();
  mutate(T.WORK_BLOCKED, { reason: "The agenda needs updated dates", nextAction: "Correct dates" });
  const reopenedWork = currentWork();

  // 2. The guest joins from that link and lands on the invited item.
  const guestContext = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
  await guestContext.addInitScript(value => localStorage.setItem("project-room-theme", value), theme);
  const guest = await guestContext.newPage();
  guest.setDefaultTimeout(8000); guest.on("pageerror", error => errors.push(error.message));
  await guest.goto(url);
  await guest.locator("#join-account-auth").waitFor();
  assert.equal(await guest.locator("#join-link-form").isVisible(), false, "account entry has one form");
  assert.equal(await guest.locator("#join-account-back").innerText(), "Join temporarily as a guest");
  await guest.screenshot({ path: `test-results/context-invite/join-${width}-${theme}.png` });
  await showGuestJoin(guest);
  assert.equal(await guest.locator("#join-account-auth").isVisible(), false, "temporary joining hides account entry");
  assert.match(await guest.locator("#join-guest-note").innerText(), /8 hours/);
  await guest.locator("#join-account-signin").click();
  assert.equal(await guest.locator("#join-link-form").isVisible(), false, "returning to login hides temporary joining");
  await guest.locator("#join-account-back").focus();
  await guest.keyboard.press("Enter");
  assert.equal(await guest.locator("#join-link-name").evaluate(el => el === document.activeElement), true, "keyboard guest choice focuses the name");
  assert.equal(await guest.locator("#join-link-scope").isVisible(), true);
  assert.match(await guest.locator("#join-link-scope").innerText(), /Join the conversation/);
  await fillJoinName(guest, "Purposeful guest");
  await guest.locator("#join-link-submit").click();
  await guest.locator("#main").waitFor({ state: "visible" });
  const card = guest.locator('[data-work-record-id="test-handoff"]');
  await card.waitFor();
  assert.equal(await card.locator(".work-details").evaluate(el => el.open), true, "invited item is opened for the guest");
  assert.match(await guest.locator("#status").textContent(), /This invitation opens.*prepare an agenda/i);
  assert.match(await card.innerText(), /The agenda needs updated dates/);
  assert.match(await card.innerText(), /Earlier agenda result/);
  assert.deepEqual(currentWork(), reopenedWork, "joining changes no assignment, result, approval or work revision");
  assert.equal(await guest.locator("[data-invite-work]").count(), 0, "guests cannot manage work invitations");
  await guest.evaluate(() => { const button = document.createElement("button"); button.dataset.inviteWork = "test-handoff"; document.querySelector("#message-list").append(button); button.click(); button.remove(); });
  assert.equal(await guest.locator("#share-link-dialog").evaluate(el => el.open), false, "a forged contextual action cannot bypass invitation permissions");
  await guestContext.close();

  // 3. A stale purpose (item gone) never blocks the join: the room opens with a gentle note.
  const staleToken = randomBytes(32).toString("base64url");
  f.store.shareLinks.create(f.keys.owner, "commons", { requestId: randomUUID(), linkToken: staleToken, expiresAt: Date.now() + 3600000, maxJoins: 5, expectedMemberRevision: 0 }, null);
  const staleContext = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
  const stale = await staleContext.newPage();
  stale.setDefaultTimeout(8000); stale.on("pageerror", error => errors.push(error.message));
  await stale.goto(`${origin}/#join/${staleToken}/work/no-such-item`);
  await fillJoinName(stale, "Stale guest");
  await stale.locator("#join-link-submit").click();
  await stale.locator("#main").waitFor({ state: "visible" });
  assert.match(await stale.locator("#status").textContent(), /no longer/i);
  assert.equal(await stale.locator('[data-work-record-id="test-handoff"] .work-details').evaluate(el => el.open), false, "no item force-opened for a stale purpose");
  await staleContext.close();

  // 4. A plain link (no purpose) still joins without opening any item.
  const plainContext = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" });
  const plain = await plainContext.newPage();
  plain.setDefaultTimeout(8000); plain.on("pageerror", error => errors.push(error.message));
  await plain.goto(`${origin}/#join/${f.links.valid}`);
  await fillJoinName(plain, "Plain guest");
  await plain.locator("#join-link-submit").click();
  await plain.locator("#main").waitFor({ state: "visible" });
  assert.equal(await plain.locator('[data-work-record-id="test-handoff"] .work-details').evaluate(el => el.open), false, "plain link opens no item");
  await plainContext.close();

  assert.deepEqual(errors, [], "no page errors");
});

}
