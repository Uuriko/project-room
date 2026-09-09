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
import { emailContractFixture } from "./email-contract-fixture.mjs";
import { normalizeGraphEmail } from "../server/graph-email.mjs";
import { seedRecordedReply } from "./reply-review-fixture.mjs";
import { prepareGraphReplyUpdate } from "../server/graph-reply-draft.mjs";
import { auditRecovery } from "../server/recovery.mjs";

function seedEmail(f) {
  const raw = emailContractFixture(); raw.connection.accountId = f.store.accountForMember("commons", "owner").id;
  const apply = request => f.store.email.apply(f.slot.token, request, f.session.sessionBinding);
  apply({ action: "connection.configure", requestId: crypto.randomUUID(), connectionId: raw.connection.id, expectedRevision: 0, profile: raw.connection });
  const importMessage = () => {
    const envelope = normalizeGraphEmail(raw.connection, raw.message, raw.options);
    const state = f.store.email.state(f.slot.token, raw.connection.id, raw.message.parentFolderId, f.session.sessionBinding);
    let revision = 0; try { revision = f.store.inbox.read(f.slot.token, envelope.sourceId, f.session.sessionBinding).source.revision; } catch (e) { if (e.status !== 404) throw e; }
    apply({ action: "page.apply", requestId: crypto.randomUUID(), connectionId: raw.connection.id, connectionRevision: 1,
      folderId: raw.message.parentFolderId, expectedRevision: state.folder?.revision ?? 0, expectedCursor: state.expectedCursor,
      cursor: crypto.randomUUID(), complete: true, reset: state.needsReset, observations: [{ kind: "message", expectedSourceRevision: revision, envelope }] });
    return envelope.sourceId;
  };
  return { raw, importMessage, disconnect: () => apply({ action: "connection.disconnect", requestId: crypto.randomUUID(), connectionId: raw.connection.id, expectedRevision: 1 }) };
}

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
async function reviewFixture(t, mobile = false) {
  const f = await setup(t, mobile), mail = seedEmail(f), sourceId = mail.importMessage();
  const provider = seedRecordedReply({ store: f.store, token: f.slot.token, binding: f.session.sessionBinding, sourceId });
  await f.inbox(); await f.pick(sourceId); await f.page.locator("#inbox-reply-open").waitFor();
  return { ...f, mail, sourceId, recorded: provider };
}

async function updateFixture(t, mobile = false) {
  const f = await reviewFixture(t, mobile), p = f.page, token = f.slot.token, binding = f.session.sessionBinding;
  await p.locator("#inbox-draft").fill("Friday works. Let’s build one small thing together.");
  await p.locator("#inbox-save").click(); await p.getByText("Saved · only you", { exact: true }).waitFor();
  const proposal = prepareGraphReplyUpdate({ store: f.store, token, binding, sourceId: f.sourceId,
    attemptId: f.recorded.plan.requestId, expectedRevision: 3, requestId: "acknowledged-update" });
  const apply = request => f.store.inbox.reply(token, { sourceId: f.sourceId, attemptId: proposal.attemptId, ...request }, binding);
  apply({ action: "reply.update.reserve", requestId: proposal.requestId, expectedRevision: 3, updateVersion: proposal.updateVersion });
  apply({ action: "reply.update.dispatch", requestId: "acknowledged-dispatch", updateId: proposal.requestId, expectedRevision: 0 });
  f.store.inbox.recordReplyUpdateAcknowledgment(token, { sourceId: f.sourceId, attemptId: proposal.attemptId, updateId: proposal.requestId,
    dispatchRequestId: "acknowledged-dispatch", requestId: "write-acknowledgment",
    response: { status: 200, method: "PATCH", idType: "immutable", connection: proposal.connection,
      message: { id: proposal.providerDraftId, changeKey: "acknowledged-version" } } }, binding);
  const inspect = ({ body = proposal.proposed.body, revision = "acknowledged-version", message: patch = {} } = {}) => {
    const e = proposal.proposed, address = emailAddress => ({ emailAddress });
    const message = { ...f.mail.raw.message, id: proposal.providerDraftId, changeKey: revision, isDraft: true, hasAttachments: false,
      from: address(e.from), sender: address(e.sender), replyTo: [], toRecipients: e.to.map(address), ccRecipients: e.cc.map(address),
      bccRecipients: e.bcc.map(address), subject: e.subject, body: { contentType: "text", content: body }, ...patch };
    return f.store.inbox.recordReplyUpdateInspection(token, {
      context: f.store.inbox.prepareReplyUpdateInspection(token, f.sourceId, proposal.requestId, binding), requestId: crypto.randomUUID(),
      response: { status: 200, connection: proposal.connection, message, options: { idType: "immutable",
        attachmentObservation: { messageId: message.id, messageRevision: message.changeKey, complete: true, items: [] } } }
    }, binding);
  };
  return { ...f, proposal, inspect };
}

