// A two-message email conversation with an attachment, rendered in the
// real browser UI: the conversation lists both entries (depth-indented,
// the open message marked, entries open their source), attachment
// descriptors show name/type/size only, and the UI stays honest that
// file downloads are unavailable.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { emailContractFixture } from "./email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { fillAccessKey } from "./auth-signin.mjs";

function seedThread(f) {
  const raw = emailContractFixture(); raw.connection.accountId = f.store.accountForMember("commons", "owner").id;
  const apply = request => f.store.email.apply(f.slot.token, request, f.session.sessionBinding);
  apply({ action: "connection.configure", requestId: crypto.randomUUID(), connectionId: raw.connection.id, expectedRevision: 0, profile: raw.connection });
  const importMessage = (message, options) => {
    const envelope = normalizeGraphEmail(raw.connection, message, options);
    const state = f.store.email.state(f.slot.token, raw.connection.id, message.parentFolderId, f.session.sessionBinding);
    apply({ action: "page.apply", requestId: crypto.randomUUID(), connectionId: raw.connection.id, connectionRevision: 1,
      folderId: message.parentFolderId, expectedRevision: state.folder?.revision ?? 0, expectedCursor: state.expectedCursor,
      cursor: crypto.randomUUID(), complete: true, reset: state.needsReset, observations: [{ kind: "message", expectedSourceRevision: 0, envelope }] });
    return envelope.sourceId;
  };
  const parent = structuredClone(raw.message);
  parent.id = "AQMkThreadParent="; parent.changeKey = "CQAAthread-parent=";
  parent.internetMessageId = "<thread-parent@example.test>"; parent.conversationId = "AAQkThreadConv=";
  parent.subject = "Launch plan"; parent.body.content = "Here is the launch plan.";
  parent.internetMessageHeaders = [];
  const parentOptions = structuredClone(raw.options);
  parentOptions.attachmentObservation.messageId = parent.id;
  parentOptions.attachmentObservation.messageRevision = parent.changeKey;
  const parentId = importMessage(parent, parentOptions);
  const child = structuredClone(raw.message);
  child.id = "AQMkThreadChild="; child.changeKey = "CQAAthread-child=";
  child.internetMessageId = "<thread-child@example.test>"; child.conversationId = "AAQkThreadConv=";
  child.subject = "Re: Launch plan"; child.body.content = "Agreed — let us do it.";
  child.hasAttachments = false;
  child.internetMessageHeaders = [{ name: "In-Reply-To", value: "<thread-parent@example.test>" }];
  const childOptions = { idType: "immutable",
    attachmentObservation: { messageId: child.id, messageRevision: child.changeKey, complete: true, items: [] } };
  const childId = importMessage(child, childOptions);
  return { parentId, childId };
}

async function setup(t, mobile = false) {
  const f = createAcceptanceFixture(), account = f.store.accountForMember("commons", "owner"), accountKey = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, accountKey, 0);
  f.slot = slot; f.session = session;
  const ids = seedThread(f);
  const server = createRoomServer({ store: f.store, streamInterval: 50 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(9000); const errors = [], external = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("dialog", dialog => dialog.accept());
  await page.route("**/*", route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  await page.goto(origin + "/?room=commons");
  await fillAccessKey(page, accountKey); await page.locator('#auth-form button[type="submit"]').click();
  await page.locator("#main").waitFor({ state: "visible" });
  const inbox = async () => {
    await page.locator("#nav-inbox").click(); await page.locator("#inbox-reader").waitFor({ state: "visible" });
    await page.locator("#inbox-add-connection:not([hidden])").waitFor({ state: "attached" });
  };
  const pick = async id => {
    if (mobile && await page.locator("#inbox-back").isVisible()) await page.locator("#inbox-back").click();
    await page.locator(`[data-source-id="${id}"]`).click();
    await page.waitForFunction(id => document.querySelector("#inbox-list [aria-current=true]")?.dataset.sourceId === id, id);
    await page.locator("#inbox-reader").waitFor({ state: "visible" });
  };
  const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: "test-results/inbox-conversation-" + name + ".png", fullPage: true }); };
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(external, []); });
  return { ...f, page, origin, browser, inbox, pick, capture, ids };
}

for (const mobile of [false, true]) test(`conversation and attachments ${mobile ? "mobile" : "desktop"}: two entries render, descriptors stay metadata-only`, { timeout: 45000 }, async t => {
  const f = await setup(t, mobile), p = f.page;
  await f.inbox(); await f.pick(f.ids.parentId);
  // Attachment descriptors: name, type and size only — never bytes, never a download.
  await p.locator("#inbox-attachments:not([hidden])").waitFor();
  assert.equal(await p.locator("#inbox-attachment-list li").count(), 1);
  assert.equal(await p.locator("#inbox-attachment-list li").first().textContent(), "brief.txt · text/plain · 128 bytes");
  assert.equal(await p.locator("#inbox-attachments a[download], #inbox-attachments button").count(), 0);
  assert.match(await p.locator("#inbox-attachments").textContent(), /file downloads are unavailable/);
  assert.match(await p.locator("#inbox-email-metadata").textContent(), /1 attachment · files unavailable/);
  // The conversation: both entries, the reply indented, the open message marked.
  await p.locator("#inbox-thread-toggle").click();
  await p.locator("#inbox-thread:not([hidden])").waitFor();
  const rows = p.locator("#inbox-thread-list > div");
  assert.equal(await rows.count(), 2);
  const buttons = p.locator("#inbox-thread-list button");
  assert.equal(await buttons.count(), 2);
  const labels = [await buttons.nth(0).textContent(), await buttons.nth(1).textContent()];
  assert.ok(labels.some(l => l.includes("(this message)")), "the open message is marked");
  const marked = labels[0].includes("(this message)") ? 0 : 1;
  assert.equal(await buttons.nth(marked).isDisabled(), true);
  const indents = [await buttons.nth(0).evaluate(el => el.style.marginLeft), await buttons.nth(1).evaluate(el => el.style.marginLeft)];
  assert.ok(indents.some(m => m !== "0px" && m !== ""), "the reply entry is depth-indented");
  // An entry opens its source in the reader.
  const other = marked === 0 ? 1 : 0;
  await buttons.nth(other).click();
  await p.waitForFunction(id => document.querySelector("#inbox-list [aria-current=true]")?.dataset.sourceId === id, f.ids.childId);
  assert.match(await p.locator("#inbox-subject").textContent(), /Re: Launch plan/);
  await f.capture(mobile ? "mobile" : "desktop");
});
