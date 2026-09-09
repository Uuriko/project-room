// Simulated human journeys against the real local service and disposable data.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { prepareInboxResult } from "./inbox-result-fixture.mjs";
import { SyntheticInboxTransport } from "../server/inbox-transport.mjs";
import { SyntheticMailFixture } from "./synthetic-mail-fixture.mjs";
import { join } from "node:path";
import { createInboxSandbox } from "./inbox-sandbox.mjs";

async function setup(t, mobile = false, simulate = false) {
  const f = createAcceptanceFixture(), account = f.store.accountForMember("commons", "owner"), accountKey = f.store.issueAccountAccessKey(account.id);
  const slot = f.store.createAccountSessionSlot(), session = f.store.loginAccountSession(slot.token, accountKey, 0);
  const apply = request => f.store.inbox.apply(slot.token, request, session.sessionBinding);
  const source = (sourceId = "note", expectedRevision = 0, paragraphs = ["Could we make the launch note warmer?", "Private budget: 4200."]) => ({
    action: "source.save", requestId: crypto.randomUUID(), sourceId, expectedRevision,
    data: { adapter: "synthetic", sender: "maya@example.test", recipient: "you@example.test", subject: sourceId === "note" ? "A quieter launch" : "Friday catch-up", paragraphs }
  });
  apply(source()); apply(source("second"));
  const provider = simulate ? new SyntheticMailFixture(join(f.directory, "mail.sqlite")) : null;
  const server = createRoomServer({ store: f.store, streamInterval: 50,
    syntheticInboxTransport: provider ? new SyntheticInboxTransport(f.store.inbox, provider) : null }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port, browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); provider?.close(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
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
  return { ...f, page, origin, browser, inbox, pick, saved, capture, apply, source, slot, session, provider };
}

async function previewReply(f, body = "A private reply 🪷") {
  const p = f.page;
  await p.locator("#inbox-draft").fill(body); await p.locator("#inbox-save").click();
  await p.getByText("Saved · only you", { exact: true }).waitFor();
  await p.locator("#inbox-send-preview").click();
  await p.waitForFunction(() => !document.getElementById("inbox-send-confirm").disabled);
}
for (const mobile of [false, true]) test(`sample reply ${mobile ? "mobile" : "desktop"}: direct reply needs no work and preserves conversation drafts`, { timeout: 35000 }, async t => {
  const f = await setup(t, mobile, true), p = f.page, before = f.store.room("commons");
  await p.locator("#message-input").fill("Unsent room note"); await f.inbox(); await f.pick("note");
  await previewReply(f); assert.equal(f.provider.count(), 0);
  assert.match(await p.locator("#inbox-send-addresses").textContent(), /you@example.test → maya@example.test/);
  assert.equal(await p.locator("#inbox-send-body").textContent(), "A private reply 🪷");
  await f.capture(mobile ? "sample-preview-mobile" : "sample-preview-desktop");
  await p.locator("#inbox-send-confirm").click();
  await p.getByText("Sample accepted · delivery unconfirmed", { exact: true }).waitFor();
  assert.equal(f.provider.count(), 1); assert.equal(f.provider.submits, 1);
  assert.deepEqual(f.store.room("commons"), before);
  assert.equal(f.saved().draft.body, "A private reply 🪷");
  await p.locator("#nav-rooms").click(); assert.equal(await p.locator("#message-input").inputValue(), "Unsent room note");
  await f.inbox(); await f.pick("note");
  await p.locator("#inbox-send-view").click(); assert.equal(await p.locator("#inbox-send-confirm").isVisible(), false);
  await p.locator("#inbox-send-close").click();
  await p.reload(); await p.locator("#nav-inbox").waitFor(); await f.inbox(); await f.pick("note");
  await p.getByText("Sample accepted · delivery unconfirmed", { exact: true }).waitFor();
  assert.equal(await p.locator("#inbox-send-preview").isVisible(), false);
  assert.equal(f.provider.submits, 1);
  await f.capture(mobile ? "sample-accepted-mobile" : "sample-accepted-desktop");
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
test("sample reply: reviewed result returns privately, then unknown acceptance reconciles without resending", { timeout: 35000 }, async t => {
  const f = await setup(t, false, true), p = f.page;
  const result = prepareInboxResult(f, f.slot.token, f.session.sessionBinding);
  await f.inbox(); await f.pick("note");
  await p.locator("[data-inbox-result]").click(); await p.locator("#inbox-result-use").click();
  await p.getByText("Saved · only you", { exact: true }).waitFor();
  await p.locator("#inbox-send-preview").click();
  await p.waitForFunction(() => !document.getElementById("inbox-send-confirm").disabled);
  assert.equal(await p.locator("#inbox-send-body").textContent(), result.body);
  f.provider.mode = "after"; await p.locator("#inbox-send-confirm").click();
  await p.getByText("Sample outcome unknown", { exact: true }).waitFor();
  await f.capture("sample-unknown");
  assert.equal(f.provider.submits, 1); assert.equal(f.provider.count(), 1);
  await p.locator("#inbox-send-check").click();
  await p.getByText("Sample accepted · delivery unconfirmed", { exact: true }).waitFor();
  const send = f.store.inbox.sends(f.slot.token, "note", f.session.sessionBinding).sends[0];
  f.provider.outcome(send.providerId, "delivered");
  await p.locator("#inbox-send-check").click(); await p.getByText("Sample delivered", { exact: true }).waitFor();
  assert.equal(f.provider.submits, 1);
  assert.equal(JSON.stringify(f.store.snapshot(f.keys.producer, "commons")).includes("maya@example.test"), false);
});
test("sample reply: lost reservation acknowledgement survives reload as metadata, then requires review before dispatch", { timeout: 35000 }, async t => {
  const f = await setup(t, false, true), p = f.page; await f.inbox(); await f.pick("note"); await previewReply(f);
  let lost = true;
  await p.route("**/api/inbox/commands", async route => {
    if (lost && route.request().postDataJSON()?.action === "send.reserve") { lost = false; await route.fetch(); return route.abort(); }
    return route.continue();
  });
  await p.locator("#inbox-send-confirm").click(); await p.getByText("Reply unconfirmed. Check status.", { exact: true }).waitFor();
  const retained = await p.evaluate(() => sessionStorage.getItem("project-room:pending-private-send:v1"));
  assert.ok(retained); assert.equal(retained.includes("A private reply"), false); assert.equal(retained.includes("maya@"), false);
  assert.equal(f.provider.submits, 0);
  await p.reload(); await p.locator("#nav-inbox").waitFor(); await f.inbox(); await f.pick("note");
  await p.locator("#inbox-send-check").click(); await p.locator("#inbox-send-resume").waitFor();
  assert.equal(f.provider.submits, 0);
  await p.locator("#inbox-send-resume").click(); await p.locator("#inbox-send-confirm").click();
  await p.getByText("Sample accepted · delivery unconfirmed", { exact: true }).waitFor();
  assert.equal(f.provider.submits, 1); assert.equal(f.store.inbox.sends(f.slot.token, "note", f.session.sessionBinding).sends.length, 1);
});
test("sample reply: changed saved text refuses an old preview without sending", { timeout: 35000 }, async t => {
  const f = await setup(t, false, true), p = f.page; await f.inbox(); await f.pick("note"); await previewReply(f);
  f.apply({ action: "draft.save", requestId: "changed-draft", sourceId: "note", sourceRevision: 1, expectedRevision: 1, body: "A changed reply" });
  await p.locator("#inbox-send-confirm").click(); await p.locator("#inbox-conflict").waitFor();
  assert.equal(f.provider.submits, 0); assert.equal(f.store.inbox.sends(f.slot.token, "note", f.session.sessionBinding).sends.length, 0);
  assert.equal(await p.locator("#inbox-draft").inputValue(), "A private reply 🪷");
});
test("sample reply: mismatched preview text is never actionable", { timeout: 35000 }, async t => {
  const f = await setup(t, false, true), p = f.page; await f.inbox(); await f.pick("note");
  await p.locator("#inbox-draft").fill("Original"); await p.locator("#inbox-save").click();
  await p.getByText("Saved · only you", { exact: true }).waitFor();
  await p.route("**/send-context", async route => { const response = await route.fetch(), json = await response.json(); json.preview.body = "Altered"; await route.fulfill({ response, json }); });
  await p.locator("#inbox-send-preview").click();
  await p.getByText("Couldn’t verify this reply. Close and try again.", { exact: true }).waitFor();
  assert.equal(await p.locator("#inbox-send-confirm").isEnabled(), false);
  assert.equal(f.provider.count(), 0);
});
test("sample reply: queued cancellation has an exact retry after a lost acknowledgement", { timeout: 35000 }, async t => {
  const f = await setup(t, false, true), p = f.page; await f.inbox(); await f.pick("note"); await previewReply(f);
  const preview = f.store.inbox.sendContext(f.slot.token, "note", f.session.sessionBinding).preview;
  f.apply({ action: "send.reserve", requestId: "queued-reply", sourceId: "note", sourceRevision: preview.sourceRevision, draftRevision: preview.draftRevision, previewVersion: preview.previewVersion });
  await p.locator("#inbox-send-close").click(); await p.locator("#nav-rooms").click(); await f.inbox();
  await p.locator("#inbox-send-cancel").waitFor();
  let lost = true;
  await p.route("**/api/inbox/commands", async route => {
    if (lost && route.request().postDataJSON()?.action === "send.cancel") { lost = false; await route.fetch(); return route.abort(); }
    return route.continue();
  });
  await p.locator("#inbox-send-cancel").click(); await p.getByText("Reply unconfirmed. Check status.", { exact: true }).waitFor();
  await p.locator("#inbox-send-check").click(); await p.getByText("Sample cancelled · not sent", { exact: true }).waitFor();
  assert.equal(f.provider.submits, 0);
  assert.equal(f.store.inbox.sends(f.slot.token, "note", f.session.sessionBinding).sends[0].revision, 1);
});
test("sample reply: lost dispatch response plus failed status read offers checking, never another send", { timeout: 35000 }, async t => {
  const f = await setup(t, false, true), p = f.page; await f.inbox(); await f.pick("note"); await previewReply(f);
  let lost = true, unavailable = false;
  await p.route("**/api/inbox/simulation", async route => {
    if (lost && route.request().postDataJSON()?.action === "dispatch") { lost = false; await route.fetch(); unavailable = true; return route.abort(); }
    return route.continue();
  });
  await p.route("**/sources/note/sends", async route => unavailable ? route.fulfill({ status: 503, json: { error: { code: "unavailable" } } }) : route.continue());
  await p.locator("#inbox-send-confirm").click();
  await p.getByText("Outcome unconfirmed. Check status before continuing.", { exact: true }).waitFor();
  assert.equal(await p.locator("#inbox-send-resume").isVisible(), false);
  assert.equal(await p.locator("#inbox-send-preview").isVisible(), false);
  unavailable = false; await p.locator("#inbox-send-check").click();
  await p.getByText("Sample accepted · delivery unconfirmed", { exact: true }).waitFor();
  assert.equal(f.provider.submits, 1); assert.equal(f.provider.count(), 1);
});
test("sample reply: a late preview cannot reopen private text after another tab changes account", { timeout: 35000 }, async t => {
  const f = await setup(t, false, true), p = f.page; await f.inbox(); await f.pick("note");
  await p.locator("#inbox-draft").fill("Original account private reply"); await p.locator("#inbox-save").click();
  await p.getByText("Saved · only you", { exact: true }).waitFor();
  let release, reached; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { reached = resolve; });
  await p.route("**/send-context", async route => { const response = await route.fetch(); reached(); await held; await route.fulfill({ response }); });
  await p.locator("#inbox-send-preview").click(); await started;
  const other = await p.context().newPage(); await other.goto(f.origin + "/?room=commons");
  await other.locator("#main").waitFor(); await other.locator("#signout-button").click();
  await other.locator("#auth-panel").waitFor();
  const guest = f.store.accountForMember("commons", "guest"), key = f.store.issueAccountAccessKey(guest.id);
  await other.locator("#access-key").fill(key); await other.locator("#auth-form button").click();
  await other.locator("#main").waitFor(); await p.locator("#auth-panel").waitFor(); release();
  await p.waitForLoadState("networkidle");
  assert.equal(await p.locator("#inbox-send-dialog").isVisible(), false);
  assert.equal(await p.locator("#inbox-send-body").textContent(), "");
  assert.equal(await p.locator("#inbox-send-addresses").textContent(), "");
  assert.equal(await p.evaluate(() => sessionStorage.getItem("project-room:pending-private-send:v1")), null);
  assert.equal(f.provider.submits, 0);
});
test("sample launcher: an empty room owner can sign in and finish a sample reply", { timeout: 35000 }, async t => {
  const sample = await createInboxSandbox(), browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await sample.close(); rmSync(sample.directory, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(9000); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(sample.url); await page.locator("#access-key").fill(sample.accountKey); await page.locator("#auth-form button").click();
  await page.locator("#inbox-reader").waitFor();
  assert.equal(await page.locator("#main").isVisible(), false);
  await page.locator("#inbox-draft").fill("Let’s try one small idea.");
  await page.locator("#inbox-save").click(); await page.getByText("Saved · only you", { exact: true }).waitFor();
  await page.locator("#inbox-send-preview").click(); await page.locator("#inbox-send-confirm").click();
  await page.getByText("Sample accepted · delivery unconfirmed", { exact: true }).waitFor();
  mkdirSync("test-results", { recursive: true }); await page.screenshot({ path: "test-results/inbox-local-sandbox.png", fullPage: true });
  assert.deepEqual(errors, []);
});

test("sample arrival: two samples and existing localhost cookies coexist in one browser", { timeout: 35000 }, async t => {
  const first = await createInboxSandbox(), second = await createInboxSandbox(), browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    for (const sample of [first, second]) { await sample.close(); rmSync(sample.directory, { recursive: true, force: true }); }
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const original = ["account_session", "room_session"].map(name => ({
    name, value: "existing-development-cookie", domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict"
  }));
  await context.addCookies(original);
  const allowed = new Set([first, second].map(s => new URL(s.url).origin)), external = [], errors = [];
  await context.route("**/*", route => {
    if (!allowed.has(new URL(route.request().url()).origin)) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const pages = [];
  for (const sample of [first, second]) {
    const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(9000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(sample.url); await page.locator("#access-key").fill(sample.accountKey); await page.locator("#auth-form button").click();
    await page.locator("#inbox-reader").waitFor();
  }
  const [a, b] = pages;
  await a.locator("#inbox-draft").fill("Only in the first sample");
  await a.locator("#inbox-save").click(); await a.getByText("Saved · only you", { exact: true }).waitFor();
  await b.reload(); await b.locator("#inbox-reader").waitFor();
  assert.equal(await b.locator("#inbox-draft").inputValue(), "");
  await a.reload(); await a.locator("#inbox-reader").waitFor();
  assert.equal(await a.locator("#inbox-draft").inputValue(), "Only in the first sample");
  await b.locator("#signout-button").click(); await b.locator("#auth-panel").waitFor();
  await a.reload(); await a.locator("#inbox-reader").waitFor();
  assert.equal(await a.locator("#inbox-draft").inputValue(), "Only in the first sample");
  const cookies = await context.cookies();
  for (const cookie of original) assert.equal(cookies.find(c => c.name === cookie.name)?.value, cookie.value);
  assert.equal(cookies.filter(c => /^sample_.*_account_session$/.test(c.name)).length, 2);
  mkdirSync("test-results", { recursive: true });
  await a.screenshot({ path: "test-results/inbox-sample-coexistence.png", fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});

for (const mobile of [false, true]) test(`inbox arrival ${mobile ? "mobile" : "desktop"}: destinations survive reload and record links return to Rooms`, { timeout: 35000 }, async t => {
  const f = await setup(t, mobile), p = f.page;
  await f.inbox(); assert.equal(new URL(p.url()).hash, "#pr-view/inbox");
  await p.reload(); await p.locator("#inbox-reader").waitFor();
  assert.equal(await p.locator("#main").isVisible(), false);
  await p.evaluate(() => { location.hash = "#pr-record/room/commons"; });
  await p.locator("#main").waitFor();
  assert.equal(await p.locator("#inbox-panel").isVisible(), false);
  await f.inbox(); await p.locator("#nav-rooms").click();
  assert.equal(new URL(p.url()).hash, "#pr-view/rooms");
  await p.reload(); await p.locator("#main").waitFor();
  assert.equal(await p.locator("#inbox-panel").isVisible(), false);
});

for (const mobile of [false, true]) test(`inbox continuity ${mobile ? "mobile" : "desktop"}: restore selected message and reading position without storing content`, { timeout: 35000 }, async t => {
  const f = await setup(t, mobile), p = f.page;
  f.apply(f.source("note", 1, Array.from({ length: 15 }, (_, i) => `Paragraph ${i}. ` + "A longer private message to read carefully. ".repeat(12))));
  f.apply(f.source("second", 1));
  await f.inbox(); await f.pick("note");
  await p.evaluate(mobile => { if (mobile) scrollTo(0, 500); else document.querySelector("#inbox-reader").scrollTop = 500; }, mobile);
  const top = await p.evaluate(mobile => mobile ? scrollY : document.querySelector("#inbox-reader").scrollTop, mobile);
  assert.ok(top > 300);
  await p.reload(); await p.locator("#inbox-reader").waitFor();
  assert.equal(await p.locator("#inbox-list [aria-current=true]").getAttribute("data-source-id"), "note");
  await p.waitForFunction(({ mobile, top }) => Math.abs((mobile ? scrollY : document.querySelector("#inbox-reader").scrollTop) - top) < 3, { mobile, top });
  mkdirSync("test-results", { recursive: true });
  await p.screenshot({ path: `test-results/inbox-continuity-${mobile ? "mobile" : "desktop"}.png` });
  const raw = await p.evaluate(() => sessionStorage.getItem("project-room:inbox-position:v1"));
  assert.equal(JSON.parse(raw).sourceId, "note");
  assert.equal(raw.includes("longer private"), false); assert.equal(raw.includes("maya@example.test"), false);
  assert.equal(new URL(p.url()).hash, "#pr-view/inbox", "private source IDs are not shared in the URL");
  await p.locator("#nav-rooms").click(); await f.inbox();
  await p.waitForFunction(({ mobile, top }) => Math.abs((mobile ? scrollY : document.querySelector("#inbox-reader").scrollTop) - top) < 3, { mobile, top });
  await p.locator("#signout-button").click(); await p.locator("#auth-panel").waitFor();
  assert.equal(await p.evaluate(() => sessionStorage.getItem("project-room:inbox-position:v1")), null);
});

test("inbox continuity: a changed source keeps selection but discards its old reading position", { timeout: 35000 }, async t => {
  const f = await setup(t), p = f.page;
  const paragraphs = Array.from({ length: 15 }, (_, i) => `Earlier paragraph ${i}. ` + "Read this long message. ".repeat(15));
  f.apply(f.source("note", 1, paragraphs)); await f.inbox(); await f.pick("note");
  await p.locator("#inbox-reader").evaluate(node => { node.scrollTop = 500; });
  await p.locator("#nav-rooms").click();
  f.apply(f.source("note", 2, ["Updated first paragraph.", ...paragraphs.slice(1)]));
  await p.reload(); await p.locator("#main").waitFor(); await f.inbox();
  assert.equal(await p.locator("#inbox-list [aria-current=true]").getAttribute("data-source-id"), "note");
  assert.equal(await p.locator("#inbox-reader").evaluate(node => node.scrollTop), 0);
  assert.match(await p.locator("#inbox-source-body").textContent(), /^Updated first paragraph/);
});

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
  assert.equal(await p.evaluate(() => sessionStorage.getItem("project-room:inbox-position:v1")), null);
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