for (const mobile of [false, true]) test(`reply comparison ${mobile ? "mobile" : "desktop"}: three versions, unsaved writing and no implicit changes`, { timeout: 35000 }, async t => {
  const f = await reviewFixture(t, mobile), p = f.page;
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-body").filter({ hasText: f.recorded.plan.expected.body }).waitFor();
  assert.equal(await p.locator("#inbox-reply-local").isVisible(), false);
  assert.equal(await p.locator("#inbox-reply-original").isVisible(), false); await p.locator("#inbox-reply-close").click();
  f.recorded.observe({ message: { cc: [{ name: "Reviewer", address: "reviewer@example.test" }], subject: "A shared first step" },
    body: { format: "text", content: "The mailbox version.\nSomeone suggested meeting on Friday." } });
  const local = "My unsaved alternative.\nLet’s pick one small thing to build together.\n\n<em>Keep this as text.</em>";
  await p.locator("#inbox-draft").fill(local); const before = auditRecovery(f.store);
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-local-body").filter({ hasText: "My unsaved alternative" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-local-body").textContent(), local);
  assert.match(await p.locator("#inbox-reply-local-state").textContent(), /unsaved/);
  assert.match(await p.locator("#inbox-reply-body").textContent(), /mailbox version/);
  assert.match(await p.locator("#inbox-reply-addresses").textContent(), /reviewer@example.test/);
  assert.equal(await p.locator("#inbox-reply-confirm").isEnabled(), false);
  assert.equal(await p.locator("#inbox-reply-local-body em").count(), 0);
  assert.equal(await p.locator("#inbox-reply-original").evaluate(node => node.open), false);
  await f.capture("comparison-" + (mobile ? "mobile" : "desktop"));
  const boxes = await p.locator("#inbox-reply-versions > section").evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; }));
  assert.equal(mobile ? boxes[1].y > boxes[0].y : boxes[1].x > boxes[0].x, true);
  await p.locator("#inbox-reply-original summary").click();
  assert.equal(await p.locator("#inbox-reply-original-body").textContent(), f.recorded.plan.expected.body);
  await f.capture("comparison-original-" + (mobile ? "mobile" : "desktop"));
  await p.locator("#inbox-reply-close").click();
  assert.equal(await p.locator("#inbox-draft").inputValue(), local); assert.deepEqual(auditRecovery(f.store), before);
  assert.equal(await p.locator("#inbox-draft").evaluate(node => node === document.activeElement), true);
  for (const id of ["inbox-reply-original-body", "inbox-reply-local-body"]) assert.equal(await p.locator("#" + id).textContent(), "");
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-local-body").filter({ hasText: "My unsaved alternative" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-original").evaluate(node => node.open), false);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test("reply comparison preserves a captured version when local writing changes, then refreshes on reopen", { timeout: 35000 }, async t => {
  const f = await reviewFixture(t), p = f.page;
  await p.locator("#inbox-draft").fill("First local edit"); await p.locator("#inbox-reply-open").click();
  await p.locator("#inbox-reply-local-body").filter({ hasText: "First local edit" }).waitFor();
  await p.locator("#inbox-draft").evaluate(node => { node.value = "Newer local edit"; node.dispatchEvent(new Event("input", { bubbles: true })); });
  await p.locator("#inbox-reply-dialog-status").filter({ hasText: "Reply changed" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-local-body").textContent(), "First local edit");
  assert.equal(await p.locator("#inbox-reply-confirm").isEnabled(), false);
  await p.locator("#inbox-reply-close").click(); await p.locator("#inbox-reply-open").click();
  await p.locator("#inbox-reply-local-body").filter({ hasText: "Newer local edit" }).waitFor();
  for (let n = 0; n < 3; n++) {
    await p.evaluate(() => { document.getElementById("inbox-reply-close").click(); document.getElementById("inbox-reply-open").click(); });
    await p.locator("#inbox-reply-local-body").filter({ hasText: "Newer local edit" }).waitFor();
  }
});

test("reply comparison clears already visible original and unsaved text when another tab signs out", { timeout: 35000 }, async t => {
  const f = await reviewFixture(t), p = f.page;
  await p.locator("#inbox-draft").fill("Only this account's unsaved writing"); await p.locator("#inbox-reply-open").click();
  await p.locator("#inbox-reply-local-body").filter({ hasText: "Only this account" }).waitFor();
  await p.locator("#inbox-reply-original summary").click();
  assert.equal(await p.locator("#inbox-reply-original-body").textContent(), f.recorded.plan.expected.body);
  const other = await p.context().newPage(); await other.goto(f.origin + "/?room=commons");
  await other.locator("#main").waitFor(); await other.locator("#signout-button").click(); await p.locator("#auth-panel").waitFor();
  assert.equal(await p.locator("#inbox-reply-dialog").isVisible(), false);
  for (const id of ["inbox-reply-local-body", "inbox-reply-original-body", "inbox-reply-body"])
    assert.equal(await p.locator("#" + id).textContent(), "");
});

test("reply comparison handles empty and long mobile drafts without changing saved text", { timeout: 35000 }, async t => {
  const f = await reviewFixture(t, true), p = f.page, before = auditRecovery(f.store);
  for (const local of ["", "A long unbroken word: " + "界🪷".repeat(800)]) {
    await p.locator("#inbox-draft").fill(local); await p.locator("#inbox-reply-open").click();
    await p.locator("#inbox-reply-local").waitFor();
    assert.equal(await p.locator("#inbox-reply-local-body").textContent(), local || "(Empty draft)");
    assert.equal(await p.locator("#inbox-reply-confirm").isVisible(), false);
    assert.equal(await p.locator("#inbox-reply-dialog").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await p.locator("#inbox-reply-close").click(); assert.equal(await p.locator("#inbox-draft").inputValue(), local);
  }
  assert.deepEqual(auditRecovery(f.store), before);
});

test("reply comparison shows pending update uncertainty without enabling review or repeating the update", { timeout: 35000 }, async t => {
  const f = await reviewFixture(t), p = f.page, token = f.slot.token, binding = f.session.sessionBinding;
  await p.locator("#inbox-draft").fill("Proposed mailbox update"); await p.locator("#inbox-save").click();
  await p.getByText("Saved · only you", { exact: true }).waitFor();
  const proposal = prepareGraphReplyUpdate({ store: f.store, token, binding, sourceId: f.sourceId,
    attemptId: f.recorded.plan.requestId, expectedRevision: 3, requestId: "comparison-update" });
  const apply = request => f.store.inbox.reply(token, { sourceId: f.sourceId, attemptId: f.recorded.plan.requestId, ...request }, binding);
  apply({ action: "reply.update.reserve", requestId: proposal.requestId, expectedRevision: 3, updateVersion: proposal.updateVersion });
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-dialog-status").filter({ hasText: "Update not started" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-confirm").isVisible(), false); await p.locator("#inbox-reply-close").click();
  apply({ action: "reply.update.dispatch", requestId: "comparison-dispatch", updateId: proposal.requestId, expectedRevision: 0 });
  const before = auditRecovery(f.store);
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-dialog-status").filter({ hasText: "Update unconfirmed" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-confirm").isVisible(), false); await f.capture("comparison-unknown");
  await p.locator("#inbox-reply-close").click(); await p.reload(); await p.locator("#inbox-reply-open").click();
  await p.locator("#inbox-reply-dialog-status").filter({ hasText: "Update unconfirmed" }).waitFor();
  assert.deepEqual(auditRecovery(f.store), before);
});

