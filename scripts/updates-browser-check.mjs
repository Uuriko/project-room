// Updates HTTP/SQLite journey: message/work destinations, exact returns and retired reads.
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
import { clickChrome, openSearch } from "./room-chrome.mjs";
import { makeTestSigner } from "./helpers/signed-evidence.mjs";
import { hashPassword } from "../src/password-auth.mjs";

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

test("Updates navigation keeps review, draft and return context at 1280px and 390px", { timeout: 120000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-updates-browser-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  store.command(owner, "commons", command(T.MEMBER_ADDED, {
    memberId: "agent", displayName: "Reply Agent", kind: "agent", permissions: ["accept_work", "complete_work"]
  }));
  const server = createRoomServer({ store, streamInterval: 60 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })).newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const selectUpdatesFilter = async (name, filter) => {
    await page.getByRole("tab", { name }).click();
    await page.waitForFunction(id => {
      const tab = document.querySelector(`[data-update-filter="${id}"]`);
      return tab?.getAttribute("aria-selected") === "true" && document.querySelector("#updates-status")?.textContent === "";
    }, filter);
  };
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, owner);
  await page.locator("#main").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const badge = document.querySelector("#updates-count");
    return badge && (badge.hidden || badge.textContent === "");
  });
  assert.equal(await page.locator("#updates-count").textContent(), "");

  const agent = store.issueAccessKey("commons", "agent");
  const messageId = "updates-message-only", threadId = "updates-thread-root";
  store.command(owner, "commons", command(T.MESSAGE_POSTED, { messageId: threadId, body: "Starting review discussion." }));
  store.command(agent, "commons", command(T.MESSAGE_POSTED, {
    messageId, body: "please confirm the empty-room plan", toMemberId: "owner", replyToId: threadId
  }));
  await page.locator("#topbar-updates").click();
  await page.locator("#updates-dialog").waitFor({ state: "visible" });
  await selectUpdatesFilter("Needs me", "needs");
  await page.locator(".updates-row").waitFor();
  assert.match(await page.locator(".updates-row").innerText(), /please confirm the empty-room plan/);
  assert.match(await page.locator("#updates-count").textContent(), /^1$/);

  await page.getByRole("tab", { name: "Needs me" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.querySelector("[data-update-filter=mentions]")?.getAttribute("aria-selected") === "true");
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.querySelector("[data-update-filter=needs]")?.getAttribute("aria-selected") === "true");

  await page.getByRole("button", { name: /Open please confirm/ }).click();
  await page.locator("#updates-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(id => document.activeElement?.dataset.messageRecordId === id, messageId);
  await page.locator("#thread-bar").waitFor({ state: "visible" });
  await page.reload();
  await page.locator("#main").waitFor({ state: "visible" });
  await page.locator("#thread-bar").waitFor({ state: "visible" });
  assert.equal(await page.locator("#work-navigation-return").textContent(), "Back to room");
  const replyDraft = "Keep this reply when I return to the room.";
  await page.locator("#message-input").fill(replyDraft);
  await page.locator("#work-navigation-return").press("Enter");
  await page.locator("#thread-bar").waitFor({ state: "hidden" });
  await page.locator(`[data-message-id="${threadId}"][data-message-action="reply"]`).click();
  await page.locator("#thread-bar").waitFor({ state: "visible" });
  assert.equal(await page.locator("#message-input").inputValue(), replyDraft, "fallback leaves the reply through the normal draft-saving path");
  await page.locator("#message-input").fill("");
  await page.locator("#thread-back").click();
  await clickChrome(page, "#room-actions-open");
  await page.locator("#room-actions-query").fill("Catch up");
  await page.locator("[data-room-action=catch-up]").click();
  await page.locator("#updates-dialog").waitFor({ state: "visible" });
  await selectUpdatesFilter("Saved", "saved");
  await page.locator(".updates-row").waitFor();
  assert.match(await page.locator(".updates-row").innerText(), /read/);
  await page.getByRole("button", { name: /Done please confirm/ }).click();
  await selectUpdatesFilter("Needs me", "needs");
  await page.getByText("Nothing needs you.").waitFor();
  assert.equal(await page.locator("#updates-count").textContent(), "");

  await page.setViewportSize({ width: 390, height: 844 });
  const box = await page.locator("#updates-dialog").boundingBox();
  assert.ok(box.width <= 390);
  const overflow = await page.locator("#updates-dialog").evaluate(node => node.scrollWidth <= node.clientWidth + 1);
  assert.equal(overflow, true);
  await page.locator("#updates-close").click();

  // Genuine review updates are projected from completed work, not injected rows.
  const signEvidence = makeTestSigner(store);
  const send = (key, type, data) => store.command(key, "commons", command(type, data));
  const reviewIds = ["review:current", "review:next"];
  for (const [index, workItemId] of reviewIds.entries()) {
    send(owner, T.WORK_PROPOSED, { workItemId, title: `Review exact result ${index + 1}`,
      definitionOfDone: "Name the evidence and next action.", accountableMemberId: "agent", mode: "read",
      independentVerificationRequired: false, ownerDecisionRequired: true, humanDecisionMakerId: "owner" });
    send(agent, T.WORK_ACCEPTED, { workItemId, expectedRevision: 0 });
    send(agent, T.WORK_COMPLETED, { workItemId, expectedRevision: 1, summary: `Current review evidence ${index + 1}`,
      evidenceUrl: "https://example.invalid/not-fetched", signedEvidence: signEvidence(), evidenceVersion: `review-version-${index}`,
      producerId: "agent", nextAction: "Review this exact evidence." });
  }
  for (let index = 0; index < 14; index++) send(agent, T.MESSAGE_POSTED, {
    messageId: `review-scroll-${index}`, body: `Keep queue position ${index}`, toMemberId: "owner", requestKind: "reply"
  });
  await page.waitForFunction(sequence => document.querySelector("#event-count")?.textContent === String(sequence), store.room("commons").sequence);
  const listedResponse = await page.request.get(`${origin}/api/rooms/commons/updates?state=all`);
  assert.equal(listedResponse.ok(), true);
  const listed = await listedResponse.json();
  const reviews = reviewIds.map(id => listed.items.find(item => item.kind === "review_requested" && item.sourceRef.workItemId === id));
  assert.ok(reviews.every(Boolean));
  assert.deepEqual(reviews.map(item => Object.keys(item.sourceRef)), [["workItemId"], ["workItemId"]]);
  const review = reviews[0];
  const row = id => page.locator(`.updates-row[data-update-id="${id}"]`);
  const openReview = id => row(id).locator('[data-update-action="open"]');
  const card = id => page.locator(`[data-work-record-id="${id}"]`);
  const roomBefore = JSON.stringify(store.room("commons"));
  const marksBefore = store.db.prepare("SELECT COUNT(*) AS count FROM private_update_commands").get().count;
  const draft = "Keep my review notes unsent.";
  await page.locator("#message-to-select").evaluate(node => { node.value = "agent"; node.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.locator("#message-input").fill(draft);
  await page.locator("#message-input").evaluate(node => node.setSelectionRange(5, 12, "forward"));

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator("#topbar-updates").click();
    await selectUpdatesFilter("All activity", "all");
    await openReview(review.id).waitFor();
    await openReview(review.id).scrollIntoViewIfNeeded();
    await openReview(review.id).focus();
    const scroll = await page.locator("#updates-dialog").evaluate(node => node.scrollTop);
    assert.ok(scroll > 0, "review starts below the fold, so restoration is observable");
    await page.keyboard.press("Enter");
    await page.locator("#updates-dialog").waitFor({ state: "hidden" });
    await page.waitForFunction(id => document.activeElement?.dataset.workRecordId === id, reviewIds[0]);
    assert.equal(new URL(page.url()).hash, `#pr-record/work/${encodeURIComponent(reviewIds[0])}`);
    assert.equal(await card(reviewIds[0]).locator(".work-details").evaluate(node => node.open), true);
    assert.equal(await card(reviewIds[0]).locator(".mode").textContent(), "read · revision 2");
    assert.match(await card(reviewIds[0]).innerText(), /Current review evidence 1/);
    assert.equal(await page.locator("#work-navigation-return").textContent(), "Back to Updates");
    const historyState = await page.evaluate(() => JSON.stringify(history.state));
    assert.equal(historyState.includes(draft), false, "history never contains private draft text");
    assert.doesNotMatch(historyState, /"(?:filter|toMemberId|selectionStart|selectionEnd|threadId|channelId)"/, "history stores no private origin context");
    assert.equal(JSON.stringify(store.room("commons")), roomBefore, "Open changes no Room event, work revision, decision or receipt");
    const mark = store.db.prepare("SELECT action FROM private_update_marks WHERE room_id=? AND member_id=? AND item_id=?").get("commons", "owner", review.id);
    assert.equal(mark.action, "read");

    const returned = async () => {
      await page.locator("#updates-dialog").waitFor({ state: "visible" });
      await page.waitForFunction(id => document.activeElement?.closest("[data-update-id]")?.dataset.updateId === id, review.id);
      assert.equal(await page.getByRole("tab", { name: "All activity" }).getAttribute("aria-selected"), "true");
      assert.equal(await openReview(review.id).evaluate(node => node === document.activeElement), true);
      assert.ok(Math.abs(await page.locator("#updates-dialog").evaluate(node => node.scrollTop) - scroll) <= 2);
      assert.equal(await page.locator("#message-input").inputValue(), draft);
      assert.equal(await page.locator("#message-to-select").inputValue(), "agent");
      assert.deepEqual(await page.locator("#message-input").evaluate(node => [node.selectionStart, node.selectionEnd, node.selectionDirection]), [5, 12, "forward"]);
    };
    await page.locator("#work-navigation-return").press("Enter");
    await returned();
    const afterOpen = store.db.prepare("SELECT COUNT(*) AS count FROM private_update_commands").get().count;
    await page.goForward();
    await page.waitForFunction(id => document.activeElement?.dataset.workRecordId === id, reviewIds[0]);
    assert.equal(await card(reviewIds[0]).count(), 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM private_update_commands").get().count, afterOpen, "Forward opens once without issuing another read mark");
    await page.goBack();
    await returned();
    await page.locator("#updates-close").click();
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM private_update_commands").get().count, marksBefore + 2);

  // A history entry can be both A's destination and B's origin. Returning
  // from B must preserve A's original Updates return, including after Forward.
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.locator("#topbar-updates").click();
  await selectUpdatesFilter("All activity", "all");
  await openReview(review.id).scrollIntoViewIfNeeded();
  await openReview(review.id).focus();
  const nestedScroll = await page.locator("#updates-dialog").evaluate(node => node.scrollTop);
  const beforeNestedMarks = store.db.prepare("SELECT COUNT(*) AS count FROM private_update_commands").get().count;
  await openReview(review.id).press("Enter");
  await page.locator("#updates-dialog").waitFor({ state: "hidden" });
  await openSearch(page);
  await page.locator("#message-search").fill("Review exact result 2");
  await page.locator('#search-list [data-open-work="review:next"]').press("Enter");
  const assertNestedTask = async (id, backLabel) => {
    await page.waitForFunction(expected => location.hash === expected, `#pr-record/work/${encodeURIComponent(id)}`);
    await page.waitForFunction(({ workId, label }) => {
      const task = [...document.querySelectorAll("[data-work-record-id]")].find(node => node.dataset.workRecordId === workId);
      return task?.querySelector(".work-details")?.open && document.querySelector("#work-navigation-return")?.textContent === label;
    }, { workId: id, label: backLabel });
    assert.equal(await page.locator("#updates-dialog").isVisible(), false);
    assert.equal(await card(id).count(), 1);
  };
  await assertNestedTask(reviewIds[1], "Back to conversation");
  await page.goBack();
  await assertNestedTask(reviewIds[0], "Back to Updates");
  await page.goForward();
  await assertNestedTask(reviewIds[1], "Back to conversation");
  await page.locator("#work-navigation-return").press("Enter");
  await assertNestedTask(reviewIds[0], "Back to Updates");
  await page.locator("#work-navigation-return").press("Enter");
  await page.locator("#updates-dialog").waitFor({ state: "visible" });
  await page.waitForFunction(id => document.activeElement?.closest("[data-update-id]")?.dataset.updateId === id, review.id);
  assert.equal(await page.getByRole("tab", { name: "All activity" }).getAttribute("aria-selected"), "true");
  assert.ok(Math.abs(await page.locator("#updates-dialog").evaluate(node => node.scrollTop) - nestedScroll) <= 2);
  assert.equal(await page.locator("#message-input").inputValue(), draft);
  assert.equal(await page.locator("#message-to-select").inputValue(), "agent");
  assert.deepEqual(await page.locator("#message-input").evaluate(node => [node.selectionStart, node.selectionEnd, node.selectionDirection]), [5, 12, "forward"]);
  await page.goForward();
  await assertNestedTask(reviewIds[0], "Back to Updates");
  await page.locator("#work-navigation-return").press("Enter");
  await page.locator("#updates-dialog").waitFor({ state: "visible" });
  await page.waitForFunction(id => document.activeElement?.closest("[data-update-id]")?.dataset.updateId === id, review.id);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM private_update_commands").get().count, beforeNestedMarks + 1,
    "nested task navigation and every history replay issue only the original Updates read mark");
  assert.equal(JSON.stringify(store.room("commons")), roomBefore);

  // Opening the already-current task from a new surface replaces its return
  // context, closes that modal, and does not add a duplicate destination entry.
  await page.locator("#updates-close").click();
  await openSearch(page);
  await page.locator("#message-search").fill("Review exact result 1");
  await page.locator('#search-list [data-open-work="review:current"]').press("Enter");
  await assertNestedTask(reviewIds[0], "Back to conversation");
  const sameTargetHistoryLength = await page.evaluate(() => history.length);
  await page.locator("#topbar-updates").click();
  await openReview(review.id).press("Enter");
  await page.locator("#updates-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(id => document.activeElement?.dataset.workRecordId === id, reviewIds[0]);
  assert.equal(await page.locator("#work-navigation-return").textContent(), "Back to Updates");
  assert.equal(await page.evaluate(() => history.length), sameTargetHistoryLength);
  await page.locator("#work-navigation-return").press("Enter");
  await page.locator("#updates-dialog").waitFor({ state: "visible" });
  await page.waitForFunction(id => document.activeElement?.closest("[data-update-id]")?.dataset.updateId === id, review.id);

  // Another real client handles the item while its task is open. Returning to
  // Saved keeps the filter and uses its tab when the original row disappeared.
  await selectUpdatesFilter("Saved", "saved");
  await openReview(review.id).press("Enter");
  await page.locator("#updates-dialog").waitFor({ state: "hidden" });
  const sessionResponse = await page.request.get(`${origin}/api/session`);
  assert.equal(sessionResponse.ok(), true);
  const { csrf } = await sessionResponse.json();
  const handled = await page.request.post(`${origin}/api/rooms/commons/updates/${encodeURIComponent(review.id)}/done`, {
    headers: { Origin: origin, "X-CSRF-Token": csrf }, data: { requestId: crypto.randomUUID() }
  });
  assert.equal(handled.status(), 200, await handled.text());
  await page.locator("#work-navigation-return").press("Enter");
  await page.locator("#updates-dialog").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.activeElement?.dataset.updateFilter === "saved");
  assert.equal(await row(review.id).count(), 0);
  assert.equal(await page.getByRole("tab", { name: "Saved" }).getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#message-input").inputValue(), draft);
  await selectUpdatesFilter("All activity", "all");
  await openReview(review.id).waitFor();
  await page.locator("#updates-close").click();

  // Delay only delivery of a real HTTP response: the real server owns the mark.
  // Closing or newer navigation must retire the pending Open, including a null
  // roomWrite result after the authenticated session has ended.
  const delayRead = async () => {
    let resolveEntered, resolveRelease;
    const entered = new Promise(resolve => { resolveEntered = resolve; });
    const release = new Promise(resolve => { resolveRelease = resolve; });
    await page.route(/\/updates\/[^/]+\/read$/, async route => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      resolveEntered();
      await release;
      await route.fulfill({ response });
    }, { times: 1 });
    return { entered, async finish() {
      const finished = page.waitForEvent("requestfinished", request => /\/updates\/[^/]+\/read$/.test(new URL(request.url()).pathname));
      resolveRelease();
      await finished;
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    } };
  };
  for (const close of ["Close", "Escape", "newer Open", "sign out"]) {
    await page.locator("#topbar-updates").click();
    await openReview(review.id).waitFor();
    const delayed = await delayRead();
    await openReview(review.id).click();
    await delayed.entered;
    if (close === "newer Open") {
      await openReview(reviews[1].id).click();
      await page.waitForFunction(id => document.activeElement?.dataset.workRecordId === id, reviewIds[1]);
    } else if (close === "Escape") await page.keyboard.press("Escape");
    else await page.locator("#updates-close").click();
    if (close === "sign out") {
      await page.locator("#message-input").fill("");
      await clickChrome(page, "#signout-button");
      await page.locator("#auth-panel").waitFor({ state: "visible" });
    }
    const destination = page.url();
    await delayed.finish();
    assert.equal(page.url(), destination, `${close} prevents the late mark from replacing the destination`);
    assert.equal(await page.locator("#updates-dialog").isVisible(), false);
    if (close === "newer Open") assert.equal(await page.evaluate(() => document.activeElement?.dataset.workRecordId), reviewIds[1]);
    if (close === "sign out") {
      assert.equal(await page.locator(".updates-row").count(), 0, "retired session drops every old Update row");
      assert.equal(await page.locator("#updates-count").textContent(), "");
      assert.equal(await page.locator("#work-navigation-return").isVisible(), false);
    }
  }
  assert.equal(JSON.stringify(store.room("commons")), roomBefore, "all navigation and cancellation paths remain read-only for shared work");
  // Real account-backed lifecycle boundaries keep the old document alive:
  // a Rooms-picker switch and a distinct-account password sign-in must retire
  // an old Update callback without touching the replacement private view.
  const password = "synthetic-navigation-password";
  for (const [id, memberId, displayName] of [["navigation-account-a", "reader-a", "Reader A"], ["navigation-account-b", "reader-b", "Reader B"]]) {
    send(owner, T.MEMBER_ADDED, { memberId, displayName, kind: "human", permissions: [] });
    store.createAccount(id); store.completeOnboarding(id);
    store.bindHumanAccount("commons", memberId, id);
    store.accountLogins.linkPasswordMethod(id, { email: `${id}@example.invalid`, verifier: hashPassword(password) });
    send(agent, T.MESSAGE_POSTED, { messageId: `private-${memberId}`, body: `Private update for ${displayName}`, toMemberId: memberId });
  }
  store.initialize(initialRoom("updates-other", "other-owner"));
  store.bindHumanAccount("updates-other", "other-owner", "navigation-account-a");
  const otherOwner = store.issueAccessKey("updates-other", "other-owner");
  store.command(otherOwner, "updates-other", command(T.MEMBER_ADDED, { memberId: "other-agent", displayName: "Other room agent", kind: "agent", permissions: [] }));
  const otherAgent = store.issueAccessKey("updates-other", "other-agent");
  store.command(otherAgent, "updates-other", command(T.MESSAGE_POSTED, { messageId: "other-room-update", body: "Private update in the other room", toMemberId: "other-owner" }));
  const lifecycleBefore = JSON.stringify([store.room("commons"), store.room("updates-other")]);
  const loginAccount = async (accountId, displayName) => {
    await page.locator("#auth-panel").waitFor({ state: "visible" });
    // Set the ordinary room URL without loading a new document or abandoning
    // the pending response, as in the existing session-boundary journey.
    await page.evaluate(() => history.replaceState(null, "", "?room=commons"));
    const form = page.locator('#auth-signin-ui [data-signin-form="password"]');
    await form.locator('[name="email"]').fill(`${accountId}@example.invalid`);
    await form.locator('[name="password"]').fill(password);
    const accepted = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/password/login" && response.request().method() === "POST");
    await form.locator('button[type="submit"]').click();
    assert.equal((await accepted).status(), 200);
    await page.locator("#main").waitFor({ state: "visible" });
    await page.waitForFunction(name => document.querySelector("#identity-label")?.textContent.startsWith(name), displayName);
    const sessionResponse = await page.request.get(`${origin}/api/account-session`);
    assert.equal((await sessionResponse.json()).account.id, accountId, "this is a distinct account session, not a room-key principal swap");
  };
  const showOnlyUpdate = async title => {
    await page.locator("#topbar-updates").click();
    await selectUpdatesFilter("Needs me", "needs");
    assert.equal(await page.locator(".updates-row").count(), 1);
    assert.match(await page.locator(".updates-row").innerText(), new RegExp(title));
    return page.locator('.updates-row [data-update-action="open"]');
  };
  const openAccountRoom = async roomId => {
    await clickChrome(page, "#nav-rooms");
    await page.locator(`[data-account-room="${roomId}"]`).click();
    await page.locator("#main").waitFor({ state: "visible" });
    await page.waitForFunction(id => new URL(location.href).searchParams.get("room") === id, roomId);
  };
  await loginAccount("navigation-account-a", "Reader A");
  const oldOpen = await showOnlyUpdate("Private update for Reader A");
  const oldUpdateId = await page.locator(".updates-row").getAttribute("data-update-id");
  const oldDocument = await page.evaluate(() => performance.timeOrigin);
  const roomDelay = await delayRead();
  await oldOpen.click(); await roomDelay.entered;
  await page.locator("#updates-close").click();
  await openAccountRoom("updates-other");
  await page.locator("#message-input").fill("Replacement room draft");
  await showOnlyUpdate("Private update in the other room");
  const roomDestination = page.url();
  await roomDelay.finish();
  assert.equal(await page.evaluate(() => performance.timeOrigin), oldDocument, "room switch preserves the pending old JavaScript callback");
  assert.equal(page.url(), roomDestination);
  const sameAccount = await page.request.get(`${origin}/api/account-session`);
  assert.equal((await sameAccount.json()).account.id, "navigation-account-a", "Rooms navigation keeps the same account");
  assert.equal(await page.locator("#updates-dialog").isVisible(), true);
  assert.match(await page.locator(".updates-row").innerText(), /Private update in the other room/);
  assert.equal(await page.locator("#message-input").inputValue(), "Replacement room draft");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM private_update_marks WHERE room_id=?").get("updates-other").count, 0);
  await page.locator("#updates-close").click();
  await page.locator("#message-input").fill("");
  await openAccountRoom("commons");

  const accountOpen = await showOnlyUpdate("Private update for Reader A");
  const accountDelay = await delayRead();
  await accountOpen.click(); await accountDelay.entered;
  await page.locator("#updates-close").click();
  await clickChrome(page, "#signout-button");
  await loginAccount("navigation-account-b", "Reader B");
  await page.locator("#message-input").fill("Replacement account draft");
  await showOnlyUpdate("Private update for Reader B");
  const accountDestination = page.url();
  await accountDelay.finish();
  assert.equal(await page.evaluate(() => performance.timeOrigin), oldDocument, "account switch preserves the pending old JavaScript callback");
  assert.equal(page.url(), accountDestination);
  assert.equal(await page.locator("#updates-dialog").isVisible(), true);
  assert.match(await page.locator(".updates-row").innerText(), /Private update for Reader B/);
  assert.equal(await page.locator(`.updates-row[data-update-id="${oldUpdateId}"]`).count(), 0);
  assert.equal(await page.locator("#message-input").inputValue(), "Replacement account draft");
  assert.equal(await page.locator("#work-navigation-return").isVisible(), false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM private_update_marks WHERE member_id=?").get("reader-b").count, 0);
  assert.equal(store.db.prepare("SELECT action FROM private_update_marks WHERE room_id=? AND member_id=? AND item_id=?").get("commons", "reader-a", oldUpdateId).action, "read");
  assert.equal(JSON.stringify([store.room("commons"), store.room("updates-other")]), lifecycleBefore, "stale callbacks cannot mutate either room's shared state");
  assert.deepEqual(errors, []);
});
