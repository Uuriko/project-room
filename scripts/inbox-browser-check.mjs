// Simulated human journeys against the real local service and disposable data.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { prepareInboxResult } from "./inbox-result-fixture.mjs";

async function setup(t, mobile = false) {
  const f = createAcceptanceFixture(), account = f.store.accountForMember("commons", "owner"), accountKey = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, accountKey, 0);
  const apply = request => f.store.inbox.apply(slot.token, request, session.sessionBinding);
  const source = (sourceId = "note", expectedRevision = 0, paragraphs = ["Could we make the launch note warmer?", "Private budget: 4200."]) => ({
    action: "source.save", requestId: crypto.randomUUID(), sourceId, expectedRevision,
    data: { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: sourceId === "note" ? "A quieter launch" : "Friday catch-up", paragraphs }
  });
  apply(source()); apply(source("second"));
  const server = createRoomServer({ store: f.store, streamInterval: 50 }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(9000); const errors = [], external = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("dialog", dialog => dialog.accept());
  await page.route("**/*", route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  await page.goto(origin + "/?room=commons");
  await page.locator("#access-key").fill(accountKey); await page.locator("#auth-form button").click();
  await page.locator("#main").waitFor({ state: "visible" });
  const inbox = async () => { await page.locator("#nav-inbox").click(); await page.locator("#inbox-reader").waitFor({ state: "visible" }); };
  const pick = async id => {
    if (mobile && await page.locator("#inbox-back").isVisible()) await page.locator("#inbox-back").click();
    await page.locator(`[data-source-id="${id}"]`).click();
    await page.waitForFunction(id => document.querySelector("#inbox-list [aria-current=true]")?.dataset.sourceId === id, id);
    await page.locator("#inbox-reader").waitFor({ state: "visible" });
  };
  const saved = () => f.store.inbox.read(slot.token, "note", session.sessionBinding);
  const capture = async name => { mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: "test-results/inbox-" + name + ".png", fullPage: true }); };
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(external, []); });
  return { ...f, page, origin, browser, inbox, pick, saved, capture, apply, source, slot, session };
}