for (const mobile of [false, true]) test(`reply acknowledgment ${mobile ? "mobile" : "desktop"}: recovery does not imply content review or sending`, { timeout: 35000 }, async t => {
  const f = await updateFixture(t, mobile), p = f.page;
  const before = auditRecovery(f.store);
  await p.locator("#inbox-reply-open").click();
  await p.locator("#inbox-reply-dialog-status").filter({ hasText: "Update acknowledged · review pending" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-mailbox-label").textContent(), "Last checked draft");
  assert.equal(await p.locator("#inbox-reply-confirm").isVisible(), false);
  assert.equal(await p.locator("#inbox-reply-close").textContent(), "Keep writing");
  await f.capture("acknowledged-" + (mobile ? "mobile" : "desktop"));
  await p.locator("#inbox-reply-close").click(); await p.reload(); await p.locator("#inbox-reply-open").click();
  await p.locator("#inbox-reply-dialog-status").filter({ hasText: "Update acknowledged · review pending" }).waitFor();
  assert.deepEqual(auditRecovery(f.store), before);
});

for (const mobile of [false, true]) test(`updated reply review ${mobile ? "mobile" : "desktop"}: inspect, review, reload and unchanged private writing`, { timeout: 35000 }, async t => {
  const f = await updateFixture(t, mobile), p = f.page, token = f.slot.token, binding = f.session.sessionBinding;
  const parent = f.store.inbox.replyAttempts(token, f.sourceId, binding).attempts[0], local = f.store.inbox.read(token, f.sourceId, binding).draft;
  f.inspect(); await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-confirm:not([disabled])").waitFor();
  assert.equal(await p.locator("#inbox-reply-body").textContent(), local.body);
  assert.equal(await p.locator("#inbox-reply-original").getAttribute("open"), null);
  await f.capture("update-review-" + (mobile ? "mobile" : "desktop"));
  await p.locator("#inbox-reply-confirm").click(); await p.locator("#inbox-reply-status").filter({ hasText: "Reviewed · not sent" }).waitFor();
  assert.equal(f.store.inbox.replyUpdates(token, f.sourceId, binding).updates[0].status, "resolved");
  assert.deepEqual(f.store.inbox.replyAttempts(token, f.sourceId, binding).attempts[0], parent);
  assert.deepEqual(f.store.inbox.read(token, f.sourceId, binding).draft, local);
  await p.reload(); await p.locator("#inbox-reply-open").click();
  await p.locator("#inbox-reply-dialog-status").filter({ hasText: "Reviewed · not sent" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-confirm").isVisible(), false);
  await f.capture("update-reviewed-" + (mobile ? "mobile" : "desktop")); auditRecovery(f.store);
});

test("updated reply review preserves a differing local draft and exposes a different mailbox version", { timeout: 35000 }, async t => {
  const f = await updateFixture(t), p = f.page, token = f.slot.token, binding = f.session.sessionBinding;
  const local = f.store.inbox.read(token, f.sourceId, binding).draft;
  f.inspect({ body: "Monday works instead. Let’s keep it small.", revision: "different-mailbox-version",
    message: { ccRecipients: [{ emailAddress: { name: "Sam", address: "sam@example.test" } }] } });
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-confirm:not([disabled])").waitFor();
  await p.locator("#inbox-reply-dialog-status").filter({ hasText: "Different mailbox version" }).waitFor();
  assert.match(await p.locator("#inbox-reply-addresses").textContent(), /sam@example.test/);
  assert.equal(await p.locator("#inbox-reply-confirm").textContent(), "Review checked draft");
  await f.capture("update-review-different");
  await p.locator("#inbox-reply-confirm").click();
  await p.locator("#inbox-reply-status").filter({ hasText: "Mailbox reviewed · local draft differs" }).waitFor();
  assert.deepEqual(f.store.inbox.read(token, f.sourceId, binding).draft, local); auditRecovery(f.store);
});

test("updated reply review recovers a lost acknowledgment without another review or storing mail text", { timeout: 35000 }, async t => {
  const f = await updateFixture(t), p = f.page; f.inspect();
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-confirm:not([disabled])").waitFor();
  await p.route("**/api/inbox/review", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
  await p.locator("#inbox-reply-confirm").click(); await p.locator("#inbox-reply-open").filter({ hasText: "Check review" }).waitFor();
  const pending = await p.evaluate(() => sessionStorage.getItem("project-room:pending-reply-review:v1"));
  assert.match(pending, /reply.update.review/); assert.doesNotMatch(pending, /Friday works|example.test/);
  await p.reload(); await p.locator("#inbox-reply-open").filter({ hasText: "Check review" }).waitFor(); await p.locator("#inbox-reply-open").click();
  await p.locator("#inbox-reply-status").filter({ hasText: "Reviewed · not sent" }).waitFor();
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='reply.update.review'").get().n, 1);
  auditRecovery(f.store);
});

for (const mobile of [false, true]) test(`updated reply newer-read refresh ${mobile ? "mobile" : "desktop"}: preserve captured text, revoke review and reopen latest`, { timeout: 35000 }, async t => {
  const f = await updateFixture(t, mobile), p = f.page, token = f.slot.token, binding = f.session.sessionBinding;
  f.inspect(); await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-confirm:not([disabled])").waitFor();
  const captured = await p.locator("#inbox-reply-body").textContent();
  const child = f.store.inbox.replyUpdates(token, f.sourceId, binding).updates[0];
  f.recorded.observe({ body: { format: "text", content: "Tuesday instead. Keep my local draft separate." } });
  const before = auditRecovery(f.store);
  await p.evaluate(() => document.getElementById("inbox-refresh").click());
  await p.locator("#inbox-reply-status").filter({ hasText: "Sample update acknowledged · review pending" }).waitFor();
  await p.locator("#inbox-reply-dialog-status").filter({ hasText: "Reply changed or unavailable" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-body").textContent(), captured, "never replace text during a captured comparison");
  assert.equal(await p.locator("#inbox-reply-confirm").isEnabled(), false);
  let writes = 0; p.on("request", r => { if (new URL(r.url()).pathname === "/api/inbox/review") writes++; });
  await p.evaluate(() => document.getElementById("inbox-reply-confirm").dispatchEvent(new MouseEvent("click")));
  await f.capture("update-stale-open-" + (mobile ? "mobile" : "desktop"));
  await p.locator("#inbox-reply-close").click(); await p.locator("#inbox-reply-open").click();
  await p.locator("#inbox-reply-body").filter({ hasText: "Tuesday instead" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-confirm").isVisible(), false);
  assert.equal(await p.locator("#inbox-reply-local-body").textContent(), captured);
  await f.capture("update-latest-read-" + (mobile ? "mobile" : "desktop"));
  assert.equal(writes, 0); assert.deepEqual(auditRecovery(f.store), before);
  assert.deepEqual(f.store.inbox.replyUpdates(token, f.sourceId, binding).updates[0], child);
  await p.locator("#inbox-reply-close").click();
  f.inspect({ body: "Tuesday instead. Keep my local draft separate." });
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-confirm:not([disabled])").waitFor();
  await p.locator("#inbox-reply-confirm").click();
  await p.locator("#inbox-reply-status").filter({ hasText: "Mailbox reviewed · local draft differs" }).waitFor();
  assert.equal(await p.locator("#inbox-draft").inputValue(), captured); auditRecovery(f.store);
});

test("reviewed update becomes visibly out of date, and an unavailable read never resurrects old text", { timeout: 35000 }, async t => {
  const f = await updateFixture(t), p = f.page; f.inspect();
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-confirm:not([disabled])").waitFor();
  await p.locator("#inbox-reply-confirm").click();
  await p.locator("#inbox-reply-status").filter({ hasText: "Reviewed · not sent" }).waitFor();
  const local = await p.locator("#inbox-draft").inputValue();
  f.recorded.observe({ body: { format: "text", content: "A separate mailbox change." } });
  await p.locator("#inbox-reply-open").click();
  await p.locator("#inbox-reply-dialog-status").filter({ hasText: "Review out of date · not sent" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-body").textContent(), "A separate mailbox change.");
  assert.equal(await p.locator("#inbox-reply-confirm").isVisible(), false);
  await f.capture("update-review-outdated"); await p.locator("#inbox-reply-close").click();
  f.recorded.observe(null); const before = auditRecovery(f.store);
  await p.locator("#inbox-reply-open").click();
  await p.locator("#inbox-reply-dialog-status").filter({ hasText: "Draft unavailable · not sent" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-body").textContent(), "");
  assert.equal(await p.locator("#inbox-reply-confirm").isVisible(), false);
  await f.capture("update-review-unavailable");
  await p.locator("#inbox-reply-close").click(); await p.reload(); await p.locator("#inbox-reply-open").click();
  await p.locator("#inbox-reply-dialog-status").filter({ hasText: "Draft unavailable · not sent" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-body").textContent(), "");
  assert.equal(await p.locator("#inbox-draft").inputValue(), local); assert.deepEqual(auditRecovery(f.store), before);
});

test("reply comparison refresh revokes a captured review without changing the parent version", { timeout: 35000 }, async t => {
  const f = await reviewFixture(t), p = f.page, token = f.slot.token, binding = f.session.sessionBinding;
  // Outside editing makes an update possible without altering our saved draft.
  f.recorded.observe({ body: { format: "text", content: "Outside mailbox edit" } });
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-confirm:not([disabled])").waitFor();
  const parent = f.store.inbox.replyAttempts(token, f.sourceId, binding).attempts[0];
  const proposal = prepareGraphReplyUpdate({ store: f.store, token, binding, sourceId: f.sourceId,
    attemptId: parent.id, expectedRevision: parent.revision, requestId: "background-update" });
  f.store.inbox.reply(token, { action: "reply.update.reserve", requestId: proposal.requestId, sourceId: f.sourceId,
    attemptId: parent.id, expectedRevision: parent.revision, updateVersion: proposal.updateVersion }, binding);
  const before = auditRecovery(f.store);
  // Exercise the real refresh listener while the sheet retains its old preview.
  await p.evaluate(() => document.getElementById("inbox-refresh").click());
  await p.locator("#inbox-reply-status").filter({ hasText: "Sample update not started" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-confirm").isEnabled(), false);
  // Even a queued/programmatic click cannot send the now-obsolete review.
  let writes = 0; p.on("request", r => { if (new URL(r.url()).pathname === "/api/inbox/review") writes++; });
  await p.evaluate(() => document.getElementById("inbox-reply-confirm").dispatchEvent(new MouseEvent("click")));
  await p.locator("#inbox-reply-close").click();
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-dialog-status").filter({ hasText: "Update not started" }).waitFor();
  assert.equal(writes, 0); assert.deepEqual(auditRecovery(f.store), before);
  assert.equal(f.store.inbox.replyAttempts(token, f.sourceId, binding).attempts[0].revision, parent.revision);
});

for (const mobile of [false, true]) test(`provider draft review ${mobile ? "mobile" : "desktop"}: exact visible content, deliberate acknowledgment, reload and unchanged local draft`, { timeout: 35000 }, async t => {
  const f = await reviewFixture(t, mobile), p = f.page, before = f.store.inbox.read(f.slot.token, f.sourceId, f.session.sessionBinding).draft;
  f.recorded.observe({ message: { cc: [{ name: "CC", address: "cc@example.test" }], bcc: [{ name: "BCC", address: "bcc@example.test" }] },
    body: { format: "text", content: "A revised reply.\n\nLet’s meet on Friday and pick one small thing to build together." } });
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-confirm:not([disabled])").waitFor();
  assert.match(await p.locator("#inbox-reply-addresses").textContent(), /BCCbcc@example.test/);
  assert.match(await p.locator("#inbox-reply-body").textContent(), /A revised reply/);
  assert.equal(await p.locator("#inbox-reply-dialog img").count(), 0);
  await f.capture("provider-review-" + (mobile ? "mobile" : "desktop"));
  await p.locator("#inbox-reply-confirm").click(); await p.locator("#inbox-reply-dialog").waitFor({ state: "hidden" });
  await p.locator("#inbox-reply-status").filter({ hasText: "Reviewed · not sent" }).waitFor();
  await p.reload(); await p.locator("#inbox-reply-open").waitFor();
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-body").filter({ hasText: "A revised reply" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-confirm").isVisible(), false);
  await p.locator("#inbox-reply-close").click();
  assert.deepEqual(f.store.inbox.read(f.slot.token, f.sourceId, f.session.sessionBinding).draft, before);
  assert.equal(f.store.inbox.replyAttempts(f.slot.token, f.sourceId, f.session.sessionBinding).attempts[0].canSend, false);
});
test("provider review lost acknowledgment retains only operation metadata and retries once after reload", { timeout: 35000 }, async t => {
  const f = await reviewFixture(t), p = f.page;
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-confirm:not([disabled])").waitFor();
  await p.route("**/api/inbox/review", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
  await p.locator("#inbox-reply-confirm").click(); await p.locator("#inbox-reply-dialog").waitFor({ state: "hidden" });
  await p.locator("#inbox-reply-open").filter({ hasText: "Check review" }).waitFor();
  const stored = await p.evaluate(() => sessionStorage.getItem("project-room:pending-reply-review:v1"));
  assert.equal(stored.includes("That sounds good"), false); assert.equal(stored.includes("example.test"), false);
  await p.reload(); await p.locator("#inbox-reply-open").filter({ hasText: "Check review" }).waitFor();
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-status").filter({ hasText: "Reviewed · not sent" }).waitFor();
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='reply.review'").get().n, 1);
  assert.equal(await p.evaluate(() => sessionStorage.getItem("project-room:pending-reply-review:v1")), null);
});
test("provider changes while the sheet is open cannot be acknowledged under the old version", { timeout: 35000 }, async t => {
  const f = await reviewFixture(t), p = f.page;
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-confirm:not([disabled])").waitFor();
  f.recorded.observe({ body: { format: "text", content: "Mailbox changed while reading" } });
  await p.locator("#inbox-reply-confirm").click(); await p.locator("#inbox-reply-dialog").waitFor({ state: "hidden" });
  assert.equal(f.store.inbox.replyAttempts(f.slot.token, f.sourceId, f.session.sessionBinding).attempts[0].review, null);
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-body").filter({ hasText: "Mailbox changed while reading" }).waitFor();
  await p.locator("#inbox-reply-confirm:not([disabled])").waitFor();
  await f.capture("provider-review-changed"); await p.locator("#inbox-reply-close").click();
  await p.locator("#inbox-draft").fill("Different local draft");
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-body").filter({ hasText: "Mailbox changed while reading" }).waitFor();
  assert.equal(await p.locator("#inbox-reply-confirm").isEnabled(), false);
});
test("unavailable and HTML provider drafts never show an acknowledgment action", { timeout: 35000 }, async t => {
  const f = await reviewFixture(t), p = f.page;
  for (const observation of [null, { body: { format: "html", content: "<img src='https://example.invalid/private'>" } }]) {
    f.recorded.observe(observation); await p.locator("#inbox-reply-open").click();
    await p.locator("#inbox-reply-dialog-status").filter({ hasText: observation === null ? "Draft unavailable · not sent" : "Nothing sent" }).waitFor();
    assert.equal(await p.locator("#inbox-reply-confirm").isVisible(), false);
    assert.equal(await p.locator("#inbox-reply-dialog img").count(), 0);
    await p.locator("#inbox-reply-close").click();
  }
});
test("provider preview cannot repopulate private content after another tab changes account", { timeout: 35000 }, async t => {
  const f = await reviewFixture(t), p = f.page;
  let release, reached; const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { reached = resolve; });
  t.after(() => release());
  await p.route("**/reply-review?view=reply-review-v4", async route => { const response = await route.fetch(); reached(); await held; await route.fulfill({ response }); });
  await p.locator("#inbox-reply-open").click(); await started;
  const other = await p.context().newPage(); await other.goto(f.origin + "/?room=commons");
  await other.locator("#main").waitFor(); await other.locator("#signout-button").click(); await other.locator("#auth-panel").waitFor();
  const guest = f.store.accountForMember("commons", "guest");
  await other.locator("#access-key").fill(f.store.issueAccountAccessKey(guest.id)); await other.locator("#auth-form button").click();
  await other.locator("#main").waitFor(); await p.locator("#auth-panel").waitFor(); release(); await p.waitForLoadState("networkidle");
  assert.equal(await p.locator("#inbox-reply-dialog").isVisible(), false);
  assert.equal(await p.locator("#inbox-reply-body").textContent(), ""); assert.equal(await p.locator("#inbox-reply-addresses").textContent(), "");
  for (const id of ["inbox-reply-original-body", "inbox-reply-local-body"]) assert.equal(await p.locator("#" + id).textContent(), "");
  assert.equal(await p.evaluate(() => sessionStorage.getItem("project-room:pending-reply-review:v1")), null);
});
for (const updated of [false, true]) test(`two browser tabs reviewing the same ${updated ? "updated" : "original"} version record one acknowledgment`, { timeout: 35000 }, async t => {
  const f = await (updated ? updateFixture(t) : reviewFixture(t)), p = f.page, other = await p.context().newPage();
  if (updated) f.inspect();
  await other.goto(f.origin + "/?account=1#pr-view/inbox");
  await other.locator(`[data-source-id="${f.sourceId}"]`).click(); await other.locator("#inbox-reply-open").waitFor();
  for (const page of [p, other]) { await page.locator("#inbox-reply-open").click(); await page.locator("#inbox-reply-confirm:not([disabled])").waitFor(); }
  await p.locator("#inbox-reply-confirm").click(); await p.locator("#inbox-reply-dialog").waitFor({ state: "hidden" });
  await other.locator("#inbox-reply-confirm").click(); await other.locator("#inbox-reply-dialog").waitFor({ state: "hidden" });
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM private_inbox_commands WHERE json_extract(request_json,'$.action')=?").get(updated ? "reply.update.review" : "reply.review").n, 1);
  await other.locator("#inbox-reply-open").click(); await other.locator("#inbox-reply-dialog-status").filter({ hasText: "Reviewed · not sent" }).waitFor();
  assert.equal(await other.locator("#inbox-reply-confirm").isVisible(), false);
});
test("opt-in sample mailbox review is usable from account Inbox without entering a room", { timeout: 35000 }, async t => {
  const sample = await createInboxSandbox({ includeEmailReview: true }), browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await sample.close(); rmSync(sample.directory, { recursive: true, force: true }); });
  const page = await browser.newPage(); page.setDefaultTimeout(9000);
  await page.goto(sample.accountUrl); await page.locator("#access-key").fill(sample.accountKey); await page.locator("#auth-form button").click();
  await page.locator("#inbox-list").getByText("A small collaboration", { exact: true }).click();
  await page.locator("#inbox-reply-open").click(); await page.locator("#inbox-reply-confirm:not([disabled])").waitFor();
  await page.locator("#inbox-reply-confirm").click(); await page.locator("#inbox-reply-status").filter({ hasText: "Reviewed · not sent" }).waitFor();
  assert.equal(await page.locator("#main").isVisible(), false); assert.equal(sample.provider.submits, 0);
});
async function selectExcerpt(page, value) {
  const field = page.locator("#inbox-excerpt-text"); await field.focus();
  await field.press("ControlOrMeta+A"); await field.press("ArrowLeft");
  await page.keyboard.down("Shift");
  for (const point of value) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await page.locator("#inbox-share-confirm:not([disabled])").waitFor();
}
for (const mobile of [false, true]) test(`late share refresh respects newer Inbox navigation ${mobile ? "mobile" : "desktop"}`, { timeout: 30000 }, async t => {
  const f = await setup(t, mobile), p = f.page;
  await f.inbox(); await f.pick("note");
  await p.locator("#inbox-ask").click(); await p.locator("#inbox-share-paragraphs input").first().check();
  let release, reached;
  const held = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { reached = resolve; });
  t.after(() => release());
  await p.route("**/api/rooms/commons", async route => {
    const response = await route.fetch(); reached(); await held; await route.fulfill({ response });
  });
  await p.locator("#inbox-share-confirm").click(); await started;
  await p.locator("#inbox-share-dialog").waitFor({ state: "hidden" });
  await f.inbox(); await f.pick("note");
  // A saved share must not keep later shares locked behind a slow room refresh.
  await p.locator("#inbox-ask").click(); await p.locator("#inbox-share-paragraphs input").first().check();
  await p.locator("#inbox-share-confirm").click(); await p.locator("#inbox-share-dialog").waitFor({ state: "hidden" });
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='source.share'").get().n, 2);
  await f.inbox(); await f.pick("note");
  const row = f.store.db.prepare("SELECT receipt_json FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='source.share' ORDER BY sequence DESC LIMIT 1").get();
  const messageId = JSON.parse(row.receipt_json).messageId;
  release();
  await p.locator('[data-message-record-id="' + messageId + '"]').waitFor({ state: "attached" });
  await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await p.locator("#inbox-panel").isVisible(), true);
  assert.equal(await p.locator("#nav-inbox").getAttribute("aria-current"), "page");
  await f.capture("late-share-" + (mobile ? "mobile" : "desktop"));
});
for (const mobile of [false, true]) test(`email collaboration ${mobile ? "mobile" : "desktop"}: selected text becomes room work, a private draft and a reviewed sample reply`, { timeout: 45000 }, async t => {
  const f = await setup(t, mobile, true), p = f.page, mail = seedEmail(f), excerpt = "A warmer reply 🪷";
  mail.raw.message.body.content = excerpt + "\r\n\r\nPrivate budget: 4200";
  const id = mail.importMessage(); await f.inbox(); await f.pick(id);
  await p.locator("#inbox-draft").fill("Keep my private draft"); await p.locator("#inbox-save").click(); await p.getByText("Saved · only you", { exact: true }).waitFor();
  await p.locator("#inbox-ask").click(); await p.locator("#inbox-excerpt-text").waitFor();
  assert.equal(await p.locator("#inbox-share-confirm").isEnabled(), false);
  await p.locator("#inbox-excerpt-text").focus(); await p.keyboard.type("Do not rewrite the source");
  assert.equal(await p.locator("#inbox-excerpt-text").inputValue(), mail.raw.message.body.content.replace(/\r\n?/g, "\n"));
  assert.doesNotMatch(await p.locator("#inbox-share-dialog").textContent(), /observer@example.test|brief.txt/);
  await selectExcerpt(p, excerpt);
  assert.equal(await p.locator("#inbox-excerpt-preview").textContent(), "Shared email excerpt\n\n" + excerpt);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.capture("email-excerpt-" + (mobile ? "mobile" : "desktop"));
  await p.locator("#inbox-share-confirm").click(); await p.locator("#inbox-share-dialog").waitFor({ state: "hidden" });
  const record = f.store.db.prepare("SELECT receipt_json FROM private_inbox_commands WHERE json_extract(request_json,'$.action')='source.excerpt'").get();
  const shared = { receipt: JSON.parse(record.receipt_json) }, posted = f.store.room("commons").state.messages.find(m => m.id === shared.receipt.messageId);
  assert.equal(posted.body, "Shared email excerpt\n\n" + excerpt); assert.equal(JSON.stringify(posted).includes("4200"), false);
  const work = prepareInboxResult(f, f.slot.token, f.session.sessionBinding, { sourceId: id, shareReceipt: shared, ready: false });
  await f.inbox(); await f.pick(id); await p.getByText("Work in progress", { exact: true }).waitFor();
  work.complete(); work.review(); work.decide();
  await p.locator("#nav-rooms").click(); await f.inbox();
  await p.locator("[data-inbox-result]").click(); await p.locator("#inbox-result-use:not([disabled])").waitFor();
  assert.equal(await p.locator("#inbox-replaced-draft").textContent(), "Keep my private draft");
  await p.locator("#inbox-result-use").click(); await p.getByText("Saved · only you", { exact: true }).waitFor();
  assert.equal(await p.locator("#inbox-draft").inputValue(), work.body);
  assert.equal(f.store.inbox.read(f.slot.token, id, f.session.sessionBinding).draft.origin.unchanged, true);
  assert.equal(f.provider.submits, 0); assert.equal(await p.locator("#inbox-send-panel").isVisible(), false);
  await f.capture("email-return-" + (mobile ? "mobile" : "desktop"));
  seedRecordedReply({ store: f.store, token: f.slot.token, binding: f.session.sessionBinding, sourceId: id });
  await p.reload(); await p.locator("#inbox-reader").waitFor();
  assert.equal(await p.locator("#inbox-draft").inputValue(), work.body);
  await p.locator("#inbox-reply-open").click(); await p.locator("#inbox-reply-confirm:not([disabled])").waitFor();
  assert.equal(await p.locator("#inbox-reply-body").textContent(), work.body);
  await f.capture("email-room-provider-review-" + (mobile ? "mobile" : "desktop"));
  await p.locator("#inbox-reply-confirm").click(); await p.locator("#inbox-reply-status").filter({ hasText: "Reviewed · not sent" }).waitFor();
  assert.equal(f.store.inbox.read(f.slot.token, id, f.session.sessionBinding).draft.origin.unchanged, true);
  assert.equal(f.provider.submits, 0);
});
test("email excerpt lost acknowledgement retries the original offsets after reload and a source change", { timeout: 40000 }, async t => {
  const f = await setup(t), p = f.page, mail = seedEmail(f), excerpt = "Share just this";
  mail.raw.message.body.content = excerpt + "\nPrivate rest"; const id = mail.importMessage();
  await f.inbox(); await f.pick(id); await p.locator("#inbox-ask").click(); await p.locator("#inbox-excerpt-text").waitFor();
  await selectExcerpt(p, excerpt); const requests = [];
  await p.route("**/api/inbox/commands", async route => {
    const body = route.request().postDataJSON();
    if (body.action !== "source.excerpt") return route.continue();
    requests.push(body); const result = await route.fetch();
    if (requests.length === 1) return route.abort("failed"); return route.fulfill({ response: result });
  });
  await p.locator("#inbox-share-confirm").click(); await p.getByText("Share unconfirmed. Retry the original selection.", { exact: true }).waitFor();
  const retained = await p.evaluate(() => sessionStorage.getItem("project-room:pending-private-share:v1"));
  assert.equal(retained.includes(excerpt), false); assert.equal(retained.includes("Private rest"), false);
  mail.raw.message.body = { contentType: "html", content: "<p>Changed private source</p>" }; mail.importMessage();
  await p.reload(); await p.locator("#inbox-reader").waitFor(); await p.locator("#inbox-ask").click();
  await p.getByRole("button", { name: "Confirm share", exact: true }).click();
  await p.locator("#inbox-share-dialog").waitFor({ state: "hidden" });
  assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]);
  assert.equal(f.store.room("commons").state.messages.filter(m => m.body === "Shared email excerpt\n\n" + excerpt).length, 1);
  assert.equal(await p.evaluate(() => sessionStorage.getItem("project-room:pending-private-share:v1")), null);
});
test("email excerpt changed source requires a fresh selection and retains the private draft", { timeout: 35000 }, async t => {
  const f = await setup(t), p = f.page, mail = seedEmail(f);
  mail.raw.message.body.content = "Original line\nPrivate rest"; const id = mail.importMessage();
  await f.inbox(); await f.pick(id); await p.locator("#inbox-draft").fill("My unfinished private answer");
  await p.locator("#inbox-ask").click(); await p.locator("#inbox-excerpt-text").waitFor(); await selectExcerpt(p, "Original line");
  const before = f.store.room("commons").sequence;
  mail.raw.message.body.content = "Different line\nPrivate rest"; mail.importMessage();
  await p.locator("#inbox-share-confirm").click(); await p.getByText("Source or audience changed. Close and review again.", { exact: true }).waitFor();
  assert.equal(f.store.room("commons").sequence, before);
  await p.locator("#inbox-share-close").click(); assert.equal(await p.locator("#inbox-draft").inputValue(), "My unfinished private answer");
  await p.locator("#inbox-ask").click(); await p.locator("#inbox-excerpt-text").waitFor();
  assert.equal(await p.locator("#inbox-share-confirm").isEnabled(), false);
  assert.equal(await p.locator("#inbox-excerpt-text").inputValue(), mail.raw.message.body.content);
  await selectExcerpt(p, "Different line"); await p.locator("#inbox-share-confirm").click(); await p.locator("#inbox-share-dialog").waitFor({ state: "hidden" });
  assert.equal(f.store.room("commons").state.messages.filter(m => m.body === "Shared email excerpt\n\nDifferent line").length, 1);
});
for (const mobile of [false, true]) test(`email reader ${mobile ? "mobile" : "desktop"}: inert text, private drafts and current disconnected state`, { timeout: 35000 }, async t => {
  const f = await setup(t, mobile, true), p = f.page, mail = seedEmail(f), before = f.store.room("commons");
  mail.raw.message.body.content = '<img src="https://example.invalid/tracker">\n\nCould we make this simpler?';
  const id = mail.importMessage(); await f.inbox(); await f.pick(id);
  assert.equal(await p.locator("#inbox-source-label").textContent(), "Sample email · only you");
  assert.equal(await p.locator("#inbox-source-body").textContent(), mail.raw.message.body.content);
  assert.equal(await p.locator("#inbox-source-body img").count(), 0);
  assert.equal(await p.locator("#inbox-ask").isVisible(), true);
  assert.equal(await p.locator("#inbox-send-panel").isVisible(), false);
  await p.locator("#inbox-email-details summary").click();
  assert.match(await p.locator("#inbox-email-metadata").textContent(), /observer@example.test/);
  assert.match(await p.locator("#inbox-email-metadata").textContent(), /files unavailable/);
  await p.locator("#inbox-email-details summary").click();
  await p.locator("#inbox-draft").fill("A draft to keep 🪷"); await p.locator("#inbox-save").click();
  await p.getByText("Saved · only you", { exact: true }).waitFor();
  await f.capture("email-reader-" + (mobile ? "mobile" : "desktop"));
  await p.reload(); await p.locator("#nav-inbox").waitFor(); await f.inbox(); await f.pick(id);
  assert.equal(await p.locator("#inbox-draft").inputValue(), "A draft to keep 🪷");
  mail.disconnect();
  if (mobile) await p.locator("#inbox-back").click();
  await p.locator("#inbox-refresh").click();
  if (mobile) await f.pick(id);
  await p.getByText("Disconnected · saved copy", { exact: true }).waitFor();
  // A connection-only change is not a source or draft conflict.
  assert.equal(await p.locator("#inbox-conflict").isVisible(), false);
  await p.getByText("Saved · only you", { exact: true }).waitFor();
  assert.equal(await p.locator("#inbox-draft").inputValue(), "A draft to keep 🪷");
  assert.equal(f.store.inbox.read(f.slot.token, id, f.session.sessionBinding).draft.revision, 1);
  assert.deepEqual(f.store.room("commons"), before); assert.equal(f.provider.submits, 0);
  await f.capture("email-disconnected-" + (mobile ? "mobile" : "desktop"));
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await f.pick("note"); assert.equal(await p.locator("#inbox-ask").isVisible(), true);
  assert.equal(await p.locator("#inbox-email-details").isVisible(), false);
});
test("email HTML is explicitly unavailable and never fetched or injected into the reader", { timeout: 35000 }, async t => {
  const f = await setup(t), p = f.page, mail = seedEmail(f);
  mail.raw.message.body = { contentType: "html", content: '<img src="https://example.invalid/remote"><script>window.untrustedMail=true</script>' };
  const id = mail.importMessage(); await f.inbox(); await f.pick(id);
  await p.getByText("HTML preview unavailable.", { exact: true }).waitFor();
  assert.equal(await p.locator("#inbox-source-body").textContent(), "");
  assert.equal(await p.evaluate(() => window.untrustedMail), undefined);
  await p.locator("#inbox-draft").fill("Notes kept privately"); await p.locator("#inbox-save").click();
  await p.getByText("Saved · only you", { exact: true }).waitFor();
  await f.capture("email-html-unavailable");
});
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
  // Public IDs can legitimately contain a short number from an unshared paragraph.
  // Check exact private content below, not coincidental identifier substrings.
  f.store.command(f.keys.owner, "commons", { id: "public-reference-4200", type: "message.posted",
    data: { messageId: "public-reference-4200", body: "An ordinary public reference." } });
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
  assert.equal(snapshot.includes("public-reference-4200"), true);
  for (const privateText of ["Private budget: 4200.", "maya@example.test", "A warm hello"])
    assert.equal(snapshot.includes(privateText), false, `Unshared private content appeared: ${privateText}`);
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
  await p.route("**/api/inbox/sources/held?view=email-excerpt-v1", async route => { const response = await route.fetch(); reached(); await held; await route.fulfill({ response }); });
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
