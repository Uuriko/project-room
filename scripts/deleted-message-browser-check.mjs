// Deleted-message rendering (wave finding fix): message.deleted tombstones the
// projection (body=null, deletedAt). Rendering must honor the tombstone - no
// null-body crashes in reply previews, search, request or decision labels, and
// no body-dependent actions on a deleted message. The work-card drafts list is
// covered too: a deleted proposal draft must not count toward "Drafts (n)",
// must not be excerpted, and must never make the room unopenable
// (bug sweep 2026-10-16, CLIENT-CORE Finding 1). Disposable rooms only.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createAcceptanceFixture } from "./acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { signInFixture } from "./auth-signin.mjs";
import { openSearch } from "./room-chrome.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function setup(t, seedRoom) {
  const f = createAcceptanceFixture({ managedProducer: false });
  if (seedRoom) seedRoom(f);
  const server = createRoomServer({ store: f.store, streamInterval: 40 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.ROOM_TEST_CHROMIUM_PATH ? { executablePath: process.env.ROOM_TEST_CHROMIUM_PATH } : {}) });
  t.after(async () => {
    await browser.close(); server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" }), errors = [], outside = [];
  page.setDefaultTimeout(8000); page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { outside.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.goto(origin);
  await page.locator("#auth-panel").waitFor({ state: "visible" });
  await signInFixture(page, f.keys.owner); await page.locator("#main").waitFor({ state: "visible" });
  t.after(() => { assert.deepEqual(errors, [], "no page errors"); assert.deepEqual(outside, []); });
  return { ...f, page };
}

async function post(page, body) {
  await page.locator("#message-input").fill(body);
  await page.locator("#message-form button[type=submit]").click();
  await page.locator("#message-list .message-body", { hasText: body.slice(0, 40) }).first().waitFor({ state: "visible" });
}

test("deleted messages render a tombstone, never crash, and leave search", { timeout: 60000 }, async t => {
  const { page, store, keys } = await setup(t);

  await post(page, "orchids parent note");
  // Reply enters the thread; the composer targets the thread root implicitly.
  await page.locator("#message-list .message", { hasText: "orchids parent note" }).getByRole("button", { name: "Reply", exact: true }).click();
  await page.locator("#thread-bar").waitFor({ state: "visible" });
  await post(page, "reply about dahlias");
  // A nested reply keeps a visible .reply-preview of its parent inside the thread.
  await page.locator("#message-list .message", { hasText: "reply about dahlias" }).getByRole("button", { name: "Reply", exact: true }).click();
  await page.locator("#reply-bar").waitFor({ state: "visible" });
  await post(page, "cactus follow-up");

  // Delete the middle message through the command surface (agents/API can delete; the UI cannot).
  const target = store.room("commons").state.messages.find(m => m.body === "reply about dahlias");
  assert.ok(target, "reply message in projection");
  store.command(keys.owner, "commons", { id: randomUUID(), type: "message.deleted",
    data: { messageId: target.id, expectedMessageRevision: target.revision ?? 0, reason: "cleanup" } });

  // The deleted message renders a tombstone with no body-dependent actions.
  const deleted = page.locator("#message-list .message", { has: page.locator(".message-tombstone") });
  await deleted.waitFor({ state: "visible" });
  assert.equal(await deleted.locator(".message-tombstone").textContent(), "Message deleted");
  assert.equal(await deleted.locator(".message-tombstone").evaluate(node => getComputedStyle(node).fontStyle), "italic");
  for (const action of ["work", "decide", "result"])
    assert.equal(await deleted.locator(`[data-message-action="${action}"]`).count(), 0, `no ${action} action on a deleted message`);
  assert.equal(await deleted.getByRole("button", { name: "Reply", exact: true }).count(), 1, "reply stays available");

  // The nested reply's preview names the tombstone instead of slicing a null body.
  const followup = page.locator("#message-list .message", { hasText: "cactus follow-up" });
  await followup.locator(".reply-preview", { hasText: "Message deleted" }).waitFor({ state: "visible" });

  // Replying to the deleted message labels the target without slicing its body.
  await deleted.getByRole("button", { name: "Reply", exact: true }).click();
  await page.locator("#reply-bar").waitFor({ state: "visible" });
  assert.ok((await page.locator("#reply-context").textContent()).includes("Message deleted"));

  // Back in the room, search no longer touches deleted bodies and still finds live messages.
  await page.locator("#thread-back").click();
  await page.locator("#thread-bar").waitFor({ state: "hidden" });
  await openSearch(page);
  await page.locator("#message-search").fill("dahlias");
  await page.locator("#search-count", { hasText: "0 matches" }).waitFor({ state: "visible" });
  await page.locator("#message-search").fill("cactus");
  await page.locator("#search-count", { hasText: "1 match" }).waitFor({ state: "visible" });
  await page.locator("#message-search").fill("orchids");
  await page.locator("#search-count", { hasText: "1 match" }).waitFor({ state: "visible" });
});

test("a deleted proposal draft does not poison the work card or lock the room", { timeout: 60000 }, async t => {
  const { page } = await setup(t, ({ store, keys }) => {
    const cmd = (type, data) => store.command(keys.owner, "commons", { id: randomUUID(), type, data });
    cmd(T.WORK_PROPOSED, { workItemId: "w-draft-check", title: "Draft deletion check",
      definitionOfDone: "Room opens with the live drafts listed", accountableMemberId: "owner", mode: "read" });
    const { revision } = store.room("commons").state.workItems["w-draft-check"];
    const packetId = randomUUID();
    for (const [id, body] of [["check-draft-1", "alpha draft proposal text"],
        ["check-draft-2", "bravo draft proposal text"], ["check-draft-3", "charlie draft proposal text"]])
      cmd(T.MESSAGE_POSTED, { messageId: id, body, workItemId: "w-draft-check", packetId, basisRevision: revision });
    // Delete one of three drafts through the command surface (agents/API can delete; the UI cannot).
    const target = store.room("commons").state.messages.find(m => m.id === "check-draft-1");
    cmd(T.MESSAGE_DELETED, { messageId: target.id, expectedMessageRevision: target.revision ?? 0, reason: "superseded" });
  });

  // Sign-in (inside setup) only reaches #main if the first snapshot renders;
  // the deleted draft's null body used to throw inside the work card and
  // bounce the user back to the sign-in panel for good.
  const card = page.locator("#message-list .work-card[data-work-record-id=\"w-draft-check\"]");
  await card.waitFor({ state: "visible" });

  // Only the two live drafts count toward "Drafts (n)" and are excerpted;
  // the deleted draft is neither counted nor linked from the card.
  await card.locator(".work-drafts summary", { hasText: "Drafts (2)" }).waitFor({ state: "visible" });
  const linked = await card.locator(".work-drafts [data-open-message]").evaluateAll(
    nodes => nodes.map(node => node.getAttribute("data-open-message")).sort());
  assert.deepEqual(linked, ["check-draft-2", "check-draft-3"]);
  const draftsText = await card.locator(".work-drafts").textContent();
  assert.ok(draftsText.includes("bravo draft proposal text"), "live draft 2 excerpt renders");
  assert.ok(draftsText.includes("charlie draft proposal text"), "live draft 3 excerpt renders");
  assert.ok(!draftsText.includes("alpha draft proposal text"), "deleted draft is not excerpted");
});