for (const mobile of [false, true]) test(`real inbox ${mobile ? "mobile" : "desktop"}: private draft, navigation, reload and selected sharing`, { timeout: 35000 }, async t => {
  const f = await setup(t, mobile), p = f.page;
  await p.locator("#message-input").fill("Unsent room thought"); await f.inbox(); await f.pick("note");
  const before = f.store.room("commons").sequence;
  await p.locator("#inbox-draft").fill("A warm hello"); await p.locator("#inbox-draft").press("Enter"); await p.locator("#inbox-draft").press("x");
  assert.equal(f.saved().draft, null); assert.equal(await p.locator("#inbox-draft").inputValue(), "A warm hello\nx");
  await f.pick("second"); await f.pick("note"); assert.equal(await p.locator("#inbox-draft").inputValue(), "A warm hello\nx");
  await p.locator("#nav-rooms").click(); assert.equal(await p.locator("#message-input").inputValue(), "Unsent room thought");
  await f.inbox(); await p.locator("#inbox-save").click(); await p.getByText("Saved · only you", { exact: true }).waitFor();
  assert.equal(f.saved().draft.body, "A warm hello\nx"); assert.equal(f.store.room("commons").sequence, before);
  await f.capture(mobile ? "mobile-draft" : "desktop-draft");
  await p.reload(); await p.locator("#nav-inbox").waitFor(); await f.inbox(); await f.pick("note");
  assert.equal(await p.locator("#inbox-draft").inputValue(), "A warm hello\nx");
  await p.locator("#inbox-ask").click(); await p.locator("#inbox-share-paragraphs input").first().waitFor();
  assert.equal(await p.locator("#inbox-share-confirm").isEnabled(), false);
  await p.locator("#inbox-share-paragraphs input").first().check();
  await f.capture(mobile ? "mobile-share" : "desktop-share"); await p.locator("#inbox-share-confirm").click();
  await p.locator("#inbox-share-dialog").waitFor({ state: "hidden" }); await p.locator("#main").waitFor({ state: "visible" });
  assert.equal(f.store.room("commons").sequence, before + 1);
  const snapshot = JSON.stringify(f.store.snapshot(f.keys.producer, "commons"));
  for (const privateText of ["4200", "maya@example.test", "A warm hello"]) assert.equal(snapshot.includes(privateText), false);
  assert.equal(snapshot.includes("Could we make the launch note warmer?"), true);
  await f.inbox(); assert.equal(await p.locator("#inbox-draft").inputValue(), "A warm hello\nx");
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test("real inbox: concurrent draft and changed source require a deliberate choice", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page; await f.inbox(); await f.pick("note");
  await p.locator("#inbox-draft").fill("My local alternative");
  f.apply({ action: "draft.save", requestId: "elsewhere", sourceId: "note", expectedRevision: 0, sourceRevision: 1, body: "Saved in another tab" });
  f.apply(f.source("note", 1, ["The launch date moved.", "Still private"]));
  await p.locator("#inbox-save").click(); await p.locator("#inbox-conflict").waitFor({ state: "visible" });
  assert.equal(await p.locator("#inbox-draft").inputValue(), "My local alternative");
  assert.equal(await p.locator("#inbox-remote-draft").textContent(), "Saved in another tab");
  assert.equal(await p.locator("#inbox-save").isEnabled(), false);
  assert.match(await p.locator("#inbox-source-body").textContent(), /date moved/);
  await f.capture("draft-conflict"); await p.locator("#inbox-use-mine").click(); await p.locator("#inbox-save").click();
  await p.getByText("Saved · only you", { exact: true }).waitFor();
  assert.equal(f.saved().draft.body, "My local alternative"); assert.equal(f.saved().draft.sourceRevision, 2); assert.equal(f.saved().draft.revision, 2);
});

test("real inbox: lost save response retries exact request without a second revision", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page; await f.inbox(); await f.pick("note");
  let lost = false; const ids = [];
  await p.route("**/api/inbox/commands", async route => {
    ids.push(route.request().postDataJSON().requestId);
    if (!lost) { lost = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await p.locator("#inbox-draft").fill("Saved despite lost confirmation");
  await p.locator("#inbox-save").click(); await p.getByRole("button", { name: "Confirm save", exact: true }).waitFor();
  assert.equal(await p.locator("#inbox-draft").getAttribute("readonly"), "");
  assert.equal(f.saved().draft.revision, 1); await p.locator("#inbox-save").click();
  await p.getByText("Saved · only you", { exact: true }).waitFor();
  assert.deepEqual(ids, [ids[0], ids[0]]); assert.equal(f.saved().draft.revision, 1);
});

test("real inbox: unknown share survives reload as metadata and never posts twice", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page; await f.inbox(); await f.pick("note");
  let lost = false; const ids = [], before = f.store.room("commons").sequence;
  await p.route("**/api/inbox/commands", async route => {
    ids.push(route.request().postDataJSON().requestId);
    if (!lost) { lost = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await p.locator("#inbox-ask").click(); await p.locator("#inbox-share-paragraphs input").first().check();
  await p.locator("#inbox-share-confirm").click(); await p.getByRole("button", { name: "Confirm share", exact: true }).waitFor();
  assert.equal(f.store.room("commons").sequence, before + 1);
  const stored = await p.evaluate(() => sessionStorage.getItem("project-room:pending-private-share:v1"));
  assert.equal(stored.includes("4200"), false); assert.equal(stored.includes("maya@"), false);
  await p.reload(); await p.locator("#nav-inbox").waitFor(); await f.inbox();
  await p.locator("#inbox-ask").click(); await p.getByRole("button", { name: "Confirm share", exact: true }).waitFor();
  assert.equal(await p.locator("#inbox-share-paragraphs input").count(), 0);
  await p.locator("#inbox-share-confirm").click(); await p.locator("#inbox-share-dialog").waitFor({ state: "hidden" });
  assert.equal(f.store.room("commons").sequence, before + 1); assert.deepEqual(ids, [ids[0], ids[0]]);
});

test("real inbox: audience changes invalidate selection without posting", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page; await f.inbox(); await f.pick("note");
  await p.locator("#inbox-ask").click(); await p.locator("#inbox-share-paragraphs input").first().check();
  f.store.command(f.keys.owner, "commons", { id: crypto.randomUUID(), type: "member.added", data: { memberId: "new-person", displayName: "New person", kind: "human", permissions: [] } });
  const before = f.store.room("commons").sequence;
  await p.locator("#inbox-share-confirm").click(); await p.getByText("Source or audience changed. Close and review again.", { exact: true }).waitFor();
  assert.equal(f.store.room("commons").sequence, before);
  await p.locator("#inbox-share-close").click(); await p.locator("#inbox-ask").click();
  await p.waitForFunction(() => document.querySelector("#inbox-share-audience").textContent.includes("New person"));
  assert.equal(await p.locator("#inbox-share-paragraphs input:checked").count(), 0);
});

test("real inbox: a saved reply based on an old source requires review after reload", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page;
  f.apply({ action: "draft.save", requestId: "old-source-draft", sourceId: "note", expectedRevision: 0, sourceRevision: 1, body: "Earlier private reply" });
  f.apply(f.source("note", 1, ["The source changed before opening the inbox."]));
  await f.inbox(); await f.pick("note");
  await p.locator("#inbox-draft").fill("My edited reply"); assert.equal(await p.locator("#inbox-save").isEnabled(), false);
  await p.locator("#inbox-review").click(); await p.locator("#inbox-conflict").waitFor({ state: "visible" });
  await p.locator("#inbox-use-mine").click(); await p.locator("#inbox-save").click();
  await p.getByText("Saved · only you", { exact: true }).waitFor(); assert.equal(f.saved().draft.sourceRevision, 2);
});

test("real inbox: another tab changing the browser account clears private content and delayed reads", { timeout: 35000 }, async t => {
  const f = await setup(t), p = f.page; await f.inbox(); await f.pick("note");
  await p.locator("#inbox-draft").fill("Only the original account");
  // A never-opened source guarantees a real held read, regardless of the initial
  // inbox's timestamp ordering and which earlier source is already cached.
  f.apply(f.source("held")); await f.inbox();
  let release, reached; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { reached = resolve; });
  await p.route("**/api/inbox/sources/held", async route => { const response = await route.fetch(); reached(); await held; await route.fulfill({ response }); });
  const read = p.locator('[data-source-id="held"]').click(); await started; await read;
  const other = await p.context().newPage(); await other.goto(f.origin + "/?room=commons");
  await other.locator("#main").waitFor({ state: "visible" }); await other.locator("#signout-button").click();
  await other.locator("#auth-panel").waitFor({ state: "visible" });
  const guest = f.store.accountForMember("commons", "guest"), key = f.store.issueAccountAccessKey(guest.id);
  await other.locator("#access-key").fill(key); await other.locator("#auth-form button").click(); await other.locator("#main").waitFor({ state: "visible" });
  await p.locator("#auth-panel").waitFor({ state: "visible" }); release();
  await p.waitForLoadState("networkidle");
  assert.equal(await p.locator("#inbox-draft").inputValue(), "");
  assert.equal(await p.locator("#inbox-source-body").textContent(), "");
  assert.equal(await p.locator("#inbox-panel").isVisible(), false);
  await other.locator("#nav-inbox").click(); await other.getByText("No messages yet.", { exact: true }).waitFor();
  assert.equal(await other.locator("#inbox-list button").count(), 0);
});

test("real inbox: unavailable browser storage retains an unknown share in the open tab", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page; await f.inbox(); await f.pick("note");
  await p.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("Synthetic storage refusal"); }; });
  let refused = false;
  await p.route("**/api/inbox/commands", async route => {
    if (!refused) { refused = true; await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Synthetic outage" } } }); }
    else await route.continue();
  });
  const before = f.store.room("commons").sequence;
  await p.locator("#inbox-ask").click(); await p.locator("#inbox-share-paragraphs input").first().check(); await p.locator("#inbox-share-confirm").click();
  await p.getByText("Share unconfirmed. Keep this tab open and retry.", { exact: true }).waitFor();
  await p.locator("#inbox-share-close").click(); await p.locator("#inbox-ask").click();
  await p.getByRole("button", { name: "Confirm share", exact: true }).waitFor();
  assert.equal(await p.locator("#inbox-share-paragraphs input").count(), 0);
  await p.locator("#inbox-share-confirm").click(); await p.locator("#inbox-share-dialog").waitFor({ state: "hidden" });
  assert.equal(f.store.room("commons").sequence, before + 1);
});

