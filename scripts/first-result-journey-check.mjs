// W4-50 L2: first-result onboarding. A newcomer joins from an invite link,
// contributes to a help-wanted work item, and sees the outcome of their own
// contribution - with no account, agent setup, or advanced configuration.
// Done-when: this complete simulated journey passes end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { textVersion } from "../server/text-results.mjs";

test("first-result journey: join, offer help, contribute, see the outcome", { timeout: 90000 }, async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store, streamInterval: 50 });
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeStreams(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const origin = `http://127.0.0.1:${server.address().port}`, errors = [];
  context.on("page", page => { page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message)); });
  const state = () => f.store.room("commons").state;
  const send = (type, data) => f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type, data });

  // Setup: a work item accountable to the owner with help wanted - the kind of
  // small, well-bounded ask a newcomer can pick up.
  send("work.proposed", { workItemId: "first-result", title: "Welcome note for the board", definitionOfDone: "A two-line welcome a newcomer can post.",
    accountableMemberId: "owner", verifierMemberId: "owner", independentVerificationRequired: false, ownerDecisionRequired: false, humanDecisionMakerId: "owner", mode: "read" });
  send("work.accepted", { workItemId: "first-result", expectedRevision: 0 });
  const rev = () => state().workItems["first-result"].revision;
  send("work.help_updated", { workItemId: "first-result", expectedRevision: rev(), expectedHelpRevision: 0, status: "open",
    scope: "Draft the two-line welcome.", expiresAt: new Date(Date.now() + 3600000).toISOString() });

  // 1. Join from the invite link only. No account, no setup screens.
  const page = await context.newPage();
  await page.goto(`${origin}/#join/${f.links.valid}`);
  await page.locator("#join-link-name").fill("Newcomer"); await page.locator("#join-link-submit").click();
  await page.locator("#main").waitFor({ state: "visible" });
  const member = Object.values(state().members).find(person => person.displayName === "Newcomer");
  assert.ok(member, "newcomer joined as a member");

  // 2. Find the help-wanted ask on the work card and offer help.
  await page.locator('[data-work-record-id="first-result"] .work-help > summary').click();
  await page.getByRole("button", { name: "Offer help", exact: true }).click();
  await page.locator('#action-fields textarea[name="plan"]').fill("I will draft the welcome in two lines.");
  await page.locator('#action-form button[type="submit"]').click();
  await page.locator("#action-dialog").waitFor({ state: "hidden" });
  const offer = Object.values(state().helpOffers ?? {}).find(o => o.offererId === member.id);
  assert.ok(offer && offer.status === "offered", "newcomer's offer is on the work item");

  // 3. Owner selects the newcomer (synthetic owner action, as in the contribution journey).
  send("work.help_offer_updated", { workItemId: "first-result", offerId: offer.id, expectedRevision: rev(), expectedOfferRevision: 0,
    expectedHelpRevision: state().workItems["first-result"].helpWanted.revision, helpEventId: state().workItems["first-result"].helpWanted.eventId, status: "selected", reason: "Fresh eyes welcome." });
  await page.locator('[data-offer-record-id]').getByText("Selected", { exact: true }).waitFor();

  // 4. Newcomer contributes through their own UI: Share draft on the selected
  // offer, write the result, post it - the draft lands tied to the work item.
  const draft = "Welcome! Line one: you belong here.\nLine two: ask anything.";
  await page.locator(`[data-offer-record-id="${offer.id}"] [data-portable-mode="draft"]`).click();
  await page.locator("#portable-result").fill(draft);
  await page.locator("#portable-submit").click();
  await page.locator("#portable-dialog").waitFor({ state: "hidden" });
  const draftMessage = state().messages.find(m => m.workItemId === "first-result" && m.authorId === member.id);
  assert.ok(draftMessage, "newcomer's own draft message is in the room");
  await page.locator(`[data-message-record-id="${draftMessage.id}"]`).waitFor();
  const draftEventId = f.store.db.prepare("SELECT id FROM events WHERE json_extract(body,'$.type')='message.posted' AND json_extract(body,'$.data.messageId')=?").get(draftMessage.id)?.id;
  assert.ok(draftEventId, "draft message event is in the log");

  // 5. Owner completes the work with the newcomer's message as evidence and credit.
  send("work.completed", { workItemId: "first-result", expectedRevision: rev(), evidenceKind: "room_text", evidenceMessageId: draftMessage.id,
    evidenceMessageEventId: draftEventId, evidenceVersion: textVersion(draft), previousCompletionEventId: null,
    producerId: member.id, summary: "Two-line welcome drafted by our newest member.", nextAction: "Post it on the board." });

  // 6. The newcomer sees the outcome of their own contribution.
  await page.locator("#topbar-settings").click();
  await page.locator("#results-panel > summary").click();
  const row = page.locator('[data-result-work-id="first-result"]');
  await row.waitFor();
  assert.equal(await row.locator("p").textContent(), "Two-line welcome drafted by our newest member.");
  await page.screenshot({ path: "test-results/first-result-journey.png", fullPage: true });

  // The newcomer sees their own name credited as the producer of the outcome.
  await page.locator("#settings-close").click();
  await page.locator('[data-work-record-id="first-result"] .work-details > summary').click();
  const details = page.locator('[data-work-record-id="first-result"] .work-details');
  assert.match(await details.textContent(), /Newcomer/, "receipt credits the newcomer by name");
  assert.match(await page.locator('[data-work-record-id="first-result"] .state').textContent(), /Done|Completed|complete/i, "work card shows the finished state");
  assert.deepEqual(errors, []);
});