for (const mobile of [false, true]) test(`reviewed reply ${mobile ? "mobile" : "desktop"}: room work returns as a private draft with editable provenance`, { timeout: 35000 }, async t => {
  const f = await setup(t, mobile), p = f.page, work = prepareInboxResult(f, f.slot.token, f.session.sessionBinding, { ready: false });
  await f.inbox(); await f.pick("note");
  await p.getByText("Work in progress", { exact: true }).waitFor();
  assert.equal(await p.locator("[data-inbox-result]").count(), 0);
  work.complete(); work.review();
  await p.locator("#nav-rooms").click(); await f.inbox();
  await p.getByText("Needs review and approval", { exact: true }).waitFor();
  work.decide();
  await p.locator("#nav-rooms").click(); await f.inbox();
  await p.locator("#inbox-draft").fill("Earlier private draft");
  await p.locator("[data-inbox-result]").click();
  await p.waitForFunction(body => document.querySelector("#inbox-result-body").textContent === body, work.body);
  assert.equal(await p.locator("#inbox-replaced-draft").textContent(), "Earlier private draft");
  await f.capture(mobile ? "reviewed-mobile" : "reviewed-desktop");
  const before = f.store.room("commons").sequence;
  await p.locator("#inbox-result-use").click(); await p.getByText("Saved · only you", { exact: true }).waitFor();
  assert.equal(await p.locator("#inbox-draft").inputValue(), work.body);
  assert.equal(f.saved().draft.origin.unchanged, true);
  assert.equal(await p.locator("#inbox-origin").textContent(), "Copied from room review");
  assert.equal(f.store.room("commons").sequence, before, "Adoption is private, not a room command or send");
  await p.locator("#inbox-draft").fill(work.body + "\nAn extra private thought.");
  assert.equal(await p.locator("#inbox-origin").textContent(), "Edited since room review");
  await p.locator("#inbox-save").click(); await p.getByText("Saved · only you", { exact: true }).waitFor();
  assert.equal(f.saved().draft.origin.unchanged, false);
  await p.reload(); await p.locator("#nav-inbox").waitFor(); await f.inbox(); await f.pick("note");
  assert.equal(await p.locator("#inbox-origin").textContent(), "Edited since room review");
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.capture(mobile ? "reviewed-mobile-edited" : "reviewed-desktop-edited");
});

test("reviewed reply: changed review and a lost adoption acknowledgement preserve exact intent", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page, work = prepareInboxResult(f, f.slot.token, f.session.sessionBinding);
  await f.inbox(); await f.pick("note"); await p.locator("#inbox-draft").fill("Keep this until adoption succeeds");
  await p.locator("[data-inbox-result]").click(); await p.locator("#inbox-result-use:not([disabled])").waitFor();
  work.review(); await p.locator("#inbox-result-use").click();
  await p.getByText("Result changed. Review again.", { exact: true }).waitFor();
  assert.equal(await p.locator("#inbox-draft").inputValue(), "Keep this until adoption succeeds"); assert.equal(f.saved().draft, null);
  await p.locator("[data-inbox-result]").click(); await p.locator("#inbox-result-use:not([disabled])").waitFor();
  let lost = false; const ids = [];
  await p.route("**/api/inbox/commands", async route => {
    ids.push(route.request().postDataJSON().requestId);
    if (!lost) { lost = true; await route.fetch(); await route.abort(); } else await route.continue();
  });
  await p.locator("#inbox-result-use").click(); await p.getByRole("button", { name: "Confirm save", exact: true }).waitFor();
  assert.equal(f.saved().draft.revision, 1); await p.locator("#inbox-save").click();
  await p.getByText("Saved · only you", { exact: true }).waitFor(); assert.deepEqual(ids, [ids[0], ids[0]]);
  assert.equal(f.saved().draft.revision, 1); assert.equal(await p.locator("#inbox-draft").inputValue(), work.body);
});

test("reviewed reply: mismatched preview text never enables adoption", { timeout: 30000 }, async t => {
  const f = await setup(t), p = f.page; prepareInboxResult(f, f.slot.token, f.session.sessionBinding);
  await f.inbox(); await f.pick("note");
  await p.route("**/room-results?*workItemId=*", async route => {
    const response = await route.fetch(), data = await response.json(); data.results[0].body = "Text that was never reviewed";
    await route.fulfill({ json: data });
  });
  await p.locator("[data-inbox-result]").click();
  await p.getByText("Couldn’t verify the result. Close and try again.", { exact: true }).waitFor();
  assert.equal(await p.locator("#inbox-result-use").isEnabled(), false); assert.equal(f.saved().draft, null);
});
